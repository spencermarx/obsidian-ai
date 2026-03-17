import { whichBinary } from "../utils/platform";
import { AgentAdapter } from "./types";
import { ClaudeCodeAdapter } from "./claude-code";
import { OpencodeAdapter } from "./opencode";
import { GenericCliAdapter } from "./generic-cli";

/** Registry of all known adapter constructors. */
const ADAPTER_CONSTRUCTORS: Array<() => AgentAdapter> = [
	() => new ClaudeCodeAdapter(),
	() => new OpencodeAdapter(),
];

export interface DetectedAgent {
	adapter: AgentAdapter;
	version: string | null;
	path: string | null;
}

/**
 * Scan the system for installed agentic CLI tools.
 * Returns a list of detected agents with their versions.
 */
export async function detectAgents(): Promise<DetectedAgent[]> {
	const results: DetectedAgent[] = [];

	await Promise.all(
		ADAPTER_CONSTRUCTORS.map(async (create) => {
			const adapter = create();
			try {
				const found = await adapter.detect();
				if (found) {
					const version = await adapter.getVersion();
					const path = await whichBinary(adapter.binaryName);
					results.push({ adapter, version, path });
				}
			} catch {
				// Skip agents that error during detection
			}
		})
	);

	return results;
}

/**
 * Get a specific adapter by ID.
 * If customBinary is provided, wraps it in a GenericCliAdapter.
 */
export function getAdapterById(
	id: string,
	customBinary?: string
): AgentAdapter {
	for (const create of ADAPTER_CONSTRUCTORS) {
		const adapter = create();
		if (adapter.id === id) return adapter;
	}

	// Fallback: treat as a generic CLI tool
	return new GenericCliAdapter(customBinary || id);
}

/**
 * Get all known adapter instances (for listing in settings).
 */
export function getAllAdapters(): AgentAdapter[] {
	return ADAPTER_CONSTRUCTORS.map((create) => create());
}
