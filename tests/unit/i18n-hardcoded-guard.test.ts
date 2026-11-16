/**
 * 硬编码文案守卫：源码里出现的「含中日韩文字的字符串字面量」必须已在
 * tests/fixtures/i18n-hardcoded-allowlist.json 登记，且名单只允许变短。
 * 扫描与比对逻辑住在 scripts/i18n-literal-inventory.mjs（与 CLI 共用）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWLIST_PATH, collectLiterals, diffAgainstAllowlist } from "../../scripts/i18n-literal-inventory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("i18n 硬编码文案守卫", () => {
	it("当前工作区的字面量与 allowlist 完全一致", () => {
		const found = collectLiterals(root);
		const allow = JSON.parse(readFileSync(join(root, ALLOWLIST_PATH), "utf8"));
		const { added, stale } = diffAgainstAllowlist(found, allow.entries);
		expect(added, `新增硬编码文案：\n${JSON.stringify(added, null, 1)}`).toEqual([]);
		expect(stale, `allowlist 里已不存在的条目（请在同一次提交里删掉）：\n${JSON.stringify(stale, null, 1)}`).toEqual(
			[],
		);
	});

	it("新增一条中文文案会被报出来（守卫能真的失败）", () => {
		const allow = [{ file: "web/src/a.tsx", text: "设置", count: 1, reason: "pending" }];
		const found = [
			{ file: "web/src/a.tsx", text: "设置", count: 1 },
			{ file: "web/src/a.tsx", text: "保存", count: 1 },
		];
		const { added, stale } = diffAgainstAllowlist(found, allow);
		expect(added).toEqual([{ file: "web/src/a.tsx", text: "保存", count: 1 }]);
		expect(stale).toEqual([]);
	});

	it("迁移完成后新增计数也要求删名单（只减不增）", () => {
		const allow = [{ file: "web/src/a.tsx", text: "设置", count: 3, reason: "pending" }];
		const found = [{ file: "web/src/a.tsx", text: "设置", count: 1 }];
		const { added, stale } = diffAgainstAllowlist(found, allow);
		expect(added).toEqual([]);
		expect(stale).toEqual([{ file: "web/src/a.tsx", text: "设置", count: 3, was: 3, now: 1 }]);
	});
});
