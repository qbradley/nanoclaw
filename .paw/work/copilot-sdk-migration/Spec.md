# Feature Specification: Copilot SDK Migration

**Branch**: feature/copilot-sdk-migration  |  **Created**: 2026-02-12  |  **Status**: Draft
**Input Brief**: Replace Claude Agent SDK with GitHub Copilot SDK as the agent runtime inside NanoClaw's container

## Overview

NanoClaw currently runs the Anthropic Claude Agent SDK inside isolated Apple Container Linux VMs to process user messages from WhatsApp. Each container invocation imports `@anthropic-ai/claude-agent-sdk`, calls the `query()` function with a streaming message interface, and emits results back to the host via stdout markers.

This migration replaces that runtime with the GitHub Copilot SDK (`@github/copilot-sdk`), which provides a `CopilotClient` that manages a Copilot CLI process and exposes agent capabilities through an event-driven session API. The Copilot SDK offers multi-model support, GitHub-native authentication, and a production-tested agent runtime with built-in tools for file operations, code execution, and web access.

The migration preserves NanoClaw's core architecture: container isolation, filesystem-based IPC, the MCP server for custom tools (scheduling, messaging), and the stdin/stdout JSON protocol between host and container. Only the agent runtime layer changes — from an in-process SDK call to a client-server pattern where the Copilot CLI runs as a subprocess managed by the SDK within the same container.

The value is twofold: access to multiple LLM providers through a single runtime (GitHub auth, OpenAI, Anthropic via BYOK), and alignment with the Copilot ecosystem for tooling and model access.

## Objectives

- Replace the Claude Agent SDK with the Copilot SDK as the agent runtime without changing NanoClaw's external behavior
- Maintain container isolation for all agent execution
- Support GitHub Copilot authentication by default with BYOK (Bring Your Own Key) as a fallback for users with existing API keys
- Preserve session continuity across container invocations using Copilot SDK's session resume capability
- Keep the existing MCP server and IPC architecture unchanged
- Maintain conversation archival functionality through Copilot SDK's session lifecycle hooks

## User Scenarios & Testing

### User Story P1 – Agent Responds to Messages
Narrative: A user sends a message mentioning the trigger word in a WhatsApp group. NanoClaw routes the message to the container, which processes it through the Copilot SDK and returns a response. The user receives the response in the group chat.
Independent Test: Send a triggered message and verify a coherent response is received.
Acceptance Scenarios:
1. Given a registered WhatsApp group with trigger word configured, When a user sends a message containing the trigger word, Then the agent processes the message and returns a text response via the existing stdout marker protocol
2. Given a message that requires tool use (file reading, web search, bash execution), When the agent processes the message, Then built-in Copilot CLI tools execute correctly and results are incorporated into the response
3. Given the MCP server is configured, When the agent needs to send an immediate message or manage scheduled tasks, Then the custom MCP tools (send_message, schedule_task, etc.) function correctly

### User Story P2 – Session Persistence Across Turns
Narrative: A user has an ongoing conversation with the agent across multiple messages. Each container invocation resumes the previous session so the agent remembers context from earlier turns.
Independent Test: Send a follow-up message referencing earlier context and verify the agent maintains conversational continuity.
Acceptance Scenarios:
1. Given a session ID from a previous interaction, When a new container invocation uses that session ID, Then the Copilot SDK resumes the existing session and the agent has access to prior conversation context
2. Given a stale or invalid session ID, When session resume fails, Then the agent creates a new session, logs a warning, and still processes the current message successfully
3. Given the IPC input directory contains follow-up messages during an active query, When those messages arrive, Then they are sent to the active session as additional user messages

### User Story P3 – Flexible Authentication
Narrative: The operator can configure NanoClaw to authenticate with either a GitHub Copilot subscription (default) or their own API key from a supported provider. The agent functions identically regardless of auth method.
Independent Test: Configure BYOK with an Anthropic API key and verify the agent responds normally.
Acceptance Scenarios:
1. Given a GitHub token is available (GITHUB_TOKEN or COPILOT_GITHUB_TOKEN), When the container starts, Then the Copilot SDK authenticates via GitHub and the agent can process messages
2. Given BYOK environment variables are configured (e.g., ANTHROPIC_API_KEY with provider config), When the container starts, Then the Copilot SDK uses the configured provider and the agent can process messages
3. Given no valid authentication credentials, When the container starts, Then the agent fails with a clear error message indicating the missing configuration

### User Story P4 – Conversation Archival
Narrative: When sessions are compacted or ended, conversation transcripts are archived to the group's conversations directory, preserving conversation history for reference.
Independent Test: Trigger a long enough conversation to cause compaction and verify a transcript file appears.
Acceptance Scenarios:
1. Given a session with conversation history, When the session ends or compaction occurs, Then a markdown transcript is saved to `/workspace/group/conversations/`
2. Given the archival process encounters an error, When the error occurs, Then it is logged but does not prevent the agent from continuing to function

### Edge Cases
- Container starts with Copilot CLI not installed or not in PATH → fail fast with clear error
- Auth token expires mid-session → SDK error propagated via writeOutput error protocol
- Multiple IPC messages arrive simultaneously → all are delivered to the session in order
- System prompt (global CLAUDE.md) is missing → session starts without additional system context
- Container timeout fires during active Copilot CLI processing → graceful shutdown via existing container stop mechanism

## Requirements

### Functional Requirements
- FR-001: Replace `@anthropic-ai/claude-agent-sdk` import and `query()` call with `@github/copilot-sdk` `CopilotClient` and `CopilotSession` API (Stories: P1)
- FR-002: Install the Copilot CLI inside the container image so it is available to the SDK at runtime (Stories: P1)
- FR-003: Map session persistence from `query({resume: sessionId})` to `client.resumeSession(sessionId)` with fallback to `client.createSession()` (Stories: P2)
- FR-004: Configure MCP server integration using Copilot SDK's `mcpServers` session config with `type: "local"`, matching the current stdio-based MCP server setup (Stories: P1)
- FR-005: Support GitHub authentication by default using environment variables (GITHUB_TOKEN, COPILOT_GITHUB_TOKEN, GH_TOKEN) (Stories: P3)
- FR-006: Support BYOK authentication by configuring the Copilot SDK's `provider` option with the appropriate provider type and API key (Stories: P3)
- FR-007: Update the host-side environment variable filtering to pass the correct auth variables into the container (Stories: P3)
- FR-008: Map the system prompt from `systemPrompt: { preset: 'claude_code', append: globalClaudeMd }` to Copilot SDK's `systemMessage: { content: globalClaudeMd }` (Stories: P1)
- FR-009: Maintain the stdout marker protocol (OUTPUT_START/END markers with JSON payloads) for host-container communication (Stories: P1)
- FR-010: Implement conversation archival using Copilot SDK's session lifecycle hooks (`onSessionEnd`) or compaction events (Stories: P4)
- FR-011: Preserve the IPC polling loop that delivers follow-up messages to the active session during query execution (Stories: P2)
- FR-012: Update the container Dockerfile to remove `@anthropic-ai/claude-code` and install the Copilot CLI (Stories: P1)
- FR-013: Update `container/agent-runner/package.json` to replace `@anthropic-ai/claude-agent-sdk` with `@github/copilot-sdk` (Stories: P1)
- FR-014: Update host-side session directory configuration, replacing `.claude/`-specific paths and settings with equivalents appropriate for the Copilot CLI (Stories: P2)

### Cross-Cutting / Non-Functional
- The migration must not change the external behavior observed by WhatsApp users
- Container startup time should remain comparable (within 30 seconds of current baseline)
- The stdout marker protocol between host and container must remain backward-compatible
- Error messages from auth failures must clearly indicate which credentials are missing or invalid

## Success Criteria
- SC-001: Agent responds to triggered WhatsApp messages with text responses using the Copilot SDK runtime (FR-001, FR-002, FR-004, FR-008)
- SC-002: Session context is maintained across container invocations — the agent remembers previous conversation turns (FR-003, FR-011, FR-014)
- SC-003: Custom MCP tools (send_message, schedule_task, list_tasks, pause_task, resume_task, cancel_task, register_group) function correctly through the Copilot SDK's MCP integration (FR-004)
- SC-004: Agent functions with GitHub token authentication when configured (FR-005, FR-007)
- SC-005: Agent functions with BYOK authentication (Anthropic, OpenAI, or other supported provider) when configured (FR-006, FR-007)
- SC-006: Conversation transcripts are archived when sessions end or compact (FR-010)
- SC-007: The host process correctly parses agent output via the unchanged stdout marker protocol (FR-009)

## Assumptions
- The Copilot CLI can be installed inside a `node:22-slim` based container image (via npm global install or binary download)
- The Copilot SDK's `resumeSession()` stores session data in a directory that can be persisted via volume mounts between container invocations
- The Copilot CLI's built-in tools (Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch) provide equivalent functionality to the Claude Code tools currently in use
- The Copilot SDK's MCP server integration (stdio type) is compatible with the existing `ipc-mcp-stdio.ts` MCP server
- The `agent-browser` global npm package will continue to function when invoked via the Copilot CLI's Bash tool
- Copilot CLI reads `CLAUDE.md` or equivalent memory files from the working directory (or can be configured to do so via system message)
- MCP server configuration inheritance by subagents/custom agents is not required for initial migration (deferred to out-of-scope)

## Scope

In Scope:
- Agent runner rewrite (container/agent-runner/src/index.ts)
- Container dependency updates (package.json, Dockerfile)
- Host-side auth and session directory updates (src/container-runner.ts)
- System prompt and tool configuration mapping
- Conversation archival hook adaptation

Out of Scope:
- Changes to the WhatsApp channel integration
- Changes to the IPC system (ipc.ts, ipc-mcp-stdio.ts tool implementations)
- Changes to the message router or group queue
- Changes to the task scheduler
- Host-side database or state management
- Adding new features or tools not present in the current system
- Migration of existing session data (old sessions will not be resumed after migration)
- Agent teams / subagent orchestration parity (Copilot CLI may support custom agents natively; verifying full parity is deferred)

## Dependencies
- `@github/copilot-sdk` npm package (Technical Preview)
- Copilot CLI binary (must be installable in container)
- GitHub Copilot subscription (for GitHub auth) or supported BYOK provider API key

## Risks & Mitigations
- **Copilot SDK is in Technical Preview**: API may change. Mitigation: Pin SDK version in package.json; the current Claude SDK was also pre-1.0
- **Copilot CLI installation in container**: May require specific system dependencies. Mitigation: Test container build early; fall back to binary download if npm install fails
- **Session storage location differs from Claude**: Session data may be stored in a different directory structure. Mitigation: Investigate early during code research; configure via workspacePath or volume mount
- **MCP server compatibility**: Copilot CLI's MCP stdio integration may behave differently. Mitigation: Test MCP tools early in implementation; the SDK documentation confirms stdio MCP support
- **Built-in tool parity**: Copilot CLI tools may differ in behavior from Claude Code tools. Mitigation: Functional testing with representative prompts; the core tools (Bash, file ops) are standard across both

## References
- GitHub Copilot SDK: https://github.com/github/copilot-sdk
- Node.js SDK README: https://github.com/github/copilot-sdk/blob/main/nodejs/README.md
- MCP Integration: https://github.com/github/copilot-sdk/blob/main/docs/mcp/overview.md
- BYOK Documentation: https://github.com/github/copilot-sdk/blob/main/docs/auth/byok.md
- Work Shaping: .paw/work/copilot-sdk-migration/WorkShaping.md
