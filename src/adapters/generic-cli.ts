import { type Readable } from "stream";
import {
  type AgentAdapter,
  type AgentMessage,
  type SlashCommand,
  type SlashCommandResult,
  type SpawnArgs,
  type VaultContext,
} from "./types";
import { whichBinary, execCommand } from "../utils/platform";
import { formatContextForPrompt } from "../utils/vault-context";

/**
 * Generic CLI adapter for any stdin/stdout-based agent tool.
 *
 * Sends the prompt as a CLI argument and reads all stdout as plain-text
 * assistant responses. Works as a fallback for unsupported or custom tools.
 */
export class GenericCliAdapter implements AgentAdapter {
  readonly id = "generic-cli";
  readonly displayName: string;
  readonly binaryName: string;

  constructor(binaryName: string) {
    this.binaryName = binaryName;
    this.displayName = `Custom (${binaryName})`;
  }

  async detect(): Promise<boolean> {
    const path = await whichBinary(this.binaryName);
    return path !== null;
  }

  async getVersion(): Promise<string | null> {
    try {
      const output = await execCommand(`${this.binaryName} --version`);
      return output.trim();
    } catch {
      return null;
    }
  }

  buildSpawnArgs(opts: {
    prompt: string;
    context: VaultContext;
    cwd: string;
    imagePaths?: string[];
  }): SpawnArgs {
    const contextStr = formatContextForPrompt(opts.context, {
      includeFile: true,
      includeSelection: true,
    });

    let fullPrompt = contextStr
      ? `${contextStr}\n\n${opts.prompt}`
      : opts.prompt;

    // Generic adapters have no native image support — embed paths in
    // the prompt so the agent can attempt to read them.
    if (opts.imagePaths?.length) {
      const listing = opts.imagePaths.map((p) => `  - ${p}`).join("\n");
      fullPrompt += `\n\n[Attached images — use your file-reading tool to view them]\n${listing}`;
    }

    return {
      command: this.binaryName,
      args: [fullPrompt],
    };
  }

  async *parseOutputStream(stdout: Readable): AsyncIterable<AgentMessage> {
    for await (const chunk of stdout) {
      const text = chunk.toString();
      if (text.trim()) {
        yield {
          role: "assistant",
          content: text,
          timestamp: Date.now(),
        };
      }
    }
  }

  getBuiltinSlashCommands(): SlashCommand[] {
    // Generic adapter has no known slash commands
    return [];
  }

  getSlashCommands(): Promise<SlashCommand[]> {
    return Promise.resolve([]);
  }

  discoverSlashCommands(_cwd: string): Promise<SlashCommand[] | null> {
    return Promise.resolve(null);
  }

  executeSlashCommand(
    _command: string,
    _args: string,
  ): Promise<SlashCommandResult> {
    return Promise.resolve({ handled: false });
  }
}
