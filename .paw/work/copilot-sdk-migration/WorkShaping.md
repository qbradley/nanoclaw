# Work Shaping: Convert NanoClaw to GitHub Copilot SDK

## Problem Statement

NanoClaw currently uses the Anthropic Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) and `@anthropic-ai/claude-code` as its agent runtime inside Apple Container. This needs to be replaced with the GitHub Copilot SDK (`@github/copilot-sdk`) + Copilot CLI (`copilot`), keeping the same container isolation model and IPC architecture.

**Who benefits**: The project owner — gains access to Copilot's multi-model support, GitHub-native auth, and the production-tested Copilot CLI agent runtime.

## Work Breakdown

### Core Changes

1. **Agent Runner Rewrite** (`container/agent-runner/src/index.ts`)
   - Replace `import { query } from '@anthropic-ai/claude-agent-sdk'` with `import { CopilotClient } from '@github/copilot-sdk'`
   - Replace `query({prompt, options})` loop with `CopilotClient` → `createSession()`/`resumeSession()` → `sendAndWait()`/event listeners
   - Map current streaming output (result messages) to Copilot SDK events (`assistant.message`, `session.idle`)
   - Keep the stdin/stdout JSON protocol (`OUTPUT_START/END` markers) unchanged
   - Keep the IPC polling (`MessageStream` → IPC input dir) — adapt to Copilot's session model
   - Map `PreCompact` hook to Copilot SDK's `hooks.onSessionEnd` or compaction events for transcript archival
   - Keep MCP server integration (Copilot SDK supports `mcpServers` config)

2. **Container Dependencies** (`container/agent-runner/package.json`)
   - Remove `@anthropic-ai/claude-agent-sdk`
   - Add `@github/copilot-sdk`
   - Keep `@modelcontextprotocol/sdk`, `cron-parser`, `zod`

3. **Dockerfile Updates** (`container/Dockerfile`)
   - Remove `npm install -g @anthropic-ai/claude-code`
   - Add `copilot` CLI installation (npm or binary download)
   - Keep `agent-browser` global install
   - Keep Chromium and other system deps

4. **Host-Side Auth** (`src/container-runner.ts`)
   - Update env var filtering: replace `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` with `COPILOT_GITHUB_TOKEN` / `GITHUB_TOKEN` and BYOK vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`)
   - Update `.claude/settings.json` creation → adapt or remove Claude-specific env vars (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, etc.)
   - Update sessions directory path (`.claude/` → Copilot's workspace path or keep `.claude/` as session storage)

5. **Skills Sync** (`src/container-runner.ts`)
   - Current: copies `container/skills/` into `.claude/skills/`
   - Adapt to Copilot CLI's custom agents/skills mechanism (if different) or keep as file-based context

### Supporting Changes

6. **System Prompt Mapping**
   - Current: `systemPrompt: { type: 'preset', preset: 'claude_code', append: globalClaudeMd }`
   - Map to Copilot SDK: `systemMessage: { content: globalClaudeMd }` (Copilot SDK auto-injects its own base prompt)

7. **Tool Allowlist Mapping**
   - Current explicit list: `Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task, TaskOutput, TaskStop, TeamCreate, TeamDelete, SendMessage, TodoWrite, ToolSearch, Skill, NotebookEdit, mcp__nanoclaw__*`
   - Copilot CLI has equivalent built-in tools — use SDK defaults (all first-party tools enabled by default) + MCP tools

8. **Session Persistence**
   - Current: `query({resume: sessionId, resumeSessionAt: uuid})` with `.claude/` directory
   - Map to: `client.resumeSession(sessionId)` with Copilot SDK's session storage
   - Need to handle multi-turn IPC loop (wait for IPC message → `session.send()` again)

9. **Config & Documentation**
   - Update `CLAUDE.md` references to be runtime-agnostic
   - Update `.env` example for new auth vars
   - Update `README.md` if it references Claude-specific setup

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Copilot CLI not found in container | Clear error in entrypoint.sh, fail fast |
| Auth token expired/invalid | SDK throws; catch and report via writeOutput error |
| Session resume fails (stale session) | Catch error, create new session, log warning |
| IPC messages during agent execution | Same polling model — `session.send()` for follow-up messages |
| Agent Teams / subagent orchestration | Copilot SDK supports custom agents natively; may need config adaptation |
| Pre-compact transcript archival | Map to `hooks.onSessionEnd` or `session.compaction_complete` event |
| BYOK mode (Anthropic key as fallback) | Copilot SDK `provider` config: `{ type: 'anthropic', apiKey: ... }` |
| MCP server stdio inheritance by subagents | Verify Copilot CLI passes MCP config to subagents |

## Architecture

```
WhatsApp → index.ts → container-runner.ts → Apple Container
                                                │
                                                ├─ entrypoint.sh
                                                │   └─ Starts copilot CLI (headless)
                                                │
                                                ├─ agent-runner/src/index.ts
                                                │   ├─ CopilotClient → connects to CLI
                                                │   ├─ createSession() / resumeSession()
                                                │   ├─ session.send({prompt}) / sendAndWait()
                                                │   ├─ Event listeners → writeOutput()
                                                │   └─ IPC polling → session.send() for follow-ups
                                                │
                                                └─ ipc-mcp-stdio.ts (unchanged)
                                                    └─ MCP server for send_message, schedule_task, etc.
```

**Key architectural difference**: Claude SDK's `query()` is a single async iterable call. Copilot SDK uses a persistent `CopilotClient` + `CopilotSession` with event-based communication. The agent-runner needs to manage the client lifecycle (start/stop) and session lifecycle (create/resume/destroy) explicitly.

## Critical Analysis

**Value**: Moves to a multi-model, GitHub-native agent runtime. BYOK support means the project isn't locked to any single LLM provider.

**Risk**: The Copilot SDK is in "Technical Preview" — API may change. The current Claude SDK integration is battle-tested.

**Complexity**: The main challenge is mapping the `query()` streaming loop to Copilot's event-based session model, especially the IPC polling + multi-turn conversation pattern.

## Codebase Fit

- **IPC system**: Completely unchanged — filesystem-based IPC is runtime-agnostic
- **MCP server**: Unchanged — Copilot SDK natively supports MCP servers
- **Container isolation**: Unchanged — just swap the agent runtime inside
- **Host-side code**: Minimal changes — mostly env var filtering and session dir paths

## Session Notes

- User wants minimal changes: if current code uses a Claude-provided tool, use Copilot equivalent; if current code defines a custom tool, keep it custom
- Container isolation must be preserved (not moving to host-side execution)
- Auth: GitHub auth by default, BYOK as fallback
- Session model: map current per-group sessionId persistence onto Copilot SDK's `resumeSession()`
- MCP server stays as-is (Copilot CLI supports mcpServers)
- Skills sync mechanism needs investigation for Copilot CLI's equivalent

## Open Questions

1. How does Copilot CLI handle `.claude/` equivalent — where does it store session data? (Likely `~/.copilot/` or configurable workspacePath)
2. Does Copilot CLI's MCP integration pass config to subagents (agent teams equivalent)?
3. What's the installation method for `copilot` CLI in a Docker/container image? (npm package or binary?)
4. How to handle the `PreCompact` hook equivalent for transcript archival?
5. Does the Copilot CLI respect CLAUDE.md files, or does it use its own memory mechanism?
