import type { ToolCall, ToolResult } from '@lintic/core';
import type { WebContainer } from '@webcontainer/api';

const FILE_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 300_000; // 5 minutes — covers npm install and similar long-running commands

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms),
    ),
  ]);
}

export class ToolExecutor {
  constructor(
    private wc: WebContainer,
    /** Optional callback — each output chunk is forwarded here (e.g. to the UI terminal). */
    private onOutput?: (chunk: string) => void,
  ) {}

  async execute(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const output = await this.dispatch(toolCall);
      return { tool_call_id: toolCall.id, name: toolCall.name, output, is_error: false };
    } catch (err) {
      return {
        tool_call_id: toolCall.id,
        name: toolCall.name,
        output: err instanceof Error ? err.message : String(err),
        is_error: true,
      };
    }
  }

  async executeAll(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    return Promise.all(toolCalls.map(tc => this.execute(tc)));
  }

  private dispatch(toolCall: ToolCall): Promise<string> {
    const { name, input } = toolCall;
    switch (name) {
      case 'read_file':
        return this.handleReadFile(input as { path: string });
      case 'write_file':
        return this.handleWriteFile(input as { path: string; content: string });
      case 'run_command':
        return this.handleRunCommand(input as { command: string });
      case 'list_directory':
        return this.handleListDirectory(input as { path: string });
      case 'search_files':
        return this.handleSearchFiles(input as { pattern: string; path?: string });
      default:
        return Promise.reject(new Error(`Unknown tool: ${String(name)}`));
    }
  }

  /** Collect a ReadableStream<string> to a single string, forwarding chunks to onOutput. */
  private async collectStream(stream: ReadableStream<string>): Promise<string> {
    const chunks: string[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      this.onOutput?.(value);
    }
    return chunks.join('');
  }

  private handleReadFile({ path }: { path: string }): Promise<string> {
    return withTimeout(this.wc.fs.readFile(path, 'utf-8'), FILE_TIMEOUT_MS, 'read_file');
  }

  private async handleWriteFile({ path, content }: { path: string; content: string }): Promise<string> {
    await withTimeout(this.wc.fs.writeFile(path, content), FILE_TIMEOUT_MS, 'write_file');
    return 'ok';
  }

  private async handleRunCommand({ command }: { command: string }): Promise<string> {
    const [cmd, ...args] = command.split(' ');
    const process = await this.wc.spawn(cmd!, args);
    // Echo the command to the terminal so the user can see what the agent is running.
    this.onOutput?.(`\r\n\x1b[2m$ ${command}\x1b[0m\r\n`);
    return withTimeout(this.collectStream(process.output), COMMAND_TIMEOUT_MS, 'run_command');
  }

  private async handleListDirectory({ path }: { path: string }): Promise<string> {
    const entries = await withTimeout(
      this.wc.fs.readdir(path, { withFileTypes: true }),
      FILE_TIMEOUT_MS,
      'list_directory',
    );
    return entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
  }

  private async handleSearchFiles({ pattern, path = '.' }: { pattern: string; path?: string }): Promise<string> {
    const process = await this.wc.spawn('grep', ['-rl', pattern, path]);
    return withTimeout(this.collectStream(process.output), COMMAND_TIMEOUT_MS, 'search_files');
  }
}
