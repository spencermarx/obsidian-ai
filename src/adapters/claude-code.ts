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
 *
 * Handles the full event vocabulary including thinking/reasoning blocks,
 * text content, tool use, and result summaries.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
	readonly id = "claude-code";
	readonly displayName = "Claude Code";
	readonly binaryName = "claude";

	/**
	 * Tracks the type of the content block currently being streamed.
	 * Claude Code emits content_block_start → content_block_delta* →
	 * content_block_stop for each block. The block type tells us whether
	 * the deltas are thinking or text.
	 */
	private currentBlockType: "thinking" | "text" | null = null;

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
				"--include-partial-messages",
				"--allowedTools",
				"Read,Glob,Grep,Write,Edit,NotebookEdit,WebSearch,WebFetch,Bash",
				"-p",
				fullPrompt,
			],
		};
	}

	async *parseOutputStream(stdout: Readable): AsyncIterable<AgentMessage> {
		let buffer = "";
		let chunkCount = 0;
		let lineCount = 0;
		let yieldCount = 0;
		// Reset block state for each new invocation
		this.currentBlockType = null;

		for await (const chunk of stdout) {
			chunkCount++;
			const raw = chunk.toString();
			// [PIPE-2] Log raw stdout data (first 3 chunks fully, then just sizes)
			if (chunkCount <= 3) {
				console.log(
					`[agentic-copilot][PIPE-2] stdout chunk #${chunkCount} (${raw.length} bytes):`,
					raw.slice(0, 300)
				);
			} else if (chunkCount % 50 === 0) {
				console.log(
					`[agentic-copilot][PIPE-2] stdout chunk #${chunkCount} (${raw.length} bytes)`
				);
			}

			buffer += raw;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				lineCount++;

				let event: Record<string, unknown>;
				try {
					event = JSON.parse(trimmed);
				} catch {
					// [PIPE-3] Non-JSON line
					console.log(
						`[agentic-copilot][PIPE-3] non-JSON line #${lineCount}:`,
						trimmed.slice(0, 150)
					);
					yieldCount++;
					yield {
						role: "assistant" as const,
						content: trimmed,
						timestamp: Date.now(),
					};
					continue;
				}

				// [PIPE-3] Log the event type
				const evtType = (event.type as string) || "unknown";
				const innerType =
					evtType === "stream_event"
						? (
								event.event as Record<string, unknown>
							)?.type || "?"
						: "";
				if (lineCount <= 10 || lineCount % 20 === 0) {
					console.log(
						`[agentic-copilot][PIPE-3] JSON line #${lineCount}: type=${evtType}${innerType ? ` inner=${innerType}` : ""}`
					);
				}

				// parseEvent is wrapped in its own try/catch so a single
				// malformed event never kills the entire stream.
				try {
					const messages = this.parseEvent(event);
					// [PIPE-4] Log parseEvent results
					for (const msg of messages) {
						yieldCount++;
						if (yieldCount <= 5 || yieldCount % 20 === 0) {
							console.log(
								`[agentic-copilot][PIPE-4] yield #${yieldCount}: role=${msg.role} thinking=${!!msg.isThinking} len=${msg.content.length}`
							);
						}
						yield msg;
					}
				} catch (err) {
					console.error(
						"[agentic-copilot][PIPE-4] parseEvent error:",
						err,
						"event:",
						JSON.stringify(event).slice(0, 200)
					);
				}
			}
		}

		console.log(
			`[agentic-copilot][PIPE-2] stdout ended: ${chunkCount} chunks, ${lineCount} lines, ${yieldCount} messages yielded`
		);

		// Flush remaining buffer
		if (buffer.trim()) {
			try {
				const event = JSON.parse(buffer.trim());
				const messages = this.parseEvent(event);
				for (const msg of messages) {
					yield msg;
				}
			} catch {
				yield {
					role: "assistant",
					content: buffer.trim(),
					timestamp: Date.now(),
				};
			}
		}
	}

	/**
	 * Parse a single stream-json event into zero or more AgentMessages.
	 *
	 * Claude Code wraps most events in a `stream_event` envelope:
	 *   { "type": "stream_event", "event": { ... actual event ... } }
	 *
	 * Inner event types:
	 *   - content_block_start  → signals a new thinking or text block
	 *   - content_block_delta  → incremental text/thinking content
	 *   - content_block_stop   → end of current block
	 *   - message_start/stop   → message lifecycle (ignored)
	 *   - message_delta        → stop_reason etc. (ignored)
	 *
	 * Top-level (non-wrapped) event types:
	 *   - assistant / text     → full assistant message content
	 *   - tool_use / tool_result → tool invocation events
	 *   - result               → final result summary
	 */
	private parseEvent(event: Record<string, unknown>): AgentMessage[] {
		const type = event.type as string | undefined;

		// ---- Unwrap the stream_event envelope if present
		if (type === "stream_event") {
			const inner = event.event as Record<string, unknown> | undefined;
			if (inner) {
				return this.parseEvent(inner);
			}
			return [];
		}

		// ---- Block lifecycle: track whether we're in a thinking or text block
		if (type === "content_block_start") {
			const block = event.content_block as
				| Record<string, unknown>
				| undefined;
			const blockType = block?.type as string | undefined;
			if (blockType === "thinking") {
				this.currentBlockType = "thinking";
			} else if (blockType === "tool_use") {
				this.currentBlockType = null;
				// Emit the tool_use start as a tool message
				const name = (block?.name as string) || "tool";
				return [
					{
						role: "tool" as const,
						content: `Tool: ${name}`,
						toolUse: {
							name,
							input: "",
						},
						timestamp: Date.now(),
					},
				];
			} else {
				this.currentBlockType = "text";
			}
			// content_block_start sometimes includes initial content
			const initialThinking = block?.thinking as string | undefined;
			if (initialThinking) {
				return [
					{
						role: "assistant",
						content: initialThinking,
						isThinking: true,
						timestamp: Date.now(),
					},
				];
			}
			const initialText = block?.text as string | undefined;
			if (initialText) {
				return [
					{
						role: "assistant",
						content: initialText,
						timestamp: Date.now(),
					},
				];
			}
			return [];
		}

		if (type === "content_block_stop") {
			this.currentBlockType = null;
			return [];
		}

		// ---- Content deltas: use block type to determine thinking vs text
		if (type === "content_block_delta") {
			const delta = event.delta as Record<string, unknown> | undefined;
			if (!delta) return [];

			const deltaType = delta.type as string | undefined;

			// Signature deltas (end-of-thinking verification) — ignore
			if (deltaType === "signature_delta") return [];

			// Input JSON deltas (tool input streaming) — ignore for now,
			// the complete tool_use event will be handled separately
			if (deltaType === "input_json_delta") return [];

			// Thinking delta
			if (
				deltaType === "thinking_delta" ||
				this.currentBlockType === "thinking"
			) {
				const thinking = (delta.thinking as string) || "";
				if (!thinking) return [];
				return [
					{
						role: "assistant",
						content: thinking,
						isThinking: true,
						timestamp: Date.now(),
					},
				];
			}

			// Text delta
			const text = (delta.text as string) || "";
			if (!text) return [];
			return [
				{
					role: "assistant",
					content: text,
					timestamp: Date.now(),
				},
			];
		}

		// ---- Message lifecycle events — ignored
		if (
			type === "message_start" ||
			type === "message_stop" ||
			type === "message_delta"
		) {
			return [];
		}

		// ---- Full assistant messages (non-streaming or message wrappers)
		if (type === "assistant" || type === "text") {
			const message = event.message as
				| Record<string, unknown>
				| undefined;

			// The message.content may be an array of content blocks
			const rawContent = message?.content ?? event.content;
			if (Array.isArray(rawContent)) {
				return this.parseContentArray(rawContent);
			}

			const content = (rawContent as string) || "";
			if (!content) return [];
			return [
				{
					role: "assistant",
					content,
					timestamp: Date.now(),
				},
			];
		}

		// ---- Tool use / tool result
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

			const msg: AgentMessage = {
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
					msg.fileEdit = {
						filePath,
						newContent,
						oldContent: parsedInput.old_string as
							| string
							| undefined,
					};
				}
			}

			return [msg];
		}

		// ---- Result summary
		if (type === "result") {
			const result = (event.result as string) || "";
			if (result) {
				return [
					{
						role: "assistant",
						content: result,
						timestamp: Date.now(),
					},
				];
			}
		}

		return [];
	}

	/**
	 * Parse an array of content blocks (from assistant message wrappers).
	 * Each element may be { type: "thinking", thinking: "..." } or
	 * { type: "text", text: "..." }.
	 */
	private parseContentArray(
		blocks: Array<Record<string, unknown>>
	): AgentMessage[] {
		const messages: AgentMessage[] = [];
		for (const block of blocks) {
			const blockType = block.type as string | undefined;
			if (blockType === "thinking") {
				const thinking = (block.thinking as string) || "";
				if (thinking) {
					messages.push({
						role: "assistant",
						content: thinking,
						isThinking: true,
						timestamp: Date.now(),
					});
				}
			} else if (blockType === "text") {
				const text = (block.text as string) || "";
				if (text) {
					messages.push({
						role: "assistant",
						content: text,
						timestamp: Date.now(),
					});
				}
			}
		}
		return messages;
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
