// Shared runtime-tree resolution for the pi-web-ui DSH runtime.
// Used by launcher.mjs (boot-time) and probe-mixed.mjs (self-check).
//
// A "runtime tree" is a node_modules root that directly contains the dsh
// runtime packages: `@deepseek-ai/dsh-base` (with its cordis.patch.yml
// bundle) and `@deepseek-ai/dsh-app-boot`. Two layouts are accepted:
//
//   flat:   <root>/@deepseek-ai/dsh-base/cordis.patch.yml
//           (a node_modules root where the runtime packages live top-level)
//
//   nested: <root>/@deepseek-ai/dsh/node_modules/@deepseek-ai/…
//           (`npm i -g @deepseek-ai/dsh` installs the CLI package with its
//           OWN nested runtime tree of ~196 packages; the global root itself
//           only holds the `dsh` package)
//
// The returned value is always the *bare-module base dir*: the node_modules
// root that directly contains the runtime packages. That is what
// boot(bareModuleBaseUrl) anchors bare package names (dsh-base rows) to.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Given a candidate node_modules root, return the bare-module base dir, or null. */
export function runtimeBaseFor(root) {
	if (root == null) return null;
	const flatScope = join(root, "@deepseek-ai");
	if (
		existsSync(join(flatScope, "dsh-base", "cordis.patch.yml")) &&
		existsSync(join(flatScope, "dsh-app-boot", "lib", "index.js"))
	) {
		return resolve(root);
	}
	const nestedScope = join(root, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai");
	if (
		existsSync(join(nestedScope, "dsh-base", "cordis.patch.yml")) &&
		existsSync(join(nestedScope, "dsh-app-boot", "lib", "index.js"))
	) {
		return resolve(join(root, "@deepseek-ai", "dsh", "node_modules"));
	}
	return null;
}

/**
 * Resolution order:
 *   1. $PI_WEB_DSH_RUNTIME — explicit node_modules root
 *   2. this package's node_modules — full local install scenario
 *   3. execPath-adjacent node_modules — fnm / standalone node stable layout
 *      (<node.exe dir>/node_modules is a junction to the global tree)
 *   4. `npm root -g` — global install (win32 .cmd shim needs a shell)
 */
export async function resolveRuntimeBase() {
	const explicit = process.env.PI_WEB_DSH_RUNTIME;
	if (explicit) {
		const base = runtimeBaseFor(explicit);
		if (base) return base;
	}
	const local = join(resolve(HERE, "..", "..", ".."), "node_modules");
	{
		const base = runtimeBaseFor(local);
		if (base) return base;
	}
	const adjacent = join(dirname(process.execPath), "node_modules");
	{
		const base = runtimeBaseFor(adjacent);
		if (base) return base;
	}
	try {
		const { spawnSync } = await import("node:child_process");
		const res = spawnSync(process.platform === "win32" ? "npm" : "npm", ["root", "-g"], {
			encoding: "utf8",
			timeout: 15_000,
			windowsHide: true,
			...(process.platform === "win32" ? { shell: true } : {}),
		});
		const root = String(res.stdout ?? "").trim();
		if (root) {
			const base = runtimeBaseFor(root);
			if (base) return base;
		}
	} catch {
		/* fall through */
	}
	return null;
}
