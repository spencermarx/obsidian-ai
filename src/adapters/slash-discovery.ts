import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { SlashCommand } from "./types";

/**
 * Filesystem-based discovery of slash commands provided as markdown files.
 *
 * Used by CLI adapters (Claude Code, Opencode) to surface user-defined and
 * project-level commands alongside their built-in baseline — so anything the
 * user has installed or written locally shows up automatically in the `/`
 * menu with zero configuration.
 */

export interface DiscoveryDir {
	/** Absolute path to scan. Non-existent dirs are silently skipped. */
	path: string;
	source: NonNullable<SlashCommand["source"]>;
}

interface CacheEntry {
	/** Newest mtime (ms) observed in the directory at last scan. */
	newestMtime: number;
	commands: SlashCommand[];
}

// Module-level cache shared across all ChatView instances.
const dirCache = new Map<string, CacheEntry>();

/**
 * Expand a leading `~` to the user's home directory.
 */
export function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/**
 * Walk each directory recursively for `.md` files and return merged slash
 * commands. Later entries in `dirs` win on name collisions — pass the list
 * in precedence order (low → high).
 */
export async function discoverMarkdownCommands(
	dirs: DiscoveryDir[]
): Promise<SlashCommand[]> {
	const merged = new Map<string, SlashCommand>();

	for (const dir of dirs) {
		const commands = await scanDir(dir);
		for (const cmd of commands) {
			merged.set(cmd.name, cmd);
		}
	}

	return Array.from(merged.values()).sort((a, b) =>
		a.name.localeCompare(b.name)
	);
}

/**
 * Find every immediate subdirectory whose name matches and contains a
 * `commands` subfolder. Used for scanning plugin bundles like
 * `~/.claude/plugins/<plugin>/commands/`.
 */
export async function findPluginCommandDirs(
	pluginsRoot: string,
	commandsSubdir = "commands"
): Promise<string[]> {
	const expanded = expandHome(pluginsRoot);
	try {
		const entries = await fs.readdir(expanded, { withFileTypes: true });
		const result: string[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const commandsDir = path.join(
				expanded,
				entry.name,
				commandsSubdir
			);
			try {
				const stat = await fs.stat(commandsDir);
				if (stat.isDirectory()) result.push(commandsDir);
			} catch {
				// No commands subdir — skip.
			}
		}
		return result;
	} catch {
		return [];
	}
}

async function scanDir(dir: DiscoveryDir): Promise<SlashCommand[]> {
	const absPath = expandHome(dir.path);

	// Check cache via newest mtime in the tree.
	const newestMtime = await newestMtimeInTree(absPath);
	if (newestMtime === null) {
		dirCache.delete(absPath);
		return [];
	}

	const cached = dirCache.get(absPath);
	if (cached && cached.newestMtime === newestMtime) {
		// Rebind source in case the same dir is used with a different label.
		return cached.commands.map((c) => ({ ...c, source: dir.source }));
	}

	const commands: SlashCommand[] = [];
	await walk(absPath, absPath, async (filePath, relPath) => {
		if (!filePath.endsWith(".md")) return;
		const base = path.basename(filePath, ".md");
		if (base.startsWith(".")) return;

		// Build the command name from the relative path. Subdirectories
		// become namespaces separated by `:` to match Claude Code's
		// convention (e.g. `frontend/component.md` → `/frontend:component`).
		const relNoExt = relPath.slice(0, -3);
		const segments = relNoExt.split(path.sep).filter(Boolean);
		if (segments.some((s) => s.startsWith("."))) return;
		const name = "/" + segments.join(":");

		let description = "";
		try {
			const content = await fs.readFile(filePath, "utf8");
			description = extractDescription(content);
		} catch {
			// Unreadable — skip description.
		}

		commands.push({
			name,
			description: description || "Custom command",
			source: dir.source,
		});
	});

	commands.sort((a, b) => a.name.localeCompare(b.name));
	dirCache.set(absPath, { newestMtime, commands });
	return commands;
}

/**
 * Return the newest mtime (ms) found in the tree rooted at `root`, or `null`
 * if the root doesn't exist. Used as a cheap cache key — any file add,
 * remove, or edit bumps the number.
 */
async function newestMtimeInTree(root: string): Promise<number | null> {
	let newest = 0;
	let exists = false;

	async function visit(dir: string): Promise<void> {
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		exists = true;
		try {
			const stat = await fs.stat(dir);
			if (stat.mtimeMs > newest) newest = stat.mtimeMs;
		} catch {
			// ignore
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await visit(full);
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				try {
					const stat = await fs.stat(full);
					if (stat.mtimeMs > newest) newest = stat.mtimeMs;
				} catch {
					// ignore
				}
			}
		}
	}

	await visit(root);
	return exists ? newest : null;
}

async function walk(
	root: string,
	current: string,
	visit: (filePath: string, relPath: string) => Promise<void>
): Promise<void> {
	let entries;
	try {
		entries = await fs.readdir(current, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const full = path.join(current, entry.name);
		if (entry.isDirectory()) {
			await walk(root, full, visit);
		} else if (entry.isFile()) {
			const rel = path.relative(root, full);
			await visit(full, rel);
		}
	}
}

/**
 * Pull a description out of a markdown command file. Looks for a YAML
 * frontmatter block with a `description:` key first, then falls back to the
 * first non-empty markdown line (with leading `#` stripped).
 */
export function extractDescription(content: string): string {
	const frontmatter = parseFrontmatter(content);
	if (frontmatter) {
		const desc = frontmatter["description"];
		if (desc) return desc;
	}

	// Strip frontmatter if present, then take the first non-empty line.
	let body = content;
	if (content.startsWith("---")) {
		const end = content.indexOf("\n---", 3);
		if (end !== -1) {
			const afterClose = content.indexOf("\n", end + 4);
			body = afterClose === -1 ? "" : content.slice(afterClose + 1);
		}
	}

	for (const rawLine of body.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const cleaned = line.replace(/^#+\s*/, "").trim();
		if (!cleaned) continue;
		return truncate(cleaned, 80);
	}
	return "";
}

/**
 * Minimal YAML frontmatter parser — only handles flat `key: value` pairs,
 * which is all command files typically need. Avoids pulling in a dependency.
 */
function parseFrontmatter(content: string): Record<string, string> | null {
	if (!content.startsWith("---")) return null;
	const end = content.indexOf("\n---", 3);
	if (end === -1) return null;
	const block = content.slice(3, end);
	const result: Record<string, string> = {};
	for (const rawLine of block.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		let value = line.slice(colon + 1).trim();
		// Strip surrounding quotes if present.
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key) result[key] = value;
	}
	return result;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1).trimEnd() + "…";
}
