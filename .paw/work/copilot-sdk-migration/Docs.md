# Copilot SDK Migration — Technical Reference

## Architecture Change

The agent runtime inside containers was migrated from `@anthropic-ai/claude-agent-sdk` to `@github/copilot-sdk`.

### Before
```
Host (Node.js) → Apple Container → claude-code CLI → Claude API
                                    ↑ query() streaming loop
```

### After
```
Host (Node.js) → Apple Container → Copilot CLI (bundled via SDK) → GitHub Copilot / BYOK
                                    ↑ CopilotClient JSON-RPC subprocess
```

## Key API Changes

| Concept | Claude SDK | Copilot SDK |
|---------|-----------|-------------|
| Entry point | `query()` async iterable | `CopilotClient` → `createSession()` / `resumeSession()` |
| Sending messages | Push into `MessageStream` | `session.sendAndWait()` / `session.send()` |
| Permissions | `permissionMode: 'bypassPermissions'` | `onPermissionRequest: async () => ({ kind: 'approved' })` |
| Session resume | `resume: sessionId, resumeSessionAt: uuid` | `client.resumeSession(sessionId, config)` |
| MCP servers | `mcpServers: { name: { command, args } }` | `mcpServers: { name: { type: 'local', command, args, tools: ['*'] } }` |
| Archival | Parse JSONL transcript file | `session.getMessages()` structured events |
| Abort | `stream.end()` | `session.abort()` |

## Authentication

Priority order (checked in `buildSessionConfig()`):

1. **GitHub tokens** (`GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`) — default Copilot auth, no provider config needed
2. **Anthropic BYOK** (`ANTHROPIC_API_KEY` without GitHub tokens) — uses `{ provider: { name: 'anthropic' }, model: 'claude-sonnet-4-20250514' }`
3. **OpenAI BYOK** (`OPENAI_API_KEY` without GitHub tokens) — uses `{ provider: { name: 'openai' }, model: 'gpt-4.1' }`

Environment variables are filtered from `.env` into the container. Only auth-related vars are passed through.

## Session Management

- Sessions are stored in `data/sessions/{group}/.copilot/` (was `.claude/`)
- Container mounts this at `/home/node/.copilot`
- `resumeSession()` attempts to resume; falls back to `createSession()` on error
- Session ID flows: stdin → agent-runner → stdout `newSessionId` → host DB

## Container Changes

- Base image: `node:24-slim` (was `node:22-slim`) — Copilot SDK requires Node.js ≥ 24
- Global installs: `agent-browser` only (removed `@anthropic-ai/claude-code`)
- The SDK's `@github/copilot` dependency bundles the Copilot CLI binary

## Host-Side Changes

- `src/container-runner.ts`: Updated session directory paths, env var filtering, removed Claude-specific settings.json
- Allowed env vars: `GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`

## Files Changed

| File | Change |
|------|--------|
| `container/agent-runner/src/index.ts` | Full rewrite: Claude SDK → Copilot SDK |
| `container/agent-runner/package.json` | Swapped SDK dependency, Node 24 types |
| `container/agent-runner/tsconfig.json` | Target ES2024 |
| `container/Dockerfile` | Node 24, removed claude-code install |
| `src/container-runner.ts` | Session dirs, env vars, mount paths |
| `CLAUDE.md` | SDK reference update |
| `README.md` | SDK references, architecture diagram |
| `docs/REQUIREMENTS.md` | SDK references |
