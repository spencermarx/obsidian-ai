import { App, MarkdownView } from "obsidian";
import { VaultContext } from "../adapters/types";

/**
 * Gather the current vault context: active file, selection, vault path.
 */
export function getVaultContext(app: App): VaultContext {
	const adapter = app.vault.adapter as { getBasePath?: () => string };
	const vaultPath =
		typeof adapter.getBasePath === "function"
			? adapter.getBasePath()
			: "";

	const context: VaultContext = { vaultPath };

	const activeView = app.workspace.getActiveViewOfType(MarkdownView);
	if (!activeView) return context;

	const file = activeView.file;
	if (file) {
		context.activeFilePath = file.path;
	}

	const editor = activeView.editor;
	if (editor) {
		const selection = editor.getSelection();
		if (selection) {
			context.selection = selection;
		}

		const cursor = editor.getCursor();
		context.cursorPosition = { line: cursor.line, ch: cursor.ch };

		// Get the full document content for file context
		context.activeFileContent = editor.getValue();
	}

	return context;
}

/**
 * Format vault context into a system prompt prefix.
 */
export function formatContextForPrompt(
	context: VaultContext,
	opts: { includeFile: boolean; includeSelection: boolean }
): string {
	const parts: string[] = [];

	parts.push(`Working directory: ${context.vaultPath}`);

	if (opts.includeFile && context.activeFilePath) {
		parts.push(`Active file: ${context.activeFilePath}`);
		if (context.activeFileContent) {
			parts.push(
				`\nFile content:\n\`\`\`\n${context.activeFileContent}\n\`\`\``
			);
		}
	}

	if (opts.includeSelection && context.selection) {
		parts.push(`\nSelected text:\n\`\`\`\n${context.selection}\n\`\`\``);
	}

	return parts.join("\n");
}
