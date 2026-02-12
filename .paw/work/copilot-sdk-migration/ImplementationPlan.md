# Copilot SDK Migration — Implementation Plan

## Overview

Replace the Claude Agent SDK runtime with the GitHub Copilot SDK inside NanoClaw's container. The migration swaps the in-process `query()` async iterable model for a `CopilotClient` → `CopilotSession` event-driven model while preserving the container isolation, IPC system, MCP server, and host-side stdout marker protocol.

## Current State Analysis

The agent-runner (`container/agent-runner/src/index.ts`) is a ~530-line Node.js script that:
1. Reads `ContainerInput` JSON from stdin (prompt, sessionId, groupFolder, etc.)
2. Calls Claude SDK's `query()` with a push-based `MessageStream`, capturing results via `message.type` checks
3. Polls the IPC input directory for follow-up messages during active queries
4. Loops: run query → wait for IPC → run next query → repeat until `_close` sentinel
5. Archives conversations via a `PreCompact` hook

The Dockerfile installs `@anthropic-ai/claude-code` globally (provides the CLI + tools) and `@anthropic-ai/claude-agent-sdk` (provides `query()`). The host-side container-runner creates a `.claude/` session directory with Claude-specific settings and filters `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` env vars.

Key finding from code research: The Copilot SDK requires Node.js ≥ 24 (current Dockerfile uses node:22-slim). The SDK bundles the Copilot CLI via its `@github/copilot` dependency, so no separate CLI install is needed.

## Desired End State

The agent-runner uses `CopilotClient` and `CopilotSession` from `@github/copilot-sdk` to process messages. The container runs Node.js 24 with the Copilot CLI bundled via the SDK. Authentication supports GitHub tokens by default and BYOK as fallback. Session persistence uses `resumeSession()`. The MCP server, IPC system, and stdout marker protocol are unchanged. The host-side container-runner passes appropriate auth environment variables and manages a Copilot-compatible session directory.

**Verification approach**: Build the container, run the agent with a test prompt, verify response is returned via stdout markers, verify session resumes on second invocation, verify MCP tools (send_message) function.

## What We're NOT Doing

- Changing the WhatsApp channel, router, IPC system, or task scheduler
- Modifying `ipc-mcp-stdio.ts` (MCP server tool implementations)
- Adding new tools or capabilities not present in the current system
- Migrating existing Claude session data (old sessions are abandoned)
- Ensuring agent teams / subagent orchestration parity
- Changing the host-side `src/index.ts` orchestrator (ContainerOutput protocol unchanged)

## Phase Status

- [ ] **Phase 1: Container Dependencies & Dockerfile** — Update base image to Node 24, swap SDK packages, remove claude-code
- [ ] **Phase 2: Agent Runner Rewrite** — Replace query() with CopilotClient/CopilotSession, map all options
- [ ] **Phase 3: Host-Side Configuration** — Update env var filtering, session directory, settings
- [ ] **Phase 4: Documentation** — Technical reference and project doc updates

## Phase Candidates
<!-- None identified yet — will surface during implementation if needed -->

---

## Phase 1: Container Dependencies & Dockerfile

### Changes Required

- **`container/agent-runner/package.json`**:
  - Remove `@anthropic-ai/claude-agent-sdk` from dependencies
  - Add `@github/copilot-sdk` (latest)
  - Keep `@modelcontextprotocol/sdk`, `cron-parser`, `zod` unchanged

- **`container/Dockerfile`**:
  - Change base image from `node:22-slim` to `node:24-slim` (Copilot SDK requires Node ≥ 24)
  - Remove `npm install -g @anthropic-ai/claude-code` from the global install line (line 33)
  - Keep `agent-browser` global install
  - The Copilot CLI is bundled with `@github/copilot-sdk` via its `@github/copilot` dependency — no separate global install needed

### Success Criteria

#### Automated Verification
- [ ] `docker build` / `container build` completes without errors
- [ ] `npm ls @github/copilot-sdk` inside container shows the package installed
- [ ] `node -e "require('@github/copilot-sdk')"` succeeds inside container

#### Manual Verification
- [ ] Container image size is within 2x of current baseline
- [ ] `copilot --version` is accessible inside the container (via SDK's bundled CLI)

---

## Phase 2: Agent Runner Rewrite

This is the core phase — replacing the Claude SDK `query()` call with the Copilot SDK's `CopilotClient`/`CopilotSession` API.

### Changes Required

- **`container/agent-runner/src/index.ts`**: Full rewrite of the agent runtime logic while preserving:
  - `ContainerInput`/`ContainerOutput` interfaces (unchanged)
  - `writeOutput()` protocol (unchanged)
  - `readStdin()` helper (unchanged)
  - IPC functions: `drainIpcInput()`, `shouldClose()`, `waitForIpcMessage()` (unchanged)
  - Transcript archival helpers: `parseTranscript()`, `formatTranscriptMarkdown()`, `sanitizeFilename()`, `generateFallbackName()`, `getSessionSummary()` (unchanged)

  **Replace**:
  - `import { query, ... } from '@anthropic-ai/claude-agent-sdk'` → `import { CopilotClient } from '@github/copilot-sdk'`
  - The `MessageStream` class — no longer needed (Copilot SDK uses `session.send()` for each message)
  - The `SDKUserMessage` interface — no longer needed
  - The `runQuery()` function — replace with a Copilot SDK session-based equivalent

  **New architecture for `main()`**:
  1. Read stdin → parse `ContainerInput`
  2. Create `CopilotClient` with appropriate options (working directory, log level)
  3. Start the client (`client.start()`)
  4. Build `SessionConfig` / `ResumeSessionConfig`:
     - `workingDirectory`: `/workspace/group`
     - `systemMessage`: `{ content: globalClaudeMd }` if global CLAUDE.md exists
     - `mcpServers`: nanoclaw MCP server with `tools: ['*']`
     - `onPermissionRequest`: auto-approve all (`() => ({ kind: 'approved' })`)
     - `hooks.onSessionEnd`: transcript archival logic (adapted from `createPreCompactHook`)
     - `infiniteSessions`: enabled (default)
     - BYOK `provider` config if BYOK env vars are present
  5. Create or resume session:
     - If `containerInput.sessionId` exists → `client.resumeSession(sessionId, config)` with try/catch fallback to `createSession`
     - Otherwise → `client.createSession(config)`
  6. Capture `session.sessionId` as `newSessionId`
  7. Register event listeners on session:
     - `assistant.message` → call `writeOutput()` with the text content and `newSessionId`
  8. Main loop:
     - Build initial prompt (same as current: prepend scheduled task prefix, drain pending IPC)
     - `session.sendAndWait({ prompt }, timeout)` — use a generous timeout matching `CONTAINER_TIMEOUT`
     - Start IPC polling during the send: poll for `_close` → `session.abort()`, poll for messages → `session.send({ prompt: text })`
     - After idle: `writeOutput()` session update marker
     - Wait for next IPC message or `_close`
     - Loop with next prompt
  9. Cleanup: `session.destroy()`, `client.stop()`

  **IPC integration during active session**: Instead of pushing to a `MessageStream`, the IPC poller calls `session.send({ prompt: text })` for follow-up messages. For `_close` sentinel, call `session.abort()` then break.

  **Transcript archival**: Adapt `createPreCompactHook` logic to work with `onSessionEnd` hook. The hook receives `finalMessage` and `reason`. Use `session.getMessages()` to retrieve conversation history for archival, or listen for `session.compaction_complete` events which provide `summaryContent`.

### Success Criteria

#### Automated Verification
- [ ] TypeScript compiles: `npx tsc --noEmit` in agent-runner directory
- [ ] Container builds successfully with the new agent-runner

#### Manual Verification
- [ ] Agent responds to a test prompt sent via stdin JSON (manual container run)
- [ ] Session ID is returned in the ContainerOutput
- [ ] Resuming with a previous session ID maintains conversation context
- [ ] IPC follow-up messages are delivered to the active session
- [ ] `_close` sentinel causes the agent to exit cleanly
- [ ] MCP tools (send_message via ipc-mcp-stdio) are available and functional
- [ ] Transcript archival creates a markdown file in `/workspace/group/conversations/`

---

## Phase 3: Host-Side Configuration

### Changes Required

- **`src/container-runner.ts`**:

  **Environment variable filtering** (line 167): Replace allowed vars:
  - Remove: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`
  - Add: `GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY` stays in the list (used for BYOK mode)

  **Session directory mount** (lines 100-146):
  - Change directory name from `.claude` to `.copilot` in the session path: `path.join(DATA_DIR, 'sessions', group.folder, '.copilot')`
  - Change container mount target from `/home/node/.claude` to `/home/node/.copilot`
  - Replace `settings.json` creation: Remove Claude Code–specific env vars (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`). Write Copilot-appropriate settings if needed, or skip settings.json creation entirely if the Copilot CLI doesn't use this pattern.

  **Skills sync** (lines 127-141):
  - Evaluate whether Copilot CLI uses a `skills/` directory inside its config dir. If not, adapt the sync target or configure skills via `SessionConfig.skillDirectories` in the agent-runner instead.

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build` in project root
- [ ] Existing tests pass: `npm test` (if any host-side tests exist)

#### Manual Verification
- [ ] `.env` with `GITHUB_TOKEN` is correctly filtered into the container
- [ ] `.env` with `ANTHROPIC_API_KEY` (BYOK) is correctly filtered into the container
- [ ] Session directory is created at `data/sessions/{group}/.copilot/`
- [ ] Container starts and authenticates with provided credentials

---

## Phase 4: Documentation

### Changes Required

- **`.paw/work/copilot-sdk-migration/Docs.md`**: Technical reference covering:
  - Architecture change summary (query() → CopilotClient/CopilotSession)
  - Auth configuration (GitHub token vs BYOK)
  - Session management changes
  - Environment variable reference
  - Verification steps

- **Project documentation updates**:
  - **`CLAUDE.md`**: Update container build section (node:24, copilot-sdk), update env var references
  - **`README.md`**: Update any references to Claude SDK or Anthropic-specific setup if present
  - **`docs/REQUIREMENTS.md`**: Update architecture decisions if it references Claude SDK

### Success Criteria

- [ ] `Docs.md` accurately describes the implementation
- [ ] Project docs reference correct SDK, env vars, and setup steps
- [ ] No stale references to `@anthropic-ai/claude-agent-sdk` or `@anthropic-ai/claude-code` remain in documentation

---

## References

- Spec: `.paw/work/copilot-sdk-migration/Spec.md`
- Research: `.paw/work/copilot-sdk-migration/CodeResearch.md`
- Copilot SDK Node.js docs: https://github.com/github/copilot-sdk/blob/main/nodejs/README.md
- Copilot SDK MCP docs: https://github.com/github/copilot-sdk/blob/main/docs/mcp/overview.md
