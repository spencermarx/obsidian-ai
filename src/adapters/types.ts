import { Readable } from "stream";

/** A single message in the agent conversation. */
export interface AgentMessage {
	role: "user" | "assistant" | "system" | "tool";
	content: string;
	/** True when this message contains the agent's internal reasoning. */
	isThinking?: boolean;
	/** Present when the agent invoked a tool. */
	toolUse?: {
		name: string;
		input: string;
		output?: string;
	};
	/** File edit applied by the agent CLI. */
	fileEdit?: {
		filePath: string;
		oldContent?: string;
		newContent: string;
		diff?: string;
	};
	/** CLI session ID — set on system init events from stream-json. */
	cliSessionId?: string;
	timestamp: number;
}

/** Vault context passed to the agent with each prompt. */
export interface VaultContext {
	vaultPath: string;
	activeFilePath?: string;
	activeFileContent?: string;
	selection?: string;
	cursorPosition?: { line: number; ch: number };
}

/** Result of building spawn arguments for a CLI invocation. */
export interface SpawnArgs {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

/** Slash command descriptor. */
export interface SlashCommand {
	name: string;
	description: string;
}

/**
 * AgentAdapter: abstracts a CLI-based agentic tool.
 *
 * Each adapter knows how to detect, spawn, and parse output from
 * a specific CLI tool.
 */
export interface AgentAdapter {
	readonly id: string;
	readonly displayName: string;
	readonly binaryName: string;

	/** Check if the CLI binary is available on the system. */
	detect(): Promise<boolean>;

	/** Get the version string of the installed CLI. */
	getVersion(): Promise<string | null>;

	/** Build the command + args to spawn a one-shot agent invocation. */
	buildSpawnArgs(opts: {
		prompt: string;
		context: VaultContext;
		cwd: string;
		editApprovalMode?: "approve" | "auto-accept";
		cliSessionId?: string;
	}): SpawnArgs;

	/**
	 * Parse the agent's stdout stream into structured messages.
	 * Yields messages as they arrive (streaming).
	 */
	parseOutputStream(stdout: Readable): AsyncIterable<AgentMessage>;

	/** Get the list of slash commands supported by this agent. */
	getSlashCommands(): SlashCommand[];

	/** Format a slash command for sending to the CLI. */
	formatSlashCommand(command: string, args?: string): string;
}
