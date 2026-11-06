import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientStateStore } from "../../server/client-state.js";
import type { ServerMessage, UiSubagentTemplate } from "../../server/protocol.js";
import { SettingsService, type SettingsHost } from "../../server/settings-service.js";
import { DEFAULT_TEMPLATES, SubagentTemplatesStore } from "../../server/subagent-templates.js";
import { BUILTIN_TEMPLATES_HANT } from "../../server/subagent-templates-hant.js";

let dir: string;
let store: ClientStateStore;
let templates: SubagentTemplatesStore;
let emitted: ServerMessage[];

function makeHost(getLocale?: () => string | undefined): SettingsHost {
	return {
		clientId: "test-client",
		stateStore: store,
		emit: (msg) => void emitted.push(msg),
		flushSnapshot: () => {},
		isDisposed: () => false,
		getSession: () => {
			throw new Error("not ready");
		},
		cwd: () => dir,
		agentDir: () => dir,
		isStreaming: () => false,
		reloadSession: async () => {},
		applyRetryOverrides: () => {},
		applyCompactionOverrides: () => {},
		applyToolGating: () => {},
		promptSnapshot: () => ({ full: "", texts: {}, toolsSchema: "" }),
		...(getLocale ? { getLocale } : {}),
	};
}

function snapshotTemplate(name: string): UiSubagentTemplate | undefined {
	for (let i = emitted.length - 1; i >= 0; i--) {
		const m = emitted[i] as { type?: string; settings?: { subagentTemplates?: UiSubagentTemplate[] } };
		if (m?.type === "settings_state") return m.settings?.subagentTemplates?.find((t) => t.name === name);
	}
	return undefined;
}

const shipped = (name: string) => DEFAULT_TEMPLATES.find((t) => t.name === name)!;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "settings-tpl-locale-"));
	store = new ClientStateStore(join(dir, "client-state.json"));
	templates = new SubagentTemplatesStore(join(dir, "templates.json"));
	emitted = [];
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("设置快照的内置模板按界面语言出视图", () => {
	it("繁中界面（zh-TW / zh-HK / zh-Hant）：简介与提示词是繁中，英文字段不动", () => {
		for (const locale of ["zh-TW", "zh-HK", "zh-Hant"]) {
			emitted = [];
			new SettingsService(
				makeHost(() => locale),
				templates,
			).push();
			const t = snapshotTemplate("review");
			expect(t?.description, locale).toBe(BUILTIN_TEMPLATES_HANT.review!.description);
			expect(t?.systemPrompt, locale).toBe(BUILTIN_TEMPLATES_HANT.review!.systemPrompt);
			expect(t?.descriptionEn, locale).toBe(shipped("review").descriptionEn);
		}
	});

	it("简中 / 英文 / 未上报 / 宿主没接 getLocale：仍是出厂简中", () => {
		for (const getLocale of [() => "zh", () => "zh-CN", () => "en", () => undefined, undefined]) {
			emitted = [];
			new SettingsService(makeHost(getLocale), templates).push();
			const t = snapshotTemplate("review");
			expect(t?.description).toBe(shipped("review").description);
			expect(t?.systemPrompt).toBe(shipped("review").systemPrompt);
		}
	});

	it("locale 取最新值（用户切换语言后下一次快照即换视图）", () => {
		let locale: string | undefined = "zh";
		const svc = new SettingsService(
			makeHost(() => locale),
			templates,
		);
		svc.push();
		expect(snapshotTemplate("review")?.systemPrompt).toBe(shipped("review").systemPrompt);
		locale = "zh-TW";
		svc.push();
		expect(snapshotTemplate("review")?.systemPrompt).toBe(BUILTIN_TEMPLATES_HANT.review!.systemPrompt);
	});

	it("只是视图：库不被改写，用户改过的字段与自建模板原样出现在繁中快照里", () => {
		templates.upsert({ ...shipped("review"), systemPrompt: "我自己改的提示词" });
		templates.upsert({
			name: "mine",
			description: "自建",
			promptMode: "append",
			systemPrompt: "",
			enabledSkills: [],
			enabledExtensions: [],
			model: "",
			thinkingLevel: "",
			enabled: true,
		});
		new SettingsService(
			makeHost(() => "zh-TW"),
			templates,
		).push();
		const review = snapshotTemplate("review");
		expect(review?.systemPrompt).toBe("我自己改的提示词");
		expect(review?.description).toBe(BUILTIN_TEMPLATES_HANT.review!.description);
		expect(snapshotTemplate("mine")?.description).toBe("自建");
		expect(templates.get("review")?.description).toBe(shipped("review").description);
	});
});

describe("繁中界面保存模板：库里不被改写成繁体", () => {
	it("在繁中快照上只点启用开关 → 回传整个繁中视图，库里文字仍是出厂简中", async () => {
		const svc = new SettingsService(
			makeHost(() => "zh-TW"),
			templates,
		);
		svc.push();
		const view = snapshotTemplate("oracle")!;
		expect(view.systemPrompt).toBe(BUILTIN_TEMPLATES_HANT.oracle!.systemPrompt);
		await svc.saveTemplate({ ...view, enabled: false });
		const saved = templates.get("oracle")!;
		expect(saved.enabled).toBe(false);
		expect(saved.description).toBe(shipped("oracle").description);
		expect(saved.systemPrompt).toBe(shipped("oracle").systemPrompt);
	});
});
