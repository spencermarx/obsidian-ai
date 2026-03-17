import { exec } from "child_process";
import { platform } from "os";

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
 * Locate a binary on the system PATH.
 * Returns the full path or null if not found.
 */
export function whichBinary(name: string): Promise<string | null> {
	const cmd = isWindows() ? `where ${name}` : `which ${name}`;
	return new Promise((resolve) => {
		exec(cmd, { timeout: 5000 }, (err, stdout) => {
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
	return new Promise((resolve, reject) => {
		exec(
			cmd,
			{ timeout: opts?.timeout ?? 10000, cwd: opts?.cwd },
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
