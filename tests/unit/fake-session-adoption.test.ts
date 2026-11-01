/**
 * 假体采用率棘轮（ratchet）—— 手搓 `ClientSession` / `AgentService` 假体的名单**只许变短**。
 *
 * 背景：40 个测试文件曾手搓 `Object.assign(Object.create(ClientSession.prototype), {…})`。
 * 这种假体拿不到实例字段（字段在 constructor 里初始化），生产类每加一个成员就会在 CI 上
 * 以 `TypeError: xxx is not a function` / `Cannot read properties of undefined` 炸一次
 * （一次复盘里 5 个新成员打红 9 个文件的 15 个用例）。`tests/helpers/fake-session.ts`
 * 从生产源码推导字段默认值，根治了这类漂移。
 *
 * 本测试只做一件事：**不许再新增手搓假体**。存量名单 `LEGACY_HAND_ROLLED` 是迁移
 * 进度表——迁移完一个文件就删掉对应的一行（评审时看得到名单在变短）。
 *
 * 为什么不断言「名单里的文件必须还在手搓」：名单里有一部分文件属于别的工作线的未提交
 * 改动，工作区与提交树的内容并不一致；对「过期条目」报错会在两边来回假红。名单只管
 * 上限，不追进度。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * 存量迁移名单（只删不加）。每迁完一个文件，就把对应行删掉。
 * 这些文件当时正被另一条工作线改动，为避免互相覆盖暂留。
 */
const LEGACY_HAND_ROLLED = [
	"tests/unit/bot-client-lifecycle.test.ts",
	"tests/unit/bot-execution.test.ts",
	"tests/unit/communication-runtime.test.ts",
	"tests/unit/conversation-switch-ack.test.ts",
	"tests/unit/elsewhere-dedup.test.ts",
	"tests/unit/goal-executor-dispatch.test.ts",
	"tests/unit/server-question-lifecycle.test.ts",
	"tests/unit/switch-conversation-fast.test.ts",
];

/** 手搓假体的特征：绕过 constructor 造实例（字段丢失的根源）。 */
const HAND_ROLLED = /Object\.create\(\s*(?:ClientSession|AgentService)\.prototype\s*\)/;

/** 已迁移完成、可作范式的文件（不在扫描里报错的证据：工厂自己 + 本守卫）。 */
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
			// 工厂自己必须能造原型实例；本守卫的说明文字会引用该写法 —— 都豁免。
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
