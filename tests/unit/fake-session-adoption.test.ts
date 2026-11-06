import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const LEGACY_HAND_ROLLED: string[] = [];

const HAND_ROLLED = /Object\.create\(\s*(?:ClientSession|AgentService)\.prototype\s*\)/;

const SELF_EXEMPT = new Set(["tests/helpers/fake-session.ts", "tests/unit/fake-session-adoption.test.ts"]);

function testSources(dir = join(ROOT, "tests"), acc: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) testSources(full, acc);
		else if (/\.(?:ts|mjs)$/.test(entry.name)) acc.push(full);
	}
	return acc;
}

describe("假体采用率棘轮", () => {
	it("名单外的测试文件不得手搓会话/守护假体（请改用 tests/helpers/fake-session.ts）", () => {
		const offenders: string[] = [];
		for (const file of testSources()) {
			const rel = relative(ROOT, file).replace(/\\/g, "/");
			if (SELF_EXEMPT.has(rel)) continue;
			if (!HAND_ROLLED.test(readFileSync(file, "utf8"))) continue;
			if (!LEGACY_HAND_ROLLED.includes(rel)) offenders.push(rel);
		}
		expect(
			offenders,
			`下面的文件手搓了会话/守护假体（实例字段会随生产类演进丢失）。\n` +
				`改用 \`fakeClientSession({…})\` / \`fakeAgentService({…})\`（见 tests/helpers/fake-session.ts）：\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("名单没有重复项（防止粘贴出两份让棘轮失效）", () => {
		expect(new Set(LEGACY_HAND_ROLLED).size).toBe(LEGACY_HAND_ROLLED.length);
	});
});
