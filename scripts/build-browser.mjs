import { build } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { copyFileSync, existsSync } from "node:fs";

const root = fileURLToPath(new URL("../browser/renderer/", import.meta.url));
await build({
	configFile: false,
	root,
	base: "./",
	build: {
		outDir: resolve(root, "../../dist/browser/renderer"),
		emptyOutDir: true,
		sourcemap: false,
		rollupOptions: {
			input: Object.fromEntries(
				["shell", "newtab", "office", "workspace"].map((name) => [name, resolve(root, `${name}.html`)]),
			),
		},
	},
});

const filesToCopy = ["dock.js"];
for (const file of filesToCopy) {
	const src = resolve(root, file);
	const dest = resolve(root, "../../dist/browser/renderer", file);
	if (existsSync(src)) copyFileSync(src, dest);
}
