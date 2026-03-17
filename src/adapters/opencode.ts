import { Readable } from "stream";
import {
	AgentAdapter,
	AgentMessage,
	SlashCommand,
	SpawnArgs,
	VaultContext,
} from "./types";
import { whichBinary, execCommand } from "../utils/platform";
import { formatContextForPrompt } from "../utils/vault-context";

/**
 * Adapter for Opencode CLI.
 *
 * Uses `opencode run` for one-shot prompts.
 * Output is streamed as plain text from stdout.
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
			args: ["run", fullPrompt],
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

	getSlashCommands(): SlashCommand[] {
		return [
			{
				name: "/compact",
				description: "Compact conversation context",
			},
			{ name: "/model", description: "Switch the active model" },
			{ name: "/provider", description: "Switch the active provider" },
			{ name: "/help", description: "Show available commands" },
		];
	}

	formatSlashCommand(command: string, args?: string): string {
		return args ? `${command} ${args}` : command;
	}
}
