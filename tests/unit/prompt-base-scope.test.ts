/**
 * 提示词 base 作用域守卫（issue #812）—— SYSTEM.md / APPEND_SYSTEM.md 的 base
 * 必须挂在 **loader / session** 上，不许挂在 AgentService（= 一个浏览器客户端）上。
 *
 * 事故形态：`lastBaseSystemPrompt` 是 ClientSession 级字段，只在 loader 给出非空
 * base 时更新。切到没有 `.pi/SYSTEM.md` 的项目时 loader 给的 base 是 `undefined`
 * ——旧值没人清→上一个项目的系统提示词泄漏到本项目的设置预览与新建对话，只有偶然
 * 访问一个含空白 SYSTEM.md 的项目才会「被修复」。同类字段（`lastSdkAppendFiles`
 * 之于 APPEND_SYSTEM.md）只是被覆盖得更勤，机制上同样串账。
 *
 * 守卫口径：`server/` 下不许再出现「最近一次观察到的 base」这类客户端级字段；
 * 唯一入口是 `readPromptBase(loader)` / `recordPromptBaseLoader(loader, …)`。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER = join(ROOT, "server");

function serverSources(dir = SERVER, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) serverSources(full, acc);
		else if (entry.name.endsWith(".ts")) acc.push(full);
	}
	return acc;
}

/** 去掉注释（只查真实代码：注释里提历史字段名是文档，不是亲向）。 */
function stripComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** 曾经的事故字段名 + 同类「最近一次观察到」命名。 */
const FORBIDDEN_FIELDS = [/\blastBaseSystemPrompt\b/, /\blastSdkAppendFiles\b/, /\blastSystemPromptBase\b/];

describe("提示词 base 作用域", () => {
	it("server/ 里不再有客户端级的 base 影子字段", () => {
		const offenders: string[] = [];
		for (const file of serverSources()) {
			const text = stripComments(readFileSync(file, "utf8"));
			for (const re of FORBIDDEN_FIELDS) {
				if (re.test(text)) offenders.push(`${file.replace(ROOT, "")} ← ${re.source}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("composeInputs 只从目标会话的 loader 读 base", () => {
		const service = readFileSync(join(SERVER, "agent-service.ts"), "utf8");
		// base 的唯一来源：readPromptBase(目标 session 的 resourceLoader)。
		expect(service).toMatch(/readPromptBase\(src\.session\?\.resourceLoader\)/);
		// 预览/统计也必须把目标会话传进去（拿活跃会话算后台会话 = 同类串账）。
		expect(service).toMatch(/session:\s*sess,?/);
		// override 由工厂生成（登记归属 + 返回值的同一处），并在拿到 loader 后 bind。
		expect(service).toMatch(/createPromptBaseObservers\(\{/);
		expect(service).toMatch(/systemPromptOverride: promptBase\.systemPromptOverride/);
		expect(service).toMatch(/appendSystemPromptOverride: promptBase\.appendSystemPromptOverride/);
		expect(service).toMatch(/promptBase\.bind\(services\.resourceLoader\)/);
	});

	it("主会话 override 返回 base（组合模板未激活时 SYSTEM.md 不被丢弃）", () => {
		const store = readFileSync(join(SERVER, "prompt-base-store.ts"), "utf8");
		// 缺省 handlers = 原样返回：SYSTEM.md / APPEND_SYSTEM.md 直达 SDK（TUI 同语义）。
		expect(store).toMatch(/handlers\.system \? handlers\.system\(base\) : base/);
		expect(store).toMatch(/handlers\.append \? handlers\.append\(base\) : base/);
	});
});
