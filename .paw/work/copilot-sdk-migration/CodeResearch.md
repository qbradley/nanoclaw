# Code Research: Copilot SDK Migration

## 1. Agent Runner Internals (`container/agent-runner/src/index.ts`)

### 1.1 `query()` Call Parameters

The single `query()` call at **line 374–411** is the core of the agent runner. It uses the Claude Agent SDK:

```typescript
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
```
— `index.ts:19`

**Full `query()` invocation** (`index.ts:374-411`):
```typescript
for await (const message of query({
  prompt: stream,                    // AsyncIterable<SDKUserMessage> (MessageStream)
  options: {
    cwd: '/workspace/group',
    resume: sessionId,               // string | undefined — resumes existing session
    resumeSessionAt: resumeAt,       // string | undefined — lastAssistantUuid for exact resume point
    systemPrompt: globalClaudeMd
      ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
      : undefined,
    allowedTools: [
      'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebSearch', 'WebFetch',
      'Task', 'TaskOutput', 'TaskStop',
      'TeamCreate', 'TeamDelete', 'SendMessage',
      'TodoWrite', 'ToolSearch', 'Skill',
      'NotebookEdit',
      'mcp__nanoclaw__*'
    ],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project', 'user'],
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        },
      },
    },
    hooks: {
      PreCompact: [{ hooks: [createPreCompactHook()] }]
    },
  }
}))
```

**Key options summary**:
- `prompt`: `MessageStream` (push-based async iterable) — NOT a plain string
- `options.resume`: session ID string to resume
- `options.resumeSessionAt`: UUID of last assistant message for exact resume point
- `options.systemPrompt`: preset `claude_code` with appended global CLAUDE.md
- `options.allowedTools`: explicit allowlist of 18 tool categories + MCP wildcard
- `options.permissionMode` + `allowDangerouslySkipPermissions`: bypasses all permissions
- `options.settingSources`: reads from project and user settings
- `options.mcpServers`: single MCP server `nanoclaw` via stdio
- `options.hooks.PreCompact`: transcript archival hook

### 1.2 MessageStream Class

**Definition** (`index.ts:64-94`):
```typescript
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void { ... }
  end(): void { ... }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> { ... }
}
```

**Purpose**: Push-based async iterable that keeps the `query()` call alive (prevents `isSingleUserTurn`), allowing agent teams subagents to complete. The stream stays open until `end()` is called.

**SDKUserMessage shape** (`index.ts:49-55`):
```typescript
interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: '';  // empty string — SDK assigns the real session
}
```

**Migration note**: The Copilot SDK uses `session.send()` / `session.sendAndWait()` instead of streaming user messages via an async iterable. The multi-turn loop will need to use repeated `send()` calls instead.

### 1.3 Result Streaming — `message.type` Checks

**Message processing loop** (`index.ts:411-440`):

1. **`message.type === 'assistant'` with `'uuid' in message`** (`index.ts:416-418`):
   - Captures `lastAssistantUuid` for session resume point
   
2. **`message.type === 'system'` with `message.subtype === 'init'`** (`index.ts:420-422`):
   - Captures `newSessionId = message.session_id`
   - This is how the new session ID flows back from the SDK
   
3. **`message.type === 'system'` with `subtype === 'task_notification'`** (`index.ts:425-428`):
   - Logs agent teams task status updates
   
4. **`message.type === 'result'`** (`index.ts:430-439`):
   - Extracts text result from `message.result`
   - Calls `writeOutput()` with success status and `newSessionId`
   - Multiple results possible (one per agent teams subagent)

### 1.4 SessionId Flow

1. **Initial**: Received from stdin via `containerInput.sessionId` (`index.ts:466`)
2. **Passed to query**: `options.resume: sessionId` (`index.ts:378`)
3. **Updated**: From `system/init` message → `newSessionId = message.session_id` (`index.ts:421`)
4. **Returned to host**: Via `writeOutput({ ..., newSessionId })` (`index.ts:434-438`)
5. **Host-side persistence**: `src/index.ts:249-251` saves to `sessions[group.folder]` and calls `setSession()` in DB

### 1.5 `resumeAt` (lastAssistantUuid)

**Flow** (`index.ts:484-495`):
```typescript
let resumeAt: string | undefined;
// ... in loop:
if (queryResult.lastAssistantUuid) {
  resumeAt = queryResult.lastAssistantUuid;
}
// passed to next query:
await runQuery(prompt, sessionId, mcpServerPath, containerInput, resumeAt);
```

Used as `options.resumeSessionAt` in `query()` (`index.ts:379`). This tells the Claude SDK exactly which message to resume from within a session, enabling multi-turn within the same container run.

**Migration note**: Copilot SDK's `resumeSession()` resumes the entire session — it doesn't need a specific message UUID. The multi-turn loop changes from "resume query at UUID" to "send new message to existing session".

### 1.6 PreCompact Hook

**Definition** (`index.ts:144-184`):
```typescript
function createPreCompactHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;
    // ... reads transcript, parses messages, writes markdown to /workspace/group/conversations/
  };
}
```

**Registered at** (`index.ts:407-409`):
```typescript
hooks: { PreCompact: [{ hooks: [createPreCompactHook()] }] }
```

**Archival logic**:
- Reads transcript from `preCompact.transcript_path`
- Looks up session summary from `sessions-index.json` (`index.ts:119-139`)
- Parses JSONL transcript into user/assistant messages (`index.ts:204-228`)
- Formats as markdown and writes to `/workspace/group/conversations/{date}-{name}.md` (`index.ts:166-176`)

**Migration note**: Copilot SDK has `session.compaction_complete` event and `hooks.onSessionEnd` hook. The `compaction_complete` event includes `summaryContent` and `checkpointPath`. The `onSessionEnd` hook receives `reason` and `finalMessage`. Need to map the transcript archival to one of these.

### 1.7 IPC Polling During Queries (`pollIpcDuringQuery`)

**Definition** (`index.ts:344-360`):
```typescript
const pollIpcDuringQuery = () => {
  if (!ipcPolling) return;
  if (shouldClose()) {
    closedDuringQuery = true;
    stream.end();
    ipcPolling = false;
    return;
  }
  const messages = drainIpcInput();
  for (const text of messages) {
    stream.push(text);  // Push into active query's MessageStream
  }
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
};
```

**IPC constants** (`index.ts:56-58`):
```typescript
const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
```

**Key behaviors**:
- Polls every 500ms during active query
- `_close` sentinel → calls `stream.end()`, sets `closedDuringQuery = true`
- JSON files in input dir → pushed into `MessageStream` as additional user messages
- Between queries: `waitForIpcMessage()` (`index.ts:307-323`) blocks until next message or close

**Migration note**: With Copilot SDK, IPC messages during an active session will be sent via `session.send()`. The polling loop continues unchanged, but instead of pushing to a `MessageStream`, it calls `session.send({ prompt: text })`.

### 1.8 Main Query Loop

**The outer loop** (`index.ts:486-519`):
```
while (true) {
  runQuery(prompt, sessionId, ...) → get result
  if closedDuringQuery → break
  writeOutput(session update)
  waitForIpcMessage() → next prompt or close
  prompt = nextMessage
}
```

This is the container's lifecycle: run query → wait for IPC → run another query → repeat until `_close`.

### 1.9 writeOutput Protocol

**Definition** (`index.ts:106-113`):
```typescript
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}
```

**ContainerOutput shape** (`index.ts:32-37`):
```typescript
interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}
```

This protocol is **unchanged** in the migration.

---

## 2. Container Runner Host-Side (`src/container-runner.ts`)

### 2.1 `buildVolumeMounts()` — All Mounts

**Definition** (`container-runner.ts:58-207`). Mounts:

| # | Host Path | Container Path | RO | Condition |
|---|-----------|---------------|-----|-----------|
| 1 | `{projectRoot}` | `/workspace/project` | No | `isMain` only (`line 69`) |
| 2 | `{GROUPS_DIR}/{folder}` | `/workspace/group` | No | Always (`lines 73-85`) |
| 3 | `{GROUPS_DIR}/global` | `/workspace/global` | Yes | Non-main, if exists (`lines 90-97`) |
| 4 | `{DATA_DIR}/sessions/{folder}/.claude` | `/home/node/.claude` | No | Always (`lines 100-146`) |
| 5 | `{DATA_DIR}/ipc/{folder}` | `/workspace/ipc` | No | Always (`lines 148-158`) |
| 6 | `{envDir}` | `/workspace/env-dir` | Yes | If `.env` has allowed vars (`lines 160-185`) |
| 7 | `{projectRoot}/container/agent-runner/src` | `/app/src` | Yes | Always (`lines 187-194`) |
| 8 | Additional mounts | `/workspace/extra/{name}` | Varies | If `containerConfig.additionalMounts` (`lines 196-204`) |

### 2.2 Session Directory — `.claude/` Mount

**Critical for migration** (`container-runner.ts:100-146`):

```typescript
const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
fs.mkdirSync(groupSessionsDir, { recursive: true });
```

**settings.json creation** (`container-runner.ts:110-124`):
```typescript
const settingsFile = path.join(groupSessionsDir, 'settings.json');
if (!fs.existsSync(settingsFile)) {
  fs.writeFileSync(settingsFile, JSON.stringify({
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    },
  }, null, 2) + '\n');
}
```

**Skills sync** (`container-runner.ts:127-141`):
```typescript
const skillsSrc = path.join(process.cwd(), 'container', 'skills');
const skillsDst = path.join(groupSessionsDir, 'skills');
// Copies each skill directory from container/skills/ into .claude/skills/
```

**Migration note**: The `.claude/` directory and `settings.json` are Claude Code–specific. Copilot SDK uses `configDir` (session config) and `~/.copilot/session-state/{sessionId}/` for workspace. The mount path will change from `/home/node/.claude` to something like `/home/node/.copilot` or be configured via `configDir` in session options.

### 2.3 Environment Variable Filtering

**Definition** (`container-runner.ts:160-185`):
```typescript
const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
```

These are filtered from `.env` and written to `{envDir}/env`, then mounted at `/workspace/env-dir/env` (read-only). The entrypoint script sources them: `export $(cat /workspace/env-dir/env | xargs)`.

**Migration note**: Replace with Copilot auth vars:
- `GITHUB_TOKEN` or `COPILOT_GITHUB_TOKEN` (GitHub auth)
- `ANTHROPIC_API_KEY` (BYOK Anthropic)
- `OPENAI_API_KEY` (BYOK OpenAI)

### 2.4 `buildContainerArgs()`

**Definition** (`container-runner.ts:209-227`):
```typescript
function buildContainerArgs(mounts: VolumeMount[], containerName: string): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push('--mount', `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`);
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }
  args.push(CONTAINER_IMAGE);
  return args;
}
```

**Invoked via** (`container-runner.ts:272`):
```typescript
const container = spawn('container', containerArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
```

The binary `container` is the Apple Container CLI. stdin is piped, input is written then closed (`line 284-285`).

### 2.5 Streaming Output Parsing (Host-Side)

**Definition** (`container-runner.ts:287-342`): The host parses `OUTPUT_START_MARKER`/`OUTPUT_END_MARKER` pairs from stdout in real-time, calling `onOutput(parsed)` for each complete marker pair. It resets the hard timeout on each activity.

---

## 3. Dockerfile (`container/Dockerfile`)

### 3.1 Full Build Steps

```dockerfile
FROM node:22-slim                                    # Line 4
RUN apt-get update && apt-get install -y chromium ... # Lines 7-26 (system deps)
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium   # Line 29
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium # Line 30
RUN npm install -g agent-browser @anthropic-ai/claude-code # Line 33
WORKDIR /app                                          # Line 36
COPY agent-runner/package*.json ./                    # Line 39
RUN npm install                                       # Line 42
COPY agent-runner/ ./                                 # Line 45
RUN npm run build                                     # Line 48
RUN mkdir -p /workspace/...                           # Line 51
RUN printf '...' > /app/entrypoint.sh                 # Line 57
RUN chown -R node:node /workspace                     # Line 60
USER node                                             # Line 63
WORKDIR /workspace/group                              # Line 66
ENTRYPOINT ["/app/entrypoint.sh"]                     # Line 69
```

### 3.2 Entrypoint Script (Inline)

**Expanded from line 57**:
```bash
#!/bin/bash
set -e
[ -f /workspace/env-dir/env ] && export $(cat /workspace/env-dir/env | xargs)
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
```

**Key steps**:
1. Source environment vars from mounted env-dir
2. Re-compile TypeScript from mounted `/app/src` to `/tmp/dist` (hot reload workaround)
3. Symlink node_modules
4. Buffer stdin to file (Apple Container stdin flush workaround)
5. Run agent-runner

### 3.3 What `@anthropic-ai/claude-code` Provides

Installed globally at **line 33**: `npm install -g agent-browser @anthropic-ai/claude-code`

`@anthropic-ai/claude-code` provides:
- The Claude Code CLI (`claude`) binary
- All built-in tools (Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, etc.)
- Agent teams support (TeamCreate, TeamDelete)
- Session management (transcript storage, sessions-index.json)
- The `query()` function via `@anthropic-ai/claude-agent-sdk`

**Migration equivalent**: Replace with `@github/copilot` (the CLI) + `@github/copilot-sdk` (the programmatic SDK). The SDK depends on `@github/copilot@^0.0.405` which bundles the CLI.

---

## 4. MCP Server (`container/agent-runner/src/ipc-mcp-stdio.ts`)

### 4.1 How It's Spawned

Configured in `query()` options (`index.ts:396-406`):
```typescript
mcpServers: {
  nanoclaw: {
    command: 'node',
    args: [mcpServerPath],
    env: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    },
  },
},
```

Where `mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js')` (`index.ts:464`).

**Migration note**: Copilot SDK's `SessionConfig.mcpServers` has the same shape (`MCPLocalServerConfig`):
```typescript
mcpServers: {
  nanoclaw: {
    command: 'node',
    args: [mcpServerPath],
    env: { ... },
    tools: ['*'],  // Required: include all tools
  },
}
```

The Copilot SDK requires a `tools` field (array of tool names or `['*']` for all).

### 4.2 Environment Variables

Read from `process.env` (`ipc-mcp-stdio.ts:19-21`):
```typescript
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';
```

### 4.3 All Tools Exposed

**7 tools** defined in `ipc-mcp-stdio.ts`:

| Tool | Line | Description |
|------|------|-------------|
| `send_message` | 42-63 | Send immediate message to user/group |
| `schedule_task` | 65-143 | Schedule recurring/one-time tasks |
| `list_tasks` | 146-181 | List scheduled tasks |
| `pause_task` | 184-199 | Pause a task |
| `resume_task` | 203-219 | Resume a paused task |
| `cancel_task` | 222-239 | Cancel/delete a task |
| `register_group` | 241-275 | Register new WhatsApp group (main only) |

**Server initialization** (`ipc-mcp-stdio.ts:37-39, 278-279`):
```typescript
const server = new McpServer({ name: 'nanoclaw', version: '1.0.0' });
// ...
const transport = new StdioServerTransport();
await server.connect(transport);
```

**This file is unchanged in the migration** — only the way it's spawned (via `mcpServers` config) needs the `tools: ['*']` field added.

---

## 5. Config and Types

### 5.1 Container Config (`src/config.ts`)

| Constant | Value | Line |
|----------|-------|------|
| `CONTAINER_IMAGE` | `process.env.CONTAINER_IMAGE \|\| 'nanoclaw-agent:latest'` | 23-24 |
| `CONTAINER_TIMEOUT` | `process.env.CONTAINER_TIMEOUT \|\| '1800000'` (30 min) | 25-28 |
| `CONTAINER_MAX_OUTPUT_SIZE` | `10485760` (10 MB) | 29-32 |
| `IDLE_TIMEOUT` | `process.env.IDLE_TIMEOUT \|\| '1800000'` (30 min) | 35-37 |
| `IPC_POLL_INTERVAL` | `1000` ms | 33 |
| `DATA_DIR` | `{PROJECT_ROOT}/data` | 20 |
| `GROUPS_DIR` | `{PROJECT_ROOT}/groups` | 19 |
| `MAIN_GROUP_FOLDER` | `'main'` | 21 |

### 5.2 RegisteredGroup Type (`src/types.ts:35-42`)

```typescript
export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean;
}
```

### 5.3 ContainerConfig Type (`src/types.ts:30-33`)

```typescript
export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}
```

### 5.4 ContainerInput / ContainerOutput (Both Sides)

**Host-side** (`container-runner.ts:36-50`):
```typescript
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}
```

**Container-side** (`agent-runner/src/index.ts:22-37`) — identical shape.

### 5.5 Session Persistence (Host-Side)

**DB operations** (`src/db.ts:431-448`):
- `getSession(groupFolder)` → returns `session_id`
- `setSession(groupFolder, sessionId)` → INSERT OR REPLACE
- `getAllSessions()` → returns `{ [folder]: sessionId }`

**Used in** `src/index.ts:219`:
```typescript
const sessionId = sessions[group.folder];
```

---

## 6. Copilot SDK API Surface (`@github/copilot-sdk@0.1.8`)

### 6.1 Package Dependencies

From `nodejs/package.json`:
```json
{
  "dependencies": {
    "@github/copilot": "^0.0.405",  // Bundles the Copilot CLI
    "vscode-jsonrpc": "^8.2.1",
    "zod": "^4.3.6"
  },
  "engines": { "node": ">=24.0.0" }
}
```

**Critical**: Requires Node.js >= 24. Current Dockerfile uses `node:22-slim`. Will need `node:24-slim`.

### 6.2 CopilotClient

**Import**: `import { CopilotClient } from '@github/copilot-sdk'`

**Constructor** (`client.ts:120-188`):
```typescript
new CopilotClient(options?: CopilotClientOptions)
```

**Key `CopilotClientOptions`** (`types.ts`):
```typescript
interface CopilotClientOptions {
  cliPath?: string;         // Default: bundled CLI from @github/copilot
  cliArgs?: string[];       // Extra args before SDK-managed flags
  cwd?: string;             // Working directory for CLI process
  useStdio?: boolean;       // Default: true — use stdio transport
  logLevel?: string;        // "none" | "error" | "warning" | "info" | "debug" | "all"
  autoStart?: boolean;      // Default: true
  autoRestart?: boolean;    // Default: true
  env?: Record<string, string | undefined>;  // Defaults to process.env
  githubToken?: string;     // GitHub token for auth (priority)
  useLoggedInUser?: boolean; // Default: true (false when githubToken provided)
}
```

**Key methods**:
- `start(): Promise<void>` — starts CLI subprocess and connects (`client.ts:253`)
- `stop(): Promise<Error[]>` — graceful cleanup (`client.ts:298`)
- `forceStop(): Promise<void>` — force kill (`client.ts:408`)
- `createSession(config?: SessionConfig): Promise<CopilotSession>` (`client.ts:478`)
- `resumeSession(sessionId, config?): Promise<CopilotSession>` (`client.ts:556`)
- `listSessions(): Promise<SessionMetadata[]>` (`client.ts:822`)
- `deleteSession(sessionId): Promise<void>` (`client.ts:788`)
- `listModels(): Promise<ModelInfo[]>` (`client.ts:691`)

**CLI startup** (`client.ts:984-1085`):
The SDK spawns the CLI with:
```
copilot --headless --no-auto-update --log-level {level} --stdio
```
Plus optional `--auth-token-env COPILOT_SDK_AUTH_TOKEN` and `--no-auto-login`.

### 6.3 SessionConfig

**Full type** (`types.ts`):
```typescript
interface SessionConfig {
  sessionId?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  configDir?: string;           // Override config directory
  tools?: Tool[];               // Custom tools exposed to CLI
  systemMessage?: SystemMessageConfig;
  availableTools?: string[];    // Tool allowlist
  excludedTools?: string[];     // Tool blocklist
  provider?: ProviderConfig;    // BYOK config
  onPermissionRequest?: PermissionHandler;
  onUserInputRequest?: UserInputHandler;
  hooks?: SessionHooks;
  workingDirectory?: string;    // cwd for tool operations
  streaming?: boolean;          // Enable message deltas
  mcpServers?: Record<string, MCPServerConfig>;
  customAgents?: CustomAgentConfig[];
  skillDirectories?: string[];
  disabledSkills?: string[];
  infiniteSessions?: InfiniteSessionConfig;
}
```

**Migration mapping from `query()` options**:

| Claude SDK (`query()`) | Copilot SDK (`SessionConfig`) |
|------------------------|-------------------------------|
| `options.cwd` | `workingDirectory: '/workspace/group'` |
| `options.resume` | `client.resumeSession(sessionId)` |
| `options.resumeSessionAt` | No equivalent — not needed (session state managed by SDK) |
| `options.systemPrompt.append` | `systemMessage: { mode: 'append', content: globalClaudeMd }` |
| `options.allowedTools` | `availableTools: [...]` (note: Copilot CLI tool names may differ) |
| `options.permissionMode` | `onPermissionRequest: () => ({ kind: 'approved' })` |
| `options.settingSources` | No direct equivalent — use `configDir` |
| `options.mcpServers` | `mcpServers: { nanoclaw: { ..., tools: ['*'] } }` |
| `options.hooks.PreCompact` | `hooks: { onSessionEnd: ... }` + listen for `session.compaction_complete` |

### 6.4 ResumeSessionConfig

**Type** (`types.ts`):
```typescript
type ResumeSessionConfig = Pick<SessionConfig,
  | "model" | "tools" | "systemMessage" | "availableTools" | "excludedTools"
  | "provider" | "streaming" | "reasoningEffort" | "onPermissionRequest"
  | "onUserInputRequest" | "hooks" | "workingDirectory" | "configDir"
  | "mcpServers" | "customAgents" | "skillDirectories" | "disabledSkills"
  | "infiniteSessions"
> & {
  disableResume?: boolean;
};
```

All session config is re-specifiable on resume except `sessionId`.

### 6.5 CopilotSession

**Class** (`session.ts`):
```typescript
class CopilotSession {
  readonly sessionId: string;
  readonly workspacePath?: string;  // undefined if infiniteSessions disabled

  send(options: MessageOptions): Promise<string>;
  sendAndWait(options: MessageOptions, timeout?: number): Promise<AssistantMessageEvent | undefined>;
  on(handler: SessionEventHandler): () => void;
  on<K extends SessionEventType>(eventType: K, handler: TypedSessionEventHandler<K>): () => void;
  getMessages(): Promise<SessionEvent[]>;
  abort(): Promise<void>;
  destroy(): Promise<void>;
}
```

**`MessageOptions`** (`types.ts`):
```typescript
interface MessageOptions {
  prompt: string;
  attachments?: Array<...>;
  mode?: "enqueue" | "immediate";
}
```

**`sendAndWait()`** (`session.ts`):
- Sends message, waits for `session.idle` event
- Default timeout: 60,000ms — **must increase for NanoClaw** (agent tasks can take minutes)
- Returns the last `assistant.message` event, or `undefined`
- The `assistant.message` event has `data.content: string` (the text response)

### 6.6 SystemMessageConfig

```typescript
// Append mode (default) — SDK base prompt + custom content
interface SystemMessageAppendConfig {
  mode?: "append";
  content?: string;
}

// Replace mode — full control, removes all guardrails
interface SystemMessageReplaceConfig {
  mode: "replace";
  content: string;
}
```

**For migration**: Use append mode with the global CLAUDE.md content.

### 6.7 MCPServerConfig (Local/Stdio)

```typescript
interface MCPLocalServerConfig {
  type?: "local" | "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  tools: string[];      // REQUIRED — use ["*"] for all tools
  timeout?: number;      // Optional timeout for tool calls
}
```

**Key difference from Claude SDK**: The `tools` field is **required**. Use `tools: ["*"]` to expose all MCP server tools, or list specific tool names.

### 6.8 ProviderConfig (BYOK)

```typescript
interface ProviderConfig {
  type?: "openai" | "azure" | "anthropic";
  wireApi?: "completions" | "responses";
  baseUrl: string;
  apiKey?: string;
  bearerToken?: string;
  azure?: { apiVersion?: string };
}
```

**BYOK examples**:
```typescript
// Anthropic
provider: { type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: process.env.ANTHROPIC_API_KEY }
// OpenAI
provider: { type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY }
```

### 6.9 SessionHooks

```typescript
interface SessionHooks {
  onPreToolUse?: PreToolUseHandler;
  onPostToolUse?: PostToolUseHandler;
  onUserPromptSubmitted?: UserPromptSubmittedHandler;
  onSessionStart?: SessionStartHandler;
  onSessionEnd?: SessionEndHandler;         // reason: "complete" | "error" | "abort" | "timeout" | "user_exit"
  onErrorOccurred?: ErrorOccurredHandler;
}
```

**`SessionEndHookInput`**:
```typescript
interface SessionEndHookInput extends BaseHookInput {
  reason: "complete" | "error" | "abort" | "timeout" | "user_exit";
  finalMessage?: string;
  error?: string;
}
```

**Migration note**: `onSessionEnd` can replace `PreCompact` for archival, but it fires at session end, not at compaction. For compaction-triggered archival, listen for `session.compaction_complete` events which include `summaryContent` and `checkpointPath`.

### 6.10 Session Events (Key Types)

From `generated/session-events.ts`:

| Event Type | Key Data Fields |
|-----------|-----------------|
| `session.start` | `sessionId`, `selectedModel`, `context.cwd` |
| `session.resume` | `resumeTime`, `eventCount` |
| `session.idle` | `{}` (signals turn complete) |
| `session.error` | `errorType`, `message`, `stack` |
| `session.shutdown` | `shutdownType`, metrics |
| `session.compaction_start` | `{}` |
| `session.compaction_complete` | `success`, `summaryContent`, `checkpointPath`, token counts |
| `user.message` | `content`, `attachments` |
| `assistant.message` | `messageId`, `content`, `toolRequests` |
| `assistant.message_delta` | `messageId`, `deltaContent` |
| `tool.execution_start` | `toolCallId`, `toolName`, `arguments` |
| `tool.execution_complete` | `toolCallId`, `success`, `result` |
| `subagent.started` | `toolCallId`, `agentName` |
| `subagent.completed` | `toolCallId`, `agentName` |

### 6.11 Permission Handling

**For bypassing permissions** (equivalent to `allowDangerouslySkipPermissions`):
```typescript
onPermissionRequest: async (request) => ({ kind: 'approved' })
```

This auto-approves all permission requests (shell, write, mcp, read, url).

### 6.12 InfiniteSessionConfig

```typescript
interface InfiniteSessionConfig {
  enabled?: boolean;                        // Default: true
  backgroundCompactionThreshold?: number;   // Default: 0.80
  bufferExhaustionThreshold?: number;       // Default: 0.95
}
```

Default is enabled with automatic compaction — replaces the need for the `PreCompact` hook trigger (compaction happens automatically). Listen for `session.compaction_complete` events to archive transcripts.

---

## 7. Migration Mapping Summary

### 7.1 Agent Runner Architecture Change

**Current (Claude SDK)**: Single `query()` async iterable call per turn
```
query({prompt: stream, options}) → for await (message of ...) → process messages
```

**New (Copilot SDK)**: Client + Session lifecycle
```
CopilotClient.start() → createSession()/resumeSession() → session.send() → event handlers → session.destroy() → client.stop()
```

### 7.2 Key Differences

| Aspect | Claude SDK | Copilot SDK |
|--------|-----------|-------------|
| Entry point | `query()` function | `CopilotClient` class |
| Message delivery | `MessageStream` async iterable | `session.send()` / `session.sendAndWait()` |
| Results | `message.type === 'result'` in stream | `assistant.message` event `data.content` |
| Session ID | From `system/init` message | From `createSession()` return value |
| Session resume | `options.resume` + `resumeSessionAt` | `client.resumeSession(sessionId)` |
| Permissions | `permissionMode: 'bypassPermissions'` | `onPermissionRequest: () => ({ kind: 'approved' })` |
| System prompt | `{ type: 'preset', preset: 'claude_code', append: text }` | `{ mode: 'append', content: text }` |
| Tool allowlist | `allowedTools: [...]` | `availableTools: [...]` |
| MCP servers | `mcpServers: { name: { command, args, env } }` | Same + required `tools: ['*']` field |
| Compaction hook | `hooks.PreCompact` | `hooks.onSessionEnd` + `session.compaction_complete` event |
| CLI binary | `@anthropic-ai/claude-code` (global) | `@github/copilot` (bundled with SDK) |
| Node.js version | 22 | **24** (required by SDK) |

### 7.3 Files Changed

| File | Change Type |
|------|------------|
| `container/agent-runner/src/index.ts` | **Rewrite** — new SDK, event-based model |
| `container/agent-runner/package.json` | **Modify** — swap dependencies |
| `container/Dockerfile` | **Modify** — node:24, remove claude-code, SDK includes CLI |
| `src/container-runner.ts` | **Modify** — env vars, session dir, settings.json |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | **Unchanged** |
| `src/config.ts` | **Unchanged** |
| `src/types.ts` | **Unchanged** |
| `src/index.ts` | **Unchanged** (session tracking via ContainerOutput works the same) |
