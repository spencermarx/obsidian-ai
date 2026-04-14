import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
	// ── Global ignores ──────────────────────────────────────────────
	{
		ignores: [
			"main.js",
			"node_modules/**",
			"esbuild.config.mjs",
			"version-bump.mjs",
		],
	},

	// ── Base TypeScript (type-checked) ──────────────────────────────
	...tseslint.configs.recommendedTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},

	// ── Test file overrides ────────────────────────────────────────
	{
		files: ["tests/**/*.ts"],
		rules: {
			// Stubs implement async interfaces without awaiting
			"@typescript-eslint/require-await": "off",
			// Unused params are common in stub/mock signatures
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
		},
	},

	// ── Source rules ────────────────────────────────────────────────
	{
		files: ["src/**/*.ts"],
		plugins: { obsidianmd },
		rules: {
			// -- Obsidian community plugin rules --
			...obsidianmd.configs.recommended,

			// -- Async correctness (what the bot flagged) --
			"@typescript-eslint/require-await": "error",
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/await-thenable": "error",
			"@typescript-eslint/no-misused-promises": "error",

			// -- Unused code --
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],

			// -- Type safety (warn — tighten later) --
			"@typescript-eslint/no-explicit-any": "warn",
			"@typescript-eslint/no-non-null-assertion": "warn",
			"@typescript-eslint/no-unsafe-assignment": "warn",
			"@typescript-eslint/no-unsafe-member-access": "warn",
			"@typescript-eslint/no-unsafe-call": "warn",
			"@typescript-eslint/no-unsafe-argument": "warn",
			"@typescript-eslint/no-unsafe-return": "warn",
			"@typescript-eslint/no-unnecessary-type-assertion": "warn",

			// -- Style --
			"@typescript-eslint/consistent-type-imports": [
				"warn",
				{ prefer: "type-imports", fixStyle: "inline-type-imports" },
			],
			"@typescript-eslint/prefer-nullish-coalescing": "warn",
			"@typescript-eslint/prefer-optional-chain": "warn",

			// -- Core JS --
			"no-console": "warn",
			"no-debugger": "error",
			"no-duplicate-imports": "error",
			"no-template-curly-in-string": "warn",
			eqeqeq: ["error", "always"],
			"prefer-const": "error",
			"no-var": "error",
			"no-throw-literal": "error",
		},
	},
);
