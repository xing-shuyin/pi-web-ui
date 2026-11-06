import { build } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

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
