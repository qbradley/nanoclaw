/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent turn).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { CopilotClient } from '@github/copilot-sdk';
import type { CopilotSession } from '@github/copilot-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Archive conversation messages to conversations/ directory.
 * Called when session ends or compacts.
 */
async function archiveConversation(session: CopilotSession): Promise<void> {
  try {
    const events = await session.getMessages();
    const messages: ParsedMessage[] = [];

    for (const event of events) {
      if (event.type === 'user.message' && event.data?.content) {
        messages.push({ role: 'user', content: String(event.data.content) });
      } else if (event.type === 'assistant.message' && event.data?.content) {
        messages.push({ role: 'assistant', content: String(event.data.content) });
      }
    }

    if (messages.length === 0) {
      log('No messages to archive');
      return;
    }

    const conversationsDir = '/workspace/group/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });

    const name = generateFallbackName();
    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}-${name}.md`;
    const filePath = path.join(conversationsDir, filename);

    const markdown = formatTranscriptMarkdown(messages);
    fs.writeFileSync(filePath, markdown);

    log(`Archived conversation to ${filePath}`);
  } catch (err) {
    log(`Failed to archive conversation: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Andy';
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Build session configuration for Copilot SDK.
 */
function buildSessionConfig(
  containerInput: ContainerInput,
  mcpServerPath: string,
) {
  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Detect BYOK provider from environment
  let provider: { type: string; baseUrl: string; apiKey?: string } | undefined;
  if (process.env.ANTHROPIC_API_KEY && !process.env.GITHUB_TOKEN && !process.env.COPILOT_GITHUB_TOKEN && !process.env.GH_TOKEN) {
    provider = {
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: process.env.ANTHROPIC_API_KEY,
    };
  } else if (process.env.OPENAI_API_KEY && !process.env.GITHUB_TOKEN && !process.env.COPILOT_GITHUB_TOKEN && !process.env.GH_TOKEN) {
    provider = {
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY,
    };
  }

  const config: Record<string, unknown> = {
    workingDirectory: '/workspace/group',
    systemMessage: globalClaudeMd ? { content: globalClaudeMd } : undefined,
    mcpServers: {
      nanoclaw: {
        type: 'local',
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        },
        tools: ['*'],
      },
    },
    onPermissionRequest: async () => ({ kind: 'approved' as const }),
    infiniteSessions: { enabled: true },
  };

  if (provider) {
    config.provider = provider;
    // BYOK requires explicit model
    config.model = provider.type === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4.1';
  }

  return config;
}

/**
 * Send a prompt and wait for the assistant's response.
 * Returns the assistant message content, or null if no response.
 */
async function sendAndCollect(
  session: CopilotSession,
  prompt: string,
): Promise<string | null> {
  const response = await session.sendAndWait(
    { prompt },
    10 * 60 * 1000, // 10 minute timeout for long-running agent tasks
  );
  return response?.data?.content ?? null;
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  const client = new CopilotClient({
    logLevel: 'error',
    useStdio: true,
  });

  let session: CopilotSession | undefined;

  try {
    await client.start();
    log('Copilot client started');

    const sessionConfig = buildSessionConfig(containerInput, mcpServerPath);

    // Create or resume session
    if (containerInput.sessionId) {
      try {
        session = await client.resumeSession(containerInput.sessionId, sessionConfig);
        log(`Resumed session: ${session.sessionId}`);
      } catch (err) {
        log(`Session resume failed, creating new: ${err instanceof Error ? err.message : String(err)}`);
        session = await client.createSession(sessionConfig);
        log(`Created new session: ${session.sessionId}`);
      }
    } else {
      session = await client.createSession(sessionConfig);
      log(`Created new session: ${session.sessionId}`);
    }

    const newSessionId = session.sessionId;

    // Main loop: send prompt → wait for IPC → send next prompt → repeat
    while (true) {
      log(`Sending prompt (session: ${newSessionId})...`);

      // Start IPC polling during active session send
      let ipcPolling = true;
      let closedDuringQuery = false;

      const pollIpcDuringQuery = () => {
        if (!ipcPolling) return;
        if (shouldClose()) {
          log('Close sentinel detected during query, aborting');
          closedDuringQuery = true;
          ipcPolling = false;
          session?.abort().catch(() => {});
          return;
        }
        const messages = drainIpcInput();
        for (const text of messages) {
          log(`Sending IPC follow-up message (${text.length} chars)`);
          session?.send({ prompt: text }).catch((err: Error) => {
            log(`Failed to send IPC message: ${err.message}`);
          });
        }
        setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
      };
      setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

      const result = await sendAndCollect(session, prompt);
      ipcPolling = false;

      writeOutput({
        status: 'success',
        result: result,
        newSessionId,
      });

      if (closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), sending to session`);
      prompt = nextMessage;
    }

    // Archive conversation before cleanup
    await archiveConversation(session);

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: session?.sessionId,
      error: errorMessage
    });
    process.exit(1);
  } finally {
    try {
      if (session) await session.destroy();
    } catch { /* ignore cleanup errors */ }
    try {
      await client.stop();
    } catch { /* ignore cleanup errors */ }
  }
}

main();
