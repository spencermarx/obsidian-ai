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
 * Adapter for Claude Code CLI.
 *
 * Uses `claude` with `--output-format stream-json` for structured streaming
 * output. Each line from stdout is a JSON object with a type field.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
	readonly id = "claude-code";
	readonly displayName = "Claude Code";
	readonly binaryName = "claude";

	async detect(): Promise<boolean> {
		const path = await whichBinary(this.binaryName);
		return path !== null;
	}

	async getVersion(): Promise<string | null> {
		try {
			const output = await execCommand("claude --version");
			return output.trim();
		} catch {
			return null;
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
			args: [
				"--output-format",
				"stream-json",
				"--verbose",
				"-p",
				fullPrompt,
			],
		};
	}

	async *parseOutputStream(stdout: Readable): AsyncIterable<AgentMessage> {
		let buffer = "";

		for await (const chunk of stdout) {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;

				try {
					const event = JSON.parse(trimmed);
					const message = this.parseEvent(event);
					if (message) yield message;
				} catch {
					// Non-JSON line — emit as raw assistant text
					if (trimmed) {
						yield {
							role: "assistant",
							content: trimmed,
							timestamp: Date.now(),
						};
					}
				}
			}
		}

		// Flush remaining buffer
		if (buffer.trim()) {
			try {
				const event = JSON.parse(buffer.trim());
				const message = this.parseEvent(event);
				if (message) yield message;
			} catch {
				yield {
					role: "assistant",
					content: buffer.trim(),
					timestamp: Date.now(),
				};
			}
		}
	}

	private parseEvent(event: Record<string, unknown>): AgentMessage | null {
		const type = event.type as string | undefined;

		if (type === "assistant" || type === "text") {
			const message = event.message as
				| Record<string, unknown>
				| undefined;
			const content =
				(message?.content as string) ||
				(event.content as string) ||
				"";
			if (!content) return null;
			return {
				role: "assistant",
				content,
				timestamp: Date.now(),
			};
		}

		if (type === "content_block_delta") {
			const delta = event.delta as Record<string, unknown> | undefined;
			const text = (delta?.text as string) || "";
			if (!text) return null;
			return {
				role: "assistant",
				content: text,
				timestamp: Date.now(),
			};
		}

		if (type === "tool_use" || type === "tool_result") {
			const name = (event.name as string) || (type as string);
			const input =
				typeof event.input === "string"
					? event.input
					: JSON.stringify(event.input || {});
			const output =
				typeof event.output === "string"
					? event.output
					: event.content
						? JSON.stringify(event.content)
						: undefined;

			const message: AgentMessage = {
				role: "tool",
				content: `Tool: ${name}`,
				toolUse: { name, input, output: output as string | undefined },
				timestamp: Date.now(),
			};

			// Check if this is a file edit tool
			if (
				name === "Write" ||
				name === "Edit" ||
				name === "write" ||
				name === "edit"
			) {
				const parsedInput =
					typeof event.input === "object"
						? (event.input as Record<string, unknown>)
						: {};
				const filePath =
					(parsedInput.file_path as string) ||
					(parsedInput.path as string) ||
					"";
				const newContent =
					(parsedInput.content as string) ||
					(parsedInput.new_string as string) ||
					"";

				if (filePath) {
					message.fileEdit = {
						filePath,
						newContent,
						oldContent: parsedInput.old_string as
							| string
							| undefined,
					};
				}
			}

			return message;
		}

		// Catch-all for result messages
		if (type === "result") {
			const result = (event.result as string) || "";
			if (result) {
				return {
					role: "assistant",
					content: result,
					timestamp: Date.now(),
				};
			}
		}

		return null;
	}

	getSlashCommands(): SlashCommand[] {
		return [
			{
				name: "/help",
				description: "Show available commands and usage",
			},
			{
				name: "/clear",
				description: "Clear conversation history",
			},
			{
				name: "/compact",
				description: "Compact conversation to save context",
			},
			{
				name: "/commit",
				description: "Commit staged changes with a message",
			},
			{
				name: "/review-pr",
				description: "Review a pull request",
			},
			{
				name: "/create-pr",
				description: "Create a new pull request",
			},
			{
				name: "/init",
				description: "Initialize project configuration",
			},
		];
	}

	formatSlashCommand(command: string, args?: string): string {
		return args ? `${command} ${args}` : command;
	}
}
