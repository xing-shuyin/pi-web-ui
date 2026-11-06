import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "plugins", "run-trace", "client", "vendor");
mkdirSync(VENDOR, { recursive: true });

const { version } = JSON.parse(readFileSync(join(ROOT, "node_modules", "vis-timeline", "package.json"), "utf8"));
const SRC_JS = join(ROOT, "node_modules", "vis-timeline", "standalone", "esm", "vis-timeline-graph2d.min.mjs");
const SRC_CSS = join(ROOT, "node_modules", "vis-timeline", "styles", "vis-timeline-graph2d.min.css");

const js = readFileSync(SRC_JS, "utf8");
writeFileSync(
	join(VENDOR, "vis-timeline.bundle.mjs"),
	`/** vis-timeline v${version} standalone (min) — run-trace vendor, offline-first. See scripts/build-runtrace-vendor.mjs. */\n${js}`,
);
copyFileSync(SRC_CSS, join(VENDOR, "vis-timeline.css"));
console.log(`✓ run-trace vendor ← vis-timeline v${version}`);
