import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outdir = join(here, "dist");
mkdirSync(outdir, { recursive: true });

const common = {
	bundle: true,
	target: "chrome116",
	sourcemap: false,
	logLevel: "info",
	legalComments: "none",
};

await build({
	...common,
	entryPoints: [join(here, "src/background.ts")],
	format: "esm",
	outfile: join(outdir, "background.js"),
});

await build({
	...common,
	entryPoints: [join(here, "src/content/picker.ts")],
	format: "iife",
	outfile: join(outdir, "picker.js"),
});

await build({
	...common,
	entryPoints: [join(here, "src/content/bind-bar.ts")],
	format: "iife",
	outfile: join(outdir, "bind.js"),
});

await build({
	...common,
	entryPoints: [join(here, "src/content/bridge.ts")],
	format: "iife",
	outfile: join(outdir, "bridge.js"),
});

await build({
	...common,
	entryPoints: [join(here, "src/options.ts")],
	format: "esm",
	outfile: join(outdir, "options.js"),
});

console.log("✓ page-picker extension → plugins/page-picker/extension/dist/");
