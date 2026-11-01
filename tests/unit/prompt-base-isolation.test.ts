/**
 * issue #812 回归：切换项目不携带上一个项目的 `.pi/SYSTEM.md`。
 *
 * 用真的 `createAgentSessionServices`（真的 `DefaultResourceLoader`、真的 cwd、真的
 * 项目 .pi 目录）复现 issue 的三项目场景，验证：
 *   proj-a（有 SYSTEM.md）→ proj-b（无）→ proj-c（纯空白）
 *   - 每个 loader 只看到自己 cwd 的 base；
 *   - 没有 SYSTEM.md 的项目读到空记录 → composer 回落内置默认（= 内置 pi 提示词）；
 *   - 纯空白 SYSTEM.md 保留原文（TUI 同语义：空提示词，不是「没文件」）；
 *   - 切回无 SYSTEM.md 的项目仍然是内置默认（不靠「恰好访问空白项目」重置）；
 *   - APPEND_SYSTEM.md 同样按 loader 隔离；
 *   - reload 后 base 变空即清空。
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { createPromptBaseObservers, readPromptBase } from "../../server/prompt-base-store.js";
import { BUILTIN_SOUL, resolveSectionTexts, type PromptComposerInputs } from "../../server/prompt-composer.js";

const ROOT = mkdtempSync(join(tmpdir(), "pi-812-"));
const AGENT_DIR = join(ROOT, "agent");
mkdirSync(AGENT_DIR, { recursive: true });

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

/** 按 issue 的步骤造一个项目目录（可选写入 SYSTEM.md / APPEND_SYSTEM.md）。 */
function project(name: string, system?: string, append?: string): string {
	const cwd = join(ROOT, name);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	if (system !== undefined) writeFileSync(join(cwd, ".pi", "SYSTEM.md"), system);
	if (append !== undefined) writeFileSync(join(cwd, ".pi", "APPEND_SYSTEM.md"), append);
	return cwd;
}

/** 与 ClientSession.makeRuntimeFactory 同构：工厂生产 override + 归属绑定。 */
async function loadProject(cwd: string) {
	const promptBase = createPromptBaseObservers();
	const services = await createAgentSessionServices({
		cwd,
		agentDir: AGENT_DIR,
		resourceLoaderOptions: {
			systemPromptOverride: promptBase.systemPromptOverride,
			appendSystemPromptOverride: promptBase.appendSystemPromptOverride,
		},
	});
	promptBase.bind(services.resourceLoader);
	return { loader: services.resourceLoader, promptBase, services };
}

/** composeInputs 侧的读取口径：loader → {{soul}} / {{append}} 自动内容。 */
function soulOf(loader: object | undefined): string {
	const base = readPromptBase(loader);
	const inputs = {
		cwd: "/tmp",
		systemPromptFile: base.system || undefined,
		builtinSoul: BUILTIN_SOUL,
		selectedTools: [],
		toolSnippets: {},
		toolGuidelines: [],
		piReadme: "",
		piDocs: "",
		piExamples: "",
		appendFiles: [...base.append],
		windowsPersona: "",
		terminalGuidance: "",
		markersGuidance: "",
		contextFiles: [],
		skills: [],
	} as PromptComposerInputs;
	return resolveSectionTexts(inputs).soul;
}

describe("issue #812 — SYSTEM.md 不跨项目泄漏", () => {
	it("proj-a → proj-b → proj-c → proj-b：base 各自独立", async () => {
		const projA = project("a-with-system", "You are summarization master.");
		const projB = project("b-without-system");
		const projC = project("c-whitespace-system", " \n");
		const projD = project("d-append-only", undefined, "# extra rules");

		const a = await loadProject(projA);
		const b = await loadProject(projB);
		const c = await loadProject(projC);
		const d = await loadProject(projD);

		// a：SYSTEM.md 生效（记录 + SDK 视角一致）。
		expect(readPromptBase(a.loader).system).toBe("You are summarization master.");
		expect(a.loader.getSystemPrompt()).toBe("You are summarization master.");
		expect(soulOf(a.loader).startsWith("You are summarization master.")).toBe(true);

		// b：没有 SYSTEM.md → 空记录 → 内置默认（绝不带 proj-a 的值）。
		expect(readPromptBase(b.loader)).toEqual({ system: "", append: [] });
		expect(b.loader.getSystemPrompt()).toBeUndefined();
		expect(soulOf(b.loader).startsWith(BUILTIN_SOUL)).toBe(true);

		// c：纯空白 SYSTEM.md 保留原文（TUI 同语义：空提示词）。
		expect(readPromptBase(c.loader).system).toBe(" \n");
		expect(soulOf(c.loader).startsWith(" \n")).toBe(true);
		expect(soulOf(c.loader).startsWith(BUILTIN_SOUL)).toBe(false);

		// d：只有 APPEND_SYSTEM.md —— 两个 base 互不影响。
		expect(readPromptBase(d.loader).system).toBe("");
		expect(readPromptBase(d.loader).append).toEqual(["# extra rules"]);
		expect(soulOf(d.loader).startsWith(BUILTIN_SOUL)).toBe(true);
	});

	it("重载后 base 变空即清空（删掉 SYSTEM.md 不残留）", async () => {
		const cwd = project("e-toggle", "first prompt");
		const { loader } = await loadProject(cwd);
		expect(readPromptBase(loader).system).toBe("first prompt");

		rmSync(join(cwd, ".pi", "SYSTEM.md"));
		await loader.reload();
		expect(readPromptBase(loader)).toEqual({ system: "", append: [] });
		expect(soulOf(loader).startsWith(BUILTIN_SOUL)).toBe(true);
	});

	it("全局 <agentDir>/SYSTEM.md 对每个项目一致生效（同一来源，不算串账）", async () => {
		const globalDir = join(ROOT, "agent-global");
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(join(globalDir, "SYSTEM.md"), "global persona");
		const one = join(ROOT, "g-one");
		const two = join(ROOT, "g-two");
		mkdirSync(one, { recursive: true });
		mkdirSync(two, { recursive: true });
		for (const cwd of [one, two]) {
			const promptBase = createPromptBaseObservers();
			const services = await createAgentSessionServices({
				cwd,
				agentDir: globalDir,
				resourceLoaderOptions: {
					systemPromptOverride: promptBase.systemPromptOverride,
					appendSystemPromptOverride: promptBase.appendSystemPromptOverride,
				},
			});
			promptBase.bind(services.resourceLoader);
			expect(readPromptBase(services.resourceLoader).system).toBe("global persona");
		}
	});
});
