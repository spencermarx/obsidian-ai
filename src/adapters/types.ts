import { type Readable } from "stream";

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
  /** Fully resolved slash commands reported by the CLI on session init. */
  slashCommands?: SlashCommand[];
  /** Absolute paths to images attached to a user message. */
  imagePaths?: string[];
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
  /** Data to write to the process's stdin before closing it. */
  stdinData?: string;
}

/** Slash command descriptor. */
export interface SlashCommand {
  name: string;
  description: string;
}

/** Result of executing a slash command at the adapter level. */
export interface SlashCommandResult {
  /** Whether the adapter handled this command. */
  handled: boolean;
  /** If handled, an optional prompt to send to the CLI instead. */
  prompt?: string;
  /** If handled, an optional UI action to perform (no CLI invocation). */
  action?: "clear" | "help";
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
    /** True when resuming a session that was already initialized by a prior invocation. */
    resumeSession?: boolean;
    /** Absolute paths to image files to include with the prompt. */
    imagePaths?: string[];
    /** Pre-encoded image data (base64 + MIME type), read asynchronously by the session manager. */
    imageData?: Array<{ base64: string; mimeType: string }>;
  }): SpawnArgs;

  /**
   * Parse the agent's stdout stream into structured messages.
   * Yields messages as they arrive (streaming).
   */
  parseOutputStream(stdout: Readable): AsyncIterable<AgentMessage>;

  /**
   * Get the hardcoded baseline list of slash commands.
   * Same as `getBuiltinSlashCommands` but async for interface consistency.
   */
  getSlashCommands(): Promise<SlashCommand[]>;

  /**
   * Spawn a short-lived probe process to discover the full set of
   * slash commands available for a given working directory. Returns
   * enriched commands with descriptions where available, or `null`
   * if the adapter doesn't support probing.
   */
  discoverSlashCommands(cwd: string): Promise<SlashCommand[] | null>;

  /**
   * Synchronous fallback returning just the hardcoded built-in commands.
   * Used by the UI to render an immediate baseline before async discovery
   * completes.
   */
  getBuiltinSlashCommands(): SlashCommand[];

  /**
   * Execute a built-in slash command. Returns whether the command was
   * handled and, if so, either a translated prompt to send to the CLI
   * or a UI action to perform locally.
   */
  executeSlashCommand(
    command: string,
    args: string,
  ): Promise<SlashCommandResult>;
}
