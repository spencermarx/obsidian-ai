export const CHAT_VIEW_TYPE = "agentic-copilot-chat";

export const PLUGIN_ID = "agentic-copilot";

export const KNOWN_AGENTS = ["claude-code", "opencode", "gemini-cli", "aider"] as const;
export type KnownAgentId = (typeof KNOWN_AGENTS)[number];

export interface AgenticCopilotSettings {
	/** Which agent adapter to use. 'auto' means first detected. */
	selectedAgent: string;
	/** Override binary path (empty = use PATH) */
	customBinaryPath: string;
	/** Extra CLI arguments appended to every invocation */
	customArgs: string;
	/** Working directory: 'vault' = vault root, 'file' = active file's directory */
	workingDirectory: "vault" | "file";
	/** Include active file content in context automatically */
	includeActiveFile: boolean;
	/** Include current selection in context automatically */
	includeSelection: boolean;
	/** Maximum number of concurrent sessions */
	maxSessions: number;
	/** Edit approval mode: 'approve' shows Accept/Reject buttons, 'auto-accept' applies automatically */
	editApprovalMode: "approve" | "auto-accept";
}

export const DEFAULT_SETTINGS: AgenticCopilotSettings = {
	selectedAgent: "auto",
	customBinaryPath: "",
	customArgs: "",
	workingDirectory: "vault",
	includeActiveFile: true,
	includeSelection: true,
	maxSessions: 5,
	editApprovalMode: "approve",
};
