import { type App, MarkdownView, type WorkspaceLeaf } from "obsidian";
import { type VaultContext } from "../adapters/types";

/**
 * Find the most relevant MarkdownView, even when focus is in the sidebar.
 *
 * When the user is typing in the chat panel (a sidebar leaf),
 * `getActiveViewOfType(MarkdownView)` returns null. We fall back to
 * finding the MarkdownView whose file matches `getActiveFile()`, or
 * the most recently active MarkdownView in the root split.
 */
function findMarkdownView(app: App): MarkdownView | null {
  // Fast path: if the active view IS a MarkdownView, use it
  const active = app.workspace.getActiveViewOfType(MarkdownView);
  if (active) return active;

  // The user is focused elsewhere (e.g. sidebar chat).
  // Find the MarkdownView for the currently "active" file.
  const activeFile = app.workspace.getActiveFile();

  let fallback: MarkdownView | null = null;

  app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
    if (!(leaf.view instanceof MarkdownView)) return;
    const view = leaf.view;

    // Prefer the leaf whose file matches the active file
    if (activeFile && view.file?.path === activeFile.path) {
      fallback = view;
      return;
    }

    // Otherwise, keep the first MarkdownView we find as a fallback
    if (!fallback) {
      fallback = view;
    }
  });

  return fallback;
}

/**
 * Gather the current vault context: active file, selection, vault path.
 *
 * Works reliably even when the user is focused in the sidebar chat panel
 * rather than the editor pane.
 */
export function getVaultContext(app: App): VaultContext {
  const adapter = app.vault.adapter as { getBasePath?: () => string };
  const vaultPath =
    typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";

  const context: VaultContext = { vaultPath };

  const view = findMarkdownView(app);
  if (!view) return context;

  const file = view.file;
  if (file) {
    context.activeFilePath = file.path;
  }

  const editor = view.editor;
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
  opts: { includeFile: boolean; includeSelection: boolean },
): string {
  const parts: string[] = [];

  parts.push(`Working directory: ${context.vaultPath}`);

  if (opts.includeFile && context.activeFilePath) {
    parts.push(`Active file: ${context.activeFilePath}`);
    if (context.activeFileContent) {
      parts.push(
        `\nFile content:\n\`\`\`\n${context.activeFileContent}\n\`\`\``,
      );
    }
  }

  if (opts.includeSelection && context.selection) {
    parts.push(`\nSelected text:\n\`\`\`\n${context.selection}\n\`\`\``);
  }

  return parts.join("\n");
}
