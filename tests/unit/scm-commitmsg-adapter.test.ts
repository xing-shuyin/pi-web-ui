import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClientStateStore } from "../../server/client-state.js";
import { createCoreScmCommitMessage } from "../../server/core-scm-adapter.js";
import {
	generateScmCommitMessageForCurrent,
	noScmCommitModelMessage,
	type ScmCommitRuntime,
} from "../../server/scm-commitmsg.js";

/**
 * `scmGenCommitMessage` 的宿主一侧：选型（`sessionModel` → 宿主模型运行时）与「一次独立于对话的推断」。
 * 内核只认 `ScmCommitMessagePort`（见 `scm-commitmsg-handler.test.ts`），这一段全部留在宿主。
 */

const hasGit = (() => {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true });
		return true;
	} catch {
		return false;
	}
})();

function fakeRuntime(overrides: Partial<ScmCommitRuntime> & { text?: string } = {}) {
	const seen: { model: unknown; context: any; options: any }[] = [];
	const runtime: ScmCommitRuntime = {
		getModel: (provider, id) => ({ provider, id }),
		completeSimple: async (model: unknown, context: unknown, options?: unknown) => {
			seen.push({ model, context, options });
			return { stopReason: "stop", content: [{ type: "text", text: overrides.text ?? '"feat: 加一个功能"' }] };
		},
		...overrides,
	};
	return { runtime, seen };
}

describe("generateScmCommitMessageForCurrent · 选型", () => {
	it("没选模型：回「先在顶栏选择模型」，连模型运行时都不建（thunk 不被调）", async () => {
		let created = 0;
		const result = await generateScmCommitMessageForCurrent({
			cwd: "/nowhere",
			model: undefined,
			runtime: async () => {
				created++;
				return fakeRuntime().runtime;
			},
			lang: "zh",
		});
		expect(result).toEqual({ ok: false, error: noScmCommitModelMessage("zh") });
		expect(created).toBe(0);
	});

	it("模型运行时里没有这个 id：同一句「先选模型」（不拿别的东西凑）", async () => {
		const { runtime, seen } = fakeRuntime({ getModel: () => undefined });
		const result = await generateScmCommitMessageForCurrent({
			cwd: "/nowhere",
			model: { provider: "p", id: "m" },
			runtime: async () => runtime,
			lang: "en",
		});
		expect(result).toEqual({ ok: false, error: noScmCommitModelMessage("en") });
		expect(seen).toEqual([]);
	});
});

describe.skipIf(!hasGit)("generateScmCommitMessageForCurrent · happy path（真 git，假模型）", () => {
	it("采集真实改动 → 按 provider/id 取到模型 → 一次推断 → 清洗成一句主题", async () => {
		const dir = mkdtempSync(join(tmpdir(), "core-scm-commitmsg-"));
		try {
			execFileSync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
			writeFileSync(join(dir, "a.txt"), "hello\n");
			execFileSync("git", ["add", "a.txt"], { cwd: dir, windowsHide: true });

			const { runtime, seen } = fakeRuntime();
			const result = await generateScmCommitMessageForCurrent({
				cwd: dir,
				model: { provider: "my-provider", id: "my-model" },
				runtime: async () => runtime,
				lang: "zh",
				promptMode: "append",
				customPrompt: "",
			});

			expect(result).toEqual({ ok: true, text: "feat: 加一个功能" });
			expect(seen).toHaveLength(1);
			// 选的正是内核报上来的那个模型（宿主运行时按 provider/id 现取）。
			expect(seen[0].model).toEqual({ provider: "my-provider", id: "my-model" });
			// 一次独立推断：system 是提交信息提示词，user 里带的是真采集到的暂存 diff。
			expect(String(seen[0].context.systemPrompt)).toContain("You write git commit messages");
			const userText = String(seen[0].context.messages?.[0]?.content?.[0]?.text ?? "");
			expect(userText).toContain("Staged diff");
			expect(userText).toContain("a.txt");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60000);

	it("promptMode=replace + 自定义提示词：system 就用用户那一份", async () => {
		const dir = mkdtempSync(join(tmpdir(), "core-scm-commitmsg-"));
		try {
			execFileSync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
			writeFileSync(join(dir, "b.txt"), "x\n");
			execFileSync("git", ["add", "b.txt"], { cwd: dir, windowsHide: true });

			const { runtime, seen } = fakeRuntime({ text: "chore: 替换提示词" });
			const result = await generateScmCommitMessageForCurrent({
				cwd: dir,
				model: { provider: "p", id: "m" },
				runtime: async () => runtime,
				lang: "zh",
				promptMode: "replace",
				customPrompt: "只写一句中文",
			});
			expect(result).toEqual({ ok: true, text: "chore: 替换提示词" });
			expect(seen[0].context.systemPrompt).toBe("只写一句中文");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60000);
});

describe("宿主适配器 createCoreScmCommitMessage", () => {
	it("按客户端读设置快照、用 sink 报的会话模型：没模型就如实回执，不需要凭证", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "core-scm-agent-"));
		const seenClients: string[] = [];
		const stateStore = {
			getSettingsSnapshot: (clientId: string) => {
				seenClients.push(clientId);
				return { scmCommitMsgPromptMode: "replace", scmCommitMsgPrompt: "只写一句中文" };
			},
		} as unknown as ClientStateStore;
		try {
			const port = createCoreScmCommitMessage({
				agentDir,
				stateStore,
				clientId: "client-1",
				getLang: () => "en",
				sessionModel: () => undefined,
			});
			const result = await port.generateCommitMessage({ cwd: agentDir });
			expect(result).toEqual({ ok: false, error: noScmCommitModelMessage("en") });
			expect(seenClients).toEqual(["client-1"]);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
