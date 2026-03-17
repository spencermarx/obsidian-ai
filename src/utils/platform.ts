import { exec } from "child_process";
import { platform, homedir } from "os";
import { join } from "path";

/** Detect current platform. */
export function isWindows(): boolean {
	return platform() === "win32";
}

/** Get the shell executable for the current platform. */
export function getShell(): string {
	if (isWindows()) {
		return process.env.COMSPEC || "cmd.exe";
	}
	return process.env.SHELL || "/bin/sh";
}

/**
 * Build an expanded PATH that includes common binary locations.
 *
 * Obsidian (Electron) launches with a minimal PATH when opened from
 * the dock/GUI, so user-installed CLIs (npm -g, homebrew, etc.) are
 * not visible. We prepend well-known directories so detection and
 * spawning work regardless of how Obsidian was launched.
 */
export function getExpandedPath(): string {
	const home = homedir();
	const extra = [
		join(home, ".local", "bin"),
		join(home, ".npm-global", "bin"),
		join(home, ".yarn", "bin"),
		join(home, ".nvm", "versions", "node"),  // handled via login shell mostly
		join(home, ".cargo", "bin"),
		"/usr/local/bin",
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
	];
	const current = process.env.PATH || "";
	return [...extra, ...current.split(isWindows() ? ";" : ":")].join(
		isWindows() ? ";" : ":"
	);
}

/**
 * Get exec options that use a login shell and expanded PATH.
 * A login shell sources the user's profile (~/.zshrc, ~/.bashrc, etc.)
 * which sets up PATH, nvm, homebrew, and other tool managers.
 */
function shellExecOptions(
	overrides?: { timeout?: number; cwd?: string }
): { timeout: number; cwd?: string; env: NodeJS.ProcessEnv; shell?: string } {
	const shell = getShell();
	return {
		timeout: overrides?.timeout ?? 10000,
		cwd: overrides?.cwd,
		env: { ...process.env, PATH: getExpandedPath() },
		// Use the user's login shell so rc files are sourced
		shell: isWindows() ? undefined : shell,
	};
}

/**
 * Wrap a command so it runs inside a login shell.
 * This ensures the user's profile is sourced and PATH is fully populated.
 */
function loginShellCmd(cmd: string): string {
	if (isWindows()) return cmd;
	const shell = getShell();
	// Use -l (login) and -c (command) — works for bash, zsh, fish
	const escaped = cmd.replace(/"/g, '\\"');
	return `${shell} -l -c "${escaped}"`;
}

/**
 * Locate a binary on the system PATH.
 * Returns the full path or null if not found.
 */
export function whichBinary(name: string): Promise<string | null> {
	const rawCmd = isWindows() ? `where ${name}` : `which ${name}`;
	const cmd = loginShellCmd(rawCmd);
	return new Promise((resolve) => {
		exec(cmd, { timeout: 5000, env: { ...process.env, PATH: getExpandedPath() } }, (err, stdout) => {
			if (err || !stdout.trim()) {
				resolve(null);
			} else {
				resolve(stdout.trim().split("\n")[0].trim());
			}
		});
	});
}

/**
 * Run a command and return its stdout.
 * Rejects on non-zero exit or timeout.
 */
export function execCommand(
	cmd: string,
	opts?: { timeout?: number; cwd?: string }
): Promise<string> {
	const wrappedCmd = loginShellCmd(cmd);
	const execOpts = shellExecOptions(opts);
	return new Promise((resolve, reject) => {
		exec(
			wrappedCmd,
			execOpts,
			(err, stdout, stderr) => {
				if (err) {
					reject(new Error(stderr || err.message));
				} else {
					resolve(stdout.trim());
				}
			}
		);
	});
}
