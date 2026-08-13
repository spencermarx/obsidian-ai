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
 * Built-in slash commands shipped with the Opencode CLI. Maintained
 * manually; discovered user/project commands merge on top.
 */
const OPENCODE_BUILTINS: SlashCommand[] = [
  { name: "/compact", description: "Compact conversation context" },
  { name: "/editor", description: "Open the active message in $EDITOR" },
  { name: "/exit", description: "Exit the current session" },
  { name: "/help", description: "Show available commands" },
  { name: "/init", description: "Initialize project configuration" },
  { name: "/model", description: "Switch the active model" },
  { name: "/new", description: "Start a new session" },
  { name: "/provider", description: "Switch the active provider" },
  { name: "/redo", description: "Redo the last undone action" },
  { name: "/session", description: "Manage sessions" },
  { name: "/share", description: "Share the current session" },
  { name: "/undo", description: "Undo the last action" },
];

/**
 * Adapter for Opencode CLI.
 *
 * Uses `opencode run --format json` for headless prompts.
 * Output is a stream of JSON events from stdout.
 */
export class OpencodeAdapter implements AgentAdapter {
  readonly id = "opencode";
  readonly displayName = "Opencode";
  readonly binaryName = "opencode";

  async detect(): Promise<boolean> {
    const path = await whichBinary(this.binaryName);
    return path !== null;
  }

  async getVersion(): Promise<string | null> {
    try {
      const output = await execCommand("opencode version");
      return output.trim();
    } catch {
      try {
        const output = await execCommand("opencode --version");
        return output.trim();
      } catch {
        return null;
      }
    }
  }

  buildSpawnArgs(opts: {
    prompt: string;
    context: VaultContext;
    cwd: string;
    cliSessionId?: string;
    resumeSession?: boolean;
    imagePaths?: string[];
  }): SpawnArgs {
    const contextStr = formatContextForPrompt(opts.context, {
      includeFile: true,
      includeSelection: true,
    });

    let fullPrompt = contextStr
      ? `${contextStr}\n\n${opts.prompt}`
      : opts.prompt;

    // Opencode doesn't support native image input — embed paths in the
    // prompt so the agent can read them with its file-reading tools.
    if (opts.imagePaths?.length) {
      const listing = opts.imagePaths.map((p) => `  - ${p}`).join("\n");
      fullPrompt += `\n\n[Attached images — use your file-reading tool to view them]\n${listing}`;
    }

    const args = ["run", "--format", "json"];
    if (opts.resumeSession && opts.cliSessionId) {
      args.push("--session", opts.cliSessionId);
    }
    args.push(fullPrompt);

    return { command: this.binaryName, args };
  }

  async *parseOutputStream(stdout: Readable): AsyncIterable<AgentMessage> {
    let buffer = "";

    for await (const chunk of stdout) {
      const text = chunk.toString();
      buffer += text;

      // Try to parse as JSON lines (some modes output structured data)
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // OpenCode JSON mode emits lifecycle, text, and tool events.
        try {
          const obj = JSON.parse(trimmed);
          if (obj.type === "text" || obj.type === "content") {
            const content = obj.part?.text || obj.content || obj.text || "";
            if (!content) continue;
            yield {
              role: "assistant",
              content,
              cliSessionId: obj.sessionID || obj.sessionId,
              timestamp: Date.now(),
            };
            continue;
          }
          if (obj.type === "tool_call" || obj.type === "tool_use") {
            const part = obj.part || {};
            const state = part.state || {};
            const name = part.tool || obj.name || "unknown";
            const input = state.input || obj.input || {};
            const output = state.output || obj.output;
            yield {
              role: "tool",
              content: `Tool: ${name}`,
              toolUse: {
                name,
                input: JSON.stringify(input),
                output: output ? JSON.stringify(output) : undefined,
              },
              cliSessionId:
                obj.sessionID || obj.sessionId || part.sessionID,
              timestamp: Date.now(),
            };
            continue;
          }

          // Lifecycle events such as step_start and step_finish are not chat text.
          continue;
        } catch {
          // Not JSON — treat as plain text
        }

        yield {
          role: "assistant",
          content: trimmed,
          timestamp: Date.now(),
        };
      }
    }

    // Flush remaining
    if (buffer.trim()) {
      yield {
        role: "assistant",
        content: buffer.trim(),
        timestamp: Date.now(),
      };
    }
  }

  getBuiltinSlashCommands(): SlashCommand[] {
    return [...OPENCODE_BUILTINS];
  }

  getSlashCommands(): Promise<SlashCommand[]> {
    return Promise.resolve(this.getBuiltinSlashCommands());
  }

  discoverSlashCommands(_cwd: string): Promise<SlashCommand[] | null> {
    return Promise.resolve(null);
  }

  executeSlashCommand(
    command: string,
    args: string,
  ): Promise<SlashCommandResult> {
    switch (command) {
      case "/clear":
        return Promise.resolve({ handled: true, action: "clear" });
      case "/help":
        return Promise.resolve({ handled: true, action: "help" });
    }

    const promptMap: Record<string, string> = {
      "/compact":
        "Please compact and summarize our conversation so far to save context.",
    };

    const mapped = promptMap[command];
    if (mapped) {
      const prompt = args ? `${mapped} ${args}` : mapped;
      return Promise.resolve({ handled: true, prompt });
    }

    return Promise.resolve({ handled: false });
  }
}
