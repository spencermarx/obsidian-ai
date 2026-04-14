import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionManager } from "../../src/session/session-manager";
import type { AgentAdapter } from "../../src/adapters/types";
import { Readable } from "stream";

/**
 * Stub adapter that returns spawn args pointing to a nonexistent binary.
 * We never actually spawn — these tests verify session lifecycle and
 * event subscription, not process spawning (which is infrastructure).
 */
function stubAdapter(overrides?: Partial<AgentAdapter>): AgentAdapter {
  return {
    id: "test",
    displayName: "Test",
    binaryName: "nonexistent-binary",
    detect: async () => true,
    getVersion: async () => "1.0",
    buildSpawnArgs: (opts) => ({
      command: "nonexistent-binary",
      args: [opts.prompt],
    }),
    parseOutputStream: async function* (_stdout: Readable) {
      // No output
    },
    getSlashCommands: async () => [],
    discoverSlashCommands: async () => null,
    getBuiltinSlashCommands: () => [],
    executeSlashCommand: async () => ({ handled: false }),
    ...overrides,
  };
}

beforeEach(() => {
  // @ts-expect-error — minimal window stub for SessionManager's beforeunload handler
  globalThis.window = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
});
afterEach(() => {
  // @ts-expect-error — cleanup
  delete globalThis.window;
});

describe("SessionManager", () => {
  describe("session lifecycle", () => {
    it("assigns unique IDs to each session", () => {
      const sm = new SessionManager();
      const id1 = sm.createSession(stubAdapter());
      const id2 = sm.createSession(stubAdapter());

      expect(id1).not.toBe(id2);
      sm.destroyAll();
    });

    it("retrieves a session by its ID", () => {
      const sm = new SessionManager();
      const adapter = stubAdapter();
      const id = sm.createSession(adapter);

      expect(sm.getSession(id)?.adapter).toBe(adapter);
      sm.destroyAll();
    });

    it("removes sessions on destroy", () => {
      const sm = new SessionManager();
      const id = sm.createSession(stubAdapter());

      sm.destroySession(id);

      expect(sm.getSession(id)).toBeUndefined();
      sm.destroyAll();
    });

    it("destroyAll clears all sessions", () => {
      const sm = new SessionManager();
      sm.createSession(stubAdapter());
      sm.createSession(stubAdapter());

      sm.destroyAll();

      expect(sm.getActiveSessions()).toHaveLength(0);
    });

    it("assigns a CLI session ID on creation", () => {
      const sm = new SessionManager();
      const id = sm.createSession(stubAdapter());
      const session = sm.getSession(id);

      expect(session?.cliSessionId).toBeDefined();
      expect(session?.cliSessionId.length).toBeGreaterThan(0);
      sm.destroyAll();
    });

    it("uses a provided CLI session ID for resumption", () => {
      const sm = new SessionManager();
      const id = sm.createSession(stubAdapter(), "existing-session-123");
      const session = sm.getSession(id);

      expect(session?.cliSessionId).toBe("existing-session-123");
      expect(session?.sessionInitialized).toBe(true);
      sm.destroyAll();
    });
  });

  describe("event subscription", () => {
    it("delivers events to listeners", () => {
      const sm = new SessionManager();
      const events: string[] = [];
      sm.onEvent((e) => events.push(e.type));

      const id = sm.createSession(stubAdapter());
      sm.destroySession(id);

      expect(events.length).toBeGreaterThan(0);
      sm.destroyAll();
    });

    it("returns an unsubscribe function that stops delivery", () => {
      const sm = new SessionManager();
      const events: string[] = [];
      const unsub = sm.onEvent((e) => events.push(e.type));

      const id1 = sm.createSession(stubAdapter());
      sm.destroySession(id1);
      const countBeforeUnsub = events.length;

      unsub();

      const id2 = sm.createSession(stubAdapter());
      sm.destroySession(id2);

      expect(events.length).toBe(countBeforeUnsub);
      sm.destroyAll();
    });

    it("removeAllListeners stops all event delivery", () => {
      const sm = new SessionManager();
      const events: string[] = [];
      sm.onEvent((e) => events.push(e.type));

      sm.removeAllListeners();

      const id = sm.createSession(stubAdapter());
      sm.destroySession(id);

      expect(events).toHaveLength(0);
      sm.destroyAll();
    });
  });

  describe("image pre-processing", () => {
    it("reads image files and passes base64 data to the adapter", async () => {
      const fs = await import("fs");
      const os = await import("os");
      const path = await import("path");

      const tmpDir = path.join(os.tmpdir(), "test-sm-images-" + Date.now());
      fs.mkdirSync(tmpDir, { recursive: true });
      const imgPath = path.join(tmpDir, "test.png");
      fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      let capturedOpts: Record<string, unknown> = {};
      const adapter = stubAdapter({
        buildSpawnArgs: (opts) => {
          capturedOpts = opts as unknown as Record<string, unknown>;
          return { command: "nonexistent-binary", args: ["ok"] };
        },
      });

      const sm = new SessionManager();
      const id = sm.createSession(adapter);

      // sendPrompt will encode the image then fail to spawn — that's fine,
      // we're testing the image encoding, not the process lifecycle.
      try {
        await sm.sendPrompt(
          id,
          "describe",
          { vaultPath: "/vault" },
          {
            imagePaths: [imgPath],
          },
        );
      } catch {
        // Expected — binary doesn't exist
      }

      // Wait for async encoding to complete
      await new Promise((r) => setTimeout(r, 100));

      const imageData = capturedOpts.imageData as Array<{
        base64: string;
        mimeType: string;
      }>;
      expect(imageData).toBeDefined();
      expect(imageData).toHaveLength(1);
      expect(imageData[0].mimeType).toBe("image/png");

      // Temp file should be cleaned up
      expect(fs.existsSync(imgPath)).toBe(false);

      sm.destroyAll();
      try {
        fs.rmdirSync(tmpDir);
      } catch {
        /* may not be empty */
      }
    });
  });
});
