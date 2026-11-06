import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "server", "dsh", "runtime");
const DST = join(HERE, "..", "dist", "server", "dsh", "runtime");

mkdirSync(DST, { recursive: true });
let copied = 0;
for (const f of readdirSync(SRC)) {
	if (f.endsWith(".mjs") || f.endsWith(".yml") || f.endsWith(".yaml") || f.endsWith(".js")) {
		copyFileSync(join(SRC, f), join(DST, f));
		copied++;
	}
}
console.log(`✓ copied ${copied} dsh runtime files → dist/server/dsh/runtime/`);
