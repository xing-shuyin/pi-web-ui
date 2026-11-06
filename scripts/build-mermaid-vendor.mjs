import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "plugins", "mermaid", "client", "vendor", "mermaid.bundle.mjs");
mkdirSync(dirname(OUT), { recursive: true });

const { errors } = await build({
	stdin: {
		contents: 'import mermaid from "mermaid"; export default mermaid;',
		resolveDir: ROOT,
		sourcefile: "mermaid-vendor-entry.mjs",
	},
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2020",
	minify: true,
	logLevel: "info",
	outfile: OUT,
});

if (errors.length > 0) {
	console.error("✗ mermaid vendor bundle 构建失败");
	process.exit(1);
}
console.log(`✓ mermaid vendor bundle → plugins/mermaid/vendor/mermaid.bundle.mjs`);
