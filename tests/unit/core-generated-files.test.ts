import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function runScript(name: string): { ok: boolean; out: string } {
	try {
		const out = execFileSync(process.execPath, [join(root, "scripts", name), "--check"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, out };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string };
		return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
	}
}

describe("生成物与源码一致（勿手改）", () => {
	it("adapters/wire/dispatch-surface.ts 由 scripts/gen-core-dispatch-surface.mjs 生成", () => {
		const { ok, out } = runScript("gen-core-dispatch-surface.mjs");
		expect(out).toContain("dispatch-surface.ts");
		expect(ok).toBe(true);
	});
});
