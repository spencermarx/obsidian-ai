import { Readable } from "stream";
import { spawn as nodeSpawn } from "child_process";
import { promises as fsPromises } from "fs";
import * as nodePath from "path";
import * as os from "os";
import {
	AgentAdapter,
	AgentMessage,
	SlashCommand,
	SlashCommandResult,
	SpawnArgs,
	VaultContext,
} from "./types";
import { whichBinary, execCommand, getExpandedPath } from "../utils/platform";
import { formatContextForPrompt } from "../utils/vault-context";

/**
 * Built-in slash commands shipped with the Claude Code CLI. The CLI does not
 * expose a programmatic `--list-commands` flag, so this baseline is
 * maintained manually; discovered user/project/plugin commands are merged on
 * top and override on name collisions.
 */
const CLAUDE_CODE_BUILTINS: SlashCommand[] = [
	{ name: "/agents", description: "Manage custom sub-agents" },
	{ name: "/bug", description: "Report a bug to Anthropic" },
	{ name: "/clear", description: "Clear conversation history" },
	{
		name: "/compact",
		description: "Compact conversation to save context",
	},
	{ name: "/config", description: "View or edit Claude Code settings" },
	{ name: "/cost", description: "Show token usage and session cost" },
	{ name: "/doctor", description: "Diagnose your Claude Code install" },
	{ name: "/export", description: "Export the current conversation" },
	{ name: "/help", description: "Show available commands and usage" },
	{ name: "/hooks", description: "Manage lifecycle hooks" },
	{ name: "/ide", description: "Connect to an IDE integration" },
	{ name: "/init", description: "Initialize CLAUDE.md for this project" },
	{ name: "/login", description: "Sign in to your Anthropic account" },
	{ name: "/logout", description: "Sign out of your Anthropic account" },
	{ name: "/mcp", description: "Manage MCP servers and connections" },
	{ name: "/memory", description: "View or edit Claude's memory files" },
	{ name: "/model", description: "Switch the active model" },
	{ name: "/permissions", description: "Manage tool permissions" },
	{
		name: "/pr-comments",
		description: "Review GitHub PR comments in-context",
	},
	{ name: "/release-notes", description: "Show Claude Code release notes" },
	{ name: "/resume", description: "Resume a previous conversation" },
	{ name: "/review", description: "Review recent code changes" },
	{ name: "/status", description: "Show account and system status" },
	{
		name: "/terminal-setup",
		description: "Configure terminal key bindings",
	},
	{ name: "/vim", description: "Toggle vim-style input mode" },
];

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
	private currentBlockType: "thinking" | "text" | "tool_use" | null = null;
	private currentToolName: string | null = null;
	private currentToolInput = "";

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
		editApprovalMode?: "approve" | "auto-accept";
		cliSessionId?: string;
		resumeSession?: boolean;
		imagePaths?: string[];
	}): SpawnArgs {
		const contextStr = formatContextForPrompt(opts.context, {
			includeFile: true,
			includeSelection: true,
		});

		const fullPrompt = contextStr
			? `${contextStr}\n\n${opts.prompt}`
			: opts.prompt;

		// Always include ALL tools in --allowedTools. Excluding tools causes
		// the CLI to error in -p mode (non-interactive), not gracefully degrade.
		// The editApprovalMode setting controls the plugin UI only (Keep/Revert
		// buttons vs silent "Applied" badge) — the CLI always writes directly.
		const allowedTools =
			"Read,Glob,Grep,Write,Edit,NotebookEdit,WebSearch,WebFetch,Bash";

		const args = [
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--allowedTools",
			allowedTools,
		];

		// Session persistence for multi-turn conversations.
		// First invocation: --session-id creates the session.
		// Subsequent invocations: --resume continues the existing session.
		if (opts.cliSessionId) {
			if (opts.resumeSession) {
				args.push("--resume", opts.cliSessionId);
			} else {
				args.push("--session-id", opts.cliSessionId);
			}
		}

		args.push("-p", fullPrompt);

		// Append image file paths as positional args after the prompt.
		// Claude Code CLI accepts image paths as trailing arguments in -p mode.
		if (opts.imagePaths?.length) {
			args.push(...opts.imagePaths);
		}

		return {
			command: this.binaryName,
			args,
		};
	}

	async *parseOutputStream(stdout: Readable): AsyncIterable<AgentMessage> {
		let buffer = "";
		let chunkCount = 0;
		let lineCount = 0;
		let yieldCount = 0;
		// Reset all streaming state for each new invocation
		this.currentBlockType = null;
		this.currentToolName = null;
		this.currentToolInput = "";

		for await (const chunk of stdout) {
			chunkCount++;
			const raw = chunk.toString();
			// [PIPE-2] Log raw stdout data (first 3 chunks fully, then just sizes)
			if (chunkCount <= 3) {
				console.debug(
					`[agentic-copilot][PIPE-2] stdout chunk #${chunkCount} (${raw.length} bytes):`,
					raw.slice(0, 300)
				);
			} else if (chunkCount % 50 === 0) {
				console.debug(
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
					console.debug(
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
				let innerType = "";
				if (evtType === "stream_event") {
					const innerEvt = event.event as Record<string, unknown> | undefined;
					innerType = typeof innerEvt?.type === "string" ? innerEvt.type : "?";
				}
				if (lineCount <= 10 || lineCount % 20 === 0) {
					console.debug(
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
							console.debug(
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

		console.debug(
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
				this.currentBlockType = "tool_use";
				this.currentToolName = (block?.name as string) || "tool";
				this.currentToolInput = "";
				return [];
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
			// If we just finished a tool_use block, emit it now with
			// the accumulated input (file paths, patterns, etc.)
			if (this.currentBlockType === "tool_use" && this.currentToolName) {
				const name = this.currentToolName;
				const input = this.currentToolInput;
				this.currentBlockType = null;
				this.currentToolName = null;
				this.currentToolInput = "";

				const msg: AgentMessage = {
					role: "tool",
					content: `Tool: ${name}`,
					toolUse: { name, input },
					timestamp: Date.now(),
				};

				// Detect file edits
				if (/^(Write|Edit|write|edit)$/.test(name)) {
					try {
						const parsed = JSON.parse(input);
						const filePath = parsed.file_path || parsed.path || "";
						if (filePath) {
							msg.fileEdit = {
								filePath,
								newContent: parsed.content || parsed.new_string || "",
								oldContent: parsed.old_string,
							};
						}
					} catch { /* input may not be valid JSON */ }
				}

				return [msg];
			}
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

			// Input JSON deltas — accumulate for the tool_use block
			if (deltaType === "input_json_delta") {
				const partial = (delta.partial_json as string) || "";
				this.currentToolInput += partial;
				return [];
			}

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

		// ---- System init event — contains the real CLI session_id
		// and the full list of available slash commands.
		if (type === "system") {
			const sessionId = event.session_id as string | undefined;
			const rawNames = event.slash_commands as string[] | undefined;

			// Build enriched SlashCommand objects with baseline descriptions.
			let resolved: SlashCommand[] | undefined;
			if (rawNames) {
				const builtinMap = new Map<string, string>();
				for (const cmd of CLAUDE_CODE_BUILTINS) {
					builtinMap.set(cmd.name, cmd.description);
				}
				resolved = rawNames.map((raw) => {
					const name = raw.startsWith("/") ? raw : `/${raw}`;
					return {
						name,
						description: builtinMap.get(name) || "",
					};
				});
				resolved.sort((a, b) => a.name.localeCompare(b.name));
			}

			if (sessionId || resolved) {
				return [
					{
						role: "system",
						content: "",
						cliSessionId: sessionId,
						slashCommands: resolved,
						timestamp: Date.now(),
					},
				];
			}
			return [];
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
		// In stream-json mode these are redundant summaries of content
		// already delivered via content_block_delta events. Emitting them
		// would double the text in the MessageQueue buffer.  Skip them.
		if (type === "assistant" || type === "text") {
			return [];
		}

		// ---- Tool use / tool result
		// In stream-json mode, tool_use is already emitted from
		// content_block_stop with accumulated input.  These top-level
		// events are redundant summaries — skip them.
		if (type === "tool_use" || type === "tool_result") {
			return [];
		}

		// ---- Result summary
		// The result event contains the full final text, but we've already
		// streamed all content via content_block_delta events. Only extract
		// the session_id — emitting the text again would duplicate it.
		if (type === "result") {
			const sessionId = event.session_id as string | undefined;
			if (sessionId) {
				return [
					{
						role: "system",
						content: "",
						cliSessionId: sessionId,
						timestamp: Date.now(),
					},
				];
			}
			return [];
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

	getBuiltinSlashCommands(): SlashCommand[] {
		return [...CLAUDE_CODE_BUILTINS];
	}

	getSlashCommands(): Promise<SlashCommand[]> {
		return Promise.resolve(this.getBuiltinSlashCommands());
	}

	async discoverSlashCommands(
		cwd: string
	): Promise<SlashCommand[] | null> {
		const initEvent = await this.probeInitEvent(cwd);
		if (!initEvent) return null;

		const names = (initEvent.slash_commands as string[] | undefined) ?? [];
		const plugins =
			(initEvent.plugins as
				| Array<{ name: string; path: string }>
				| undefined) ?? [];

		// Build description lookup from the hardcoded baseline.
		const builtinMap = new Map<string, string>();
		for (const cmd of CLAUDE_CODE_BUILTINS) {
			builtinMap.set(cmd.name, cmd.description);
		}

		// Build commands with baseline descriptions.
		const commands: SlashCommand[] = names.map((raw) => {
			const name = raw.startsWith("/") ? raw : `/${raw}`;
			return { name, description: builtinMap.get(name) || "" };
		});
		commands.sort((a, b) => a.name.localeCompare(b.name));

		// Enrich descriptions from markdown source files.
		await this.enrichDescriptions(commands, cwd, plugins);

		return commands;
	}

	/**
	 * Spawn a throwaway process to capture the CLI's system init event.
	 * Killed as soon as the event is received.
	 */
	private async probeInitEvent(
		cwd: string
	): Promise<Record<string, unknown> | null> {
		const binary = await whichBinary(this.binaryName);
		if (!binary) return null;

		return new Promise((resolve) => {
			let done = false;
			const finish = (
				value: Record<string, unknown> | null
			): void => {
				if (done) return;
				done = true;
				clearTimeout(timeout);
				resolve(value);
			};

			let proc: ReturnType<typeof nodeSpawn>;
			try {
				proc = nodeSpawn(
					binary,
					[
						"-p",
						"respond with only the word PONG",
						"--output-format",
						"stream-json",
						"--verbose",
						"--no-session-persistence",
						"--max-budget-usd",
						"0.01",
					],
					{
						cwd,
						env: {
							...process.env,
							PATH: getExpandedPath(),
						},
						stdio: ["pipe", "pipe", "ignore"],
					}
				);
			} catch {
				resolve(null);
				return;
			}

			const timeout = setTimeout(() => {
				proc.kill();
				finish(null);
			}, 10_000);

			if (proc.stdin) proc.stdin.end();

			let buffer = "";
			proc.stdout?.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					try {
						const event = JSON.parse(trimmed);
						if (
							event.type === "system" &&
							Array.isArray(event.slash_commands)
						) {
							proc.kill();
							finish(event);
							return;
						}
					} catch {
						// Not JSON yet.
					}
				}
			});

			proc.on("error", () => finish(null));
			proc.on("close", () => finish(null));
		});
	}

	/**
	 * Read frontmatter `description:` from markdown command/skill files
	 * for commands that don't yet have a description.
	 *
	 * Checks (in order): user commands, user skills, ancestor project
	 * commands/skills, and plugin skills.
	 */
	private async enrichDescriptions(
		commands: SlashCommand[],
		cwd: string,
		plugins: Array<{ name: string; path: string }>
	): Promise<void> {
		const needsDesc = commands.filter((c) => !c.description);
		if (needsDesc.length === 0) return;

		const home = os.homedir();

		// Collect ancestor directories from cwd up (excluding home).
		const ancestors: string[] = [];
		let dir = nodePath.resolve(cwd);
		while (dir !== home && dir !== nodePath.dirname(dir)) {
			ancestors.push(dir);
			dir = nodePath.dirname(dir);
		}

		// Search roots: home first (lowest priority), then ancestors
		// from most distant to closest (closest wins).
		const searchRoots = [home, ...ancestors.reverse()];

		// Plugin lookup: plugin-name → install path.
		const pluginPaths = new Map<string, string>();
		for (const p of plugins) {
			pluginPaths.set(p.name, p.path);
		}

		for (const cmd of needsDesc) {
			const name = cmd.name.slice(1); // strip leading /
			const colonIdx = name.indexOf(":");

			let desc: string | null = null;

			if (colonIdx !== -1) {
				// Namespaced: e.g. "posthog:search" → plugin skill
				const prefix = name.slice(0, colonIdx);
				const skillName = name.slice(colonIdx + 1);
				const pluginPath = pluginPaths.get(prefix);
				if (pluginPath) {
					desc = await readFrontmatterDesc(
						nodePath.join(
							pluginPath,
							"skills",
							skillName,
							"SKILL.md"
						)
					);
				}
			} else {
				// Non-namespaced: check commands/ and skills/ in each root.
				for (const root of searchRoots) {
					desc = await readFrontmatterDesc(
						nodePath.join(
							root,
							".claude",
							"commands",
							`${name}.md`
						)
					);
					if (desc) break;
					desc = await readFrontmatterDesc(
						nodePath.join(
							root,
							".claude",
							"skills",
							name,
							"SKILL.md"
						)
					);
					if (desc) break;
				}
			}

			if (desc) cmd.description = desc;
		}
	}

	executeSlashCommand(
		command: string,
		args: string
	): Promise<SlashCommandResult> {
		// Plugin-level actions — handled entirely in the UI, no CLI call.
		switch (command) {
			case "/clear":
				return Promise.resolve({ handled: true, action: "clear" });
			case "/help":
				return Promise.resolve({ handled: true, action: "help" });
		}

		// Built-in commands that map to natural-language prompts.
		// Claude Code only processes these in interactive/TTY mode, so we
		// translate them into prompts that achieve the same result via -p.
		const promptMap: Record<string, string> = {
			"/compact":
				"Please compact and summarize our conversation so far to save context.",
			"/commit":
				"Commit the currently staged git changes with an appropriate commit message.",
			"/review-pr":
				"Review the current pull request and provide detailed feedback.",
			"/create-pr":
				"Create a new pull request for the current branch with a clear title and description.",
			"/review":
				"Review the recent code changes and provide feedback.",
			"/pr-comments":
				"Review the GitHub pull request comments in context and address them.",
			"/cost":
				"Show the token usage and cost for this session so far.",
			"/init":
				"Initialize a CLAUDE.md project configuration file for this project.",
		};

		const mapped = promptMap[command];
		if (mapped) {
			const prompt = args ? `${mapped} ${args}` : mapped;
			return Promise.resolve({ handled: true, prompt });
		}

		// Unrecognized built-in — not handled, caller sends as-is.
		return Promise.resolve({ handled: false });
	}
}

/**
 * Read just the `description:` value from a markdown file's YAML
 * frontmatter. Returns `null` if the file doesn't exist or has no
 * description. Reads only the first 4KB to keep it fast.
 */
async function readFrontmatterDesc(
	filePath: string
): Promise<string | null> {
	try {
		const fd = await fsPromises.open(filePath, "r");
		try {
			const buf = Buffer.alloc(4096);
			const { bytesRead } = await fd.read(buf, 0, 4096, 0);
			const head = buf.toString("utf8", 0, bytesRead);

			if (!head.startsWith("---")) return null;
			const end = head.indexOf("\n---", 3);
			if (end === -1) return null;
			const block = head.slice(3, end);

			const lines = block.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i].trim();
				if (!line.startsWith("description:")) continue;
				let val = line.slice(12).trim();
				// Strip surrounding quotes
				if (
					(val.startsWith("'") && val.endsWith("'")) ||
					(val.startsWith('"') && val.endsWith('"'))
				) {
					val = val.slice(1, -1);
				}
				// Handle multi-line YAML block scalars (`>` or `|`).
				// Collect all subsequent indented continuation lines.
				if (val === ">" || val === "|") {
					const parts: string[] = [];
					for (let j = i + 1; j < lines.length; j++) {
						const cont = lines[j];
						// Continuation lines are indented; a non-indented
						// line (or a new key) ends the block.
						if (
							!cont.startsWith(" ") &&
							!cont.startsWith("\t")
						)
							break;
						const trimmed = cont.trim();
						if (trimmed) parts.push(trimmed);
					}
					val = parts.join(" ");
				}
				return val || null;
			}
		} finally {
			await fd.close();
		}
	} catch {
		// File doesn't exist or unreadable.
	}
	return null;
}
