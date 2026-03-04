import { builtinModules } from "node:module";
import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/cli.ts"],
	format: ["esm"],
	target: "node22",
	platform: "node",
	noExternal: [/.*/],
	external: [/^node:/, ...builtinModules],
	banner: {
		js: [
			"#!/usr/bin/env node",
			// CJS modules bundled into ESM need a working require() for node builtins.
			"import { createRequire as __cr } from 'node:module';",
			"const require = __cr(import.meta.url);",
		].join("\n"),
	},
	splitting: false,
	clean: true,
	sourcemap: false,
	minify: true,
	esbuildOptions(options) {
		// Prevent esbuild from inheriting "strict": true from the root tsconfig,
		// which blocks bundling CJS modules that use legacy octal escapes (e.g. qrcode-terminal).
		options.tsconfig = undefined;
		options.tsconfigRaw = JSON.stringify({
			compilerOptions: {
				verbatimModuleSyntax: true,
			},
		});
	},
});
