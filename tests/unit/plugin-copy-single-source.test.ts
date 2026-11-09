import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 守卫：`node_modules` / `.git` 这类复制黑名单只能由 `server/fs-copy.ts` 一处裁决。
 *
 * 历史教训（issue #856）：三个地方各自手写
 *   `filter: (s) => !/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(s)`
 * 而 `cpSync` 的 filter 拿到的是**绝对路径**。npm -g 安装时源目录自己就在
 * `…/node_modules/pi-web-ui/plugins/<id>` 里，于是整棵树被过滤成空副本，
 * 还被当成「已安装」——全局安装的用户永久报 manifest 缺失。
 */

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = join(here, "..", "..", "server");
const SINGLE_SOURCE = "server/fs-copy.ts";
const LOOKAHEAD_LINES = 12;

function tsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const abs = join(dir, entry);
		if (statSync(abs).isDirectory()) out.push(...tsFiles(abs));
		else if (entry.endsWith(".ts")) out.push(abs);
	}
	return out;
}

describe("plugin copy single source", () => {
	it("never hand-rolls a node_modules/.git copy filter outside fs-copy.ts", () => {
		const offenders: string[] = [];
		for (const file of tsFiles(serverDir)) {
			const rel = relative(join(here, "..", ".."), file).replace(/\\/g, "/");
			if (rel === SINGLE_SOURCE) continue;
			const lines = readFileSync(file, "utf8").split("\n");
			lines.forEach((line, i) => {
				if (!line.includes("cpSync(")) return;
				const window = lines.slice(i, i + LOOKAHEAD_LINES).join("\n");
				if (!window.includes("filter:")) return;
				const filterPart = window.slice(window.indexOf("filter:"));
				if (/\bnode_modules\b/.test(filterPart)) offenders.push(`${rel}:${i + 1}`);
			});
		}
		expect(offenders).toEqual([]);
	});

	it("matches skip rules on relative paths so the source root is never filtered away", () => {
		const src = readFileSync(join(serverDir, "fs-copy.ts"), "utf8");
		expect(src).toContain("relative(src, from)");
		expect(src).toContain("if (!rel) return false;");
	});
});
