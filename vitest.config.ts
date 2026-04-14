import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts", "src/views/**", "src/settings.ts"],
    },
  },
  resolve: {
    alias: {
      obsidian: new URL("./tests/__mocks__/obsidian.ts", import.meta.url)
        .pathname,
    },
  },
});
