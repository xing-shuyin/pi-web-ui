import { describe, expect, it } from "vitest";
import { checkBashCommandDanger } from "../../server/approval-rules.js";
import { findDangerousBashSegments } from "../../web/src/bash-danger.js";

const labelsOf = (cmd: string) => checkBashCommandDanger(cmd).map((h) => h.label);
const textsOf = (cmd: string) => checkBashCommandDanger(cmd).map((h) => h.text);

describe("服务端命中清单：同一规则多次命中逐条列出（#578 根因①）", () => {
	it("git reset --hard && git clean -fdx && git push --force → 3 条命中", () => {
		expect(textsOf("git reset --hard && git clean -fdx && git push --force")).toEqual([
			"git reset --hard",
			"git clean -fdx",
			"git push --force",
		]);
	});

	it("rm -rf ./a && ls && rm -rf ./b → 两条 rm -rf 都在", () => {
		const hits = checkBashCommandDanger("rm -rf ./a && ls && rm -rf ./b");
		expect(hits.filter((h) => h.ruleId === "builtin.bash.rm-rf")).toHaveLength(2);
	});
});

describe("git 破坏性操作规则覆盖（#578 根因③）", () => {
	it.each([
		["git -C /srv/app reset --hard", "git -C /srv/app reset --hard"],
		["git.exe push --force", "git.exe push --force"],
		["git checkout .", "git checkout ."],
		["git checkout -- .", "git checkout -- ."],
		["git restore .", "git restore ."],
		["git stash clear", "git stash clear"],
		["git stash drop", "git stash drop"],
		["git push origin +main", "git push origin +main"],
		["git push origin :branch", "git push origin :branch"],
		["git push origin main --force", "git push origin main --force"],
		["git branch -D feature", "git branch -D"],
	])("%s 被识别", (cmd, text) => {
		expect(textsOf(cmd)).toContain(text);
	});

	it.each([
		"git restore --staged .",
		"git push https://github.com/x/y.git",
		"git push origin main",
		"git push origin feature-f",
		"git checkout ./file.txt",
		"git checkout main",
		"git status && rm -f x.txt",
	])("%s 不误判", (cmd) => {
		expect(labelsOf(cmd).filter((l) => l.includes("Git") || l.includes("git"))).toEqual([]);
	});
});

describe("前端降级高亮与服务端命中清单一致（#578 根因②：单一事实源）", () => {
	const samples = [
		"git reset --hard && git clean -fd && git push --force",
		"git -C /srv/app reset --hard",
		"git push origin +main",
		"git stash clear",
		"rm -rf ./data && chmod 777 /srv",
		"git status && git push origin main",
		"echo hello",
	];
	for (const cmd of samples) {
		it(`「${cmd}」的高亮区间与服务端命中区间相同`, () => {
			const server = checkBashCommandDanger(cmd)
				.map((h) => [h.index, h.index + h.length])
				.sort((a, b) => a[0] - b[0]);
			const client = findDangerousBashSegments(cmd).map((s) => [s.start, s.end]);
			const merged: number[][] = [];
			for (const [s, e] of server) {
				const last = merged[merged.length - 1];
				if (last && s <= last[1]) last[1] = Math.max(last[1], e);
				else merged.push([s, e]);
			}
			expect(client).toEqual(merged);
		});
	}
});
