import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { createPromptBaseObservers, readPromptBase } from "../../server/prompt-base-store.js";

/**
 * issue #999：子代理模板 `promptMode: "replace"` 必须只占**灵魂槽位**。
 * 旧实现按渲染文本里的 "Available tools:" 边界切段（SDK 的输出格式），SDK 0.86 改成
 * 分段提示词后边界恒不存在 → 模板退化成"前置拼接"，子代理仍带整段平台提示词。
 * 这里跑真实 SDK 会话，断言我们交给它的结构化输入产出的最终提示词。
 */

const ROOT = mkdtempSync(join(tmpdir(), "pi-999-"));
const AGENT_DIR = join(ROOT, "agent");
mkdirSync(AGENT_DIR, { recursive: true });

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

const TEMPLATE = "You are a strict reviewer. Report only real defects.";

function project(name: string, files: { system?: string; agents?: string }): string {
	const cwd = join(ROOT, name);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	if (files.system !== undefined) writeFileSync(join(cwd, ".pi", "SYSTEM.md"), files.system);
	if (files.agents !== undefined) writeFileSync(join(cwd, "AGENTS.md"), files.agents);
	return cwd;
}

/** 建一个与子代理模板等价的会话：soul 覆盖 = replace，append = 追加段。 */
async function sessionPrompt(cwd: string, opts: { soul?: () => string | undefined } = {}) {
	const promptBase = createPromptBaseObservers({ soul: opts.soul });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: AGENT_DIR,
		settingsManager: SettingsManager.inMemory(),
		systemPromptOverride: promptBase.systemPromptOverride,
		appendSystemPromptOverride: promptBase.appendSystemPromptOverride,
	});
	await loader.reload();
	promptBase.bind(loader);
	const settingsManager = SettingsManager.inMemory();
	const { session } = await createAgentSession({
		cwd,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(),
		settingsManager,
	});
	return { text: session.systemPrompt, record: readPromptBase(loader) };
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("issue #999 — 子代理模板 replace 只换灵魂槽位", () => {
	it("没有 SYSTEM.md：模板成为唯一灵魂段，平台 tools/rules/docs 自动省略", async () => {
		const cwd = project("no-system", { agents: "# 项目规则\n始终用中文回答。" });
		const { text, record } = await sessionPrompt(cwd, { soul: () => TEMPLATE });

		expect(text.startsWith(TEMPLATE)).toBe(true);
		expect(count(text, TEMPLATE)).toBe(1);
		expect(text).not.toContain("<tools>");
		expect(text).not.toContain("<rules>");
		expect(text).not.toContain("<docs>");
		// 自动段保留：项目上下文 / 技能位 / 工作目录行仍由 SDK 用最新数据生成。
		expect(text).toContain("<project_context>");
		expect(text).toContain("始终用中文回答。");
		expect(text).toContain("<cwd>");
		expect(text).toContain(cwd.replace(/\\/g, "/"));

		expect(record.system).toBe("");
		expect(record.soul).toBe(TEMPLATE);
	});

	it("有 SYSTEM.md：模板只出现一次（旧的 hook 拼接会重复两遍）", async () => {
		const cwd = project("with-system", { system: "You are Pi.", agents: "# 项目规则" });
		const { text, record } = await sessionPrompt(cwd, { soul: () => TEMPLATE });

		expect(count(text, TEMPLATE)).toBe(1);
		expect(text).not.toContain("You are Pi.");
		expect(record.system).toBe("You are Pi.");
		expect(record.soul).toBe(TEMPLATE);
	});

	it("没有 soul 覆盖（append 模式）：SYSTEM.md 原文就是灵魂，模板不越位", async () => {
		const cwd = project("append-mode", { system: "You are Pi.", agents: "# 项目规则" });
		const { text, record } = await sessionPrompt(cwd);

		expect(text.startsWith("You are Pi.")).toBe(true);
		expect(text).not.toContain(TEMPLATE);
		expect(record.soul).toBe("You are Pi.");
	});

	it("组装路径单源：子代理模板不再走主会话组合模板（不出现 {{token}} 残留）", async () => {
		const cwd = project("single-path", { agents: "# 项目规则" });
		const { text } = await sessionPrompt(cwd, { soul: () => TEMPLATE });
		expect(text).not.toContain("{{");
	});
});
