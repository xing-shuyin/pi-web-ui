import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * issue #999 的红线：提示词只能经 SDK 的**结构化槽位**表达
 * （loader 的 systemPromptOverride / appendSystemPromptOverride、
 *  before_agent_start 的 systemPromptOptions，或我们自己的组合模板）。
 * 渲染后的提示词文本是 SDK 的**输出**，禁当输入解析 —— 一旦这么做，
 * SDK 换个段模型（0.86 就换过）就会静默退化成"前置拼接"，且没有编译期信号。
 *
 * 同一条红线的第二面：平台/模式约束只有一个生产处、两个必经仓道
 * （SDK 路径 = loader append 段；组合模板路径 = hook 出口追加）。
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER = join(ROOT, "server");

function sources(dir = SERVER, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) sources(full, acc);
		else if (entry.name.endsWith(".ts")) acc.push(full);
	}
	return acc;
}

function stripComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("提示词只走结构化槽位（issue #999）", () => {
	it("只有 composer 产出 'Available tools:'，server/ 没人把它当输入", () => {
		const offenders: string[] = [];
		for (const file of sources()) {
			const text = stripComments(readFileSync(file, "utf8"));
			if (!text.includes("Available tools:")) continue;
			// 允许：组合模板自己的工具段（自有格式，生产方与消费方都是我们）。
			if (file.endsWith(join("server", "prompt-composer.ts"))) continue;
			offenders.push(file.replace(ROOT, ""));
		}
		expect(offenders).toEqual([]);
	});

	it("不按 SDK 的分段标记做字符串判断（<tools>/<rules>/<docs>/<preamble>）", () => {
		const PARSE = /(indexOf|lastIndexOf|split|includes|startsWith|endsWith)\(\s*["'`]<\/?(tools|rules|docs|preamble)/;
		const offenders: string[] = [];
		for (const file of sources()) {
			const text = stripComments(readFileSync(file, "utf8"));
			if (PARSE.test(text)) offenders.push(`${file.replace(ROOT, "")} ← ${PARSE.source}`);
		}
		expect(offenders).toEqual([]);
	});

	it("平台/模式约束：文本生产只允许在 platform-constraints.ts（加上各自的定义处）", () => {
		const allowed = ["platform-constraints.ts", "delegate-mode.ts", "plan-mode.ts", "remote-ssh-service.ts"];
		const producers = sources()
			.filter((file) => {
				const text = stripComments(readFileSync(file, "utf8"));
				return /(DELEGATION_SYSTEM_PROMPT|buildPlanModePrompt|buildRemoteWorkspacePersona)/.test(text);
			})
			.map((file) => file.split(/[\\/]/).pop());
		expect(producers.filter((name) => !(name && allowed.includes(name)))).toEqual([]);
		expect(producers).toContain("platform-constraints.ts");
	});

	it("Windows persona 已删除（内容已陈旧：bash 现在有 120s 默认超时）", () => {
		const offenders = sources().filter((file) => stripComments(readFileSync(file, "utf8")).includes("WINDOWS_PERSONA"));
		expect(offenders.map((file) => file.replace(ROOT, ""))).toEqual([]);
	});
});
