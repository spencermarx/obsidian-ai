import { Readable } from "stream";
import {
	AgentAdapter,
	AgentMessage,
	SlashCommand,
	SlashCommandResult,
	SpawnArgs,
	VaultContext,
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
 * Uses `opencode -p` for headless one-shot prompts.
 * Output is plain text (or JSON with -f json) from stdout.
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
	}): SpawnArgs {
		const contextStr = formatContextForPrompt(opts.context, {
			includeFile: true,
			includeSelection: true,
		});

		const fullPrompt = contextStr
			? `${contextStr}\n\n${opts.prompt}`
			: opts.prompt;

		return {
			command: this.binaryName,
			args: ["-p", fullPrompt, "-q"],
		};
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

				// Attempt JSON parse for structured output
				try {
					const obj = JSON.parse(trimmed);
					if (obj.type === "text" || obj.type === "content") {
						yield {
							role: "assistant",
							content: obj.content || obj.text || "",
							timestamp: Date.now(),
						};
						continue;
					}
					if (obj.type === "tool_call" || obj.type === "tool_use") {
						yield {
							role: "tool",
							content: `Tool: ${obj.name || "unknown"}`,
							toolUse: {
								name: obj.name || "unknown",
								input: JSON.stringify(obj.input || {}),
								output: obj.output
									? JSON.stringify(obj.output)
									: undefined,
							},
							timestamp: Date.now(),
						};
						continue;
					}
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
		args: string
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
