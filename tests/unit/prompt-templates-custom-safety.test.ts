// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TemplateProvider, useTemplates } from "../../web/src/components/PromptTemplates";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals";
import { LanguageProvider } from "../../web/src/i18n";

let root: Root | undefined;
let capturedTemplates: ReturnType<typeof useTemplates>["templates"] = [];

function Consumer() {
	capturedTemplates = useTemplates().templates;
	return createElement("span", { id: "tpl-count" }, capturedTemplates.length);
}

function mockTemplates(list: any[]) {
	vi.stubGlobal("fetch", (url: string) => {
		if (url.endsWith("/api/prompt-templates")) {
			return Promise.resolve({
				ok: true,
				json: async () => ({ templates: list }),
			});
		}
		return Promise.resolve({ ok: true, json: async () => ({}) });
	});
}

async function mountWithData(list: any[]) {
	localStorage.setItem("pi-web-ui:lang", "zh");
	mockTemplates(list);
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(TemplateProvider, {
					currentModelId: null,
					children: createElement(Consumer),
				}),
			),
		);
	});
	await act(async () => {
		setAppGlobals({ status: "open" });
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	capturedTemplates = [];
	document.body.innerHTML = "";
	localStorage.clear();
	resetAppGlobals();
	vi.unstubAllGlobals();
});

describe("prompt templates & user custom templates safety", () => {
	it("renders exactly 8 curated engineering workflows with commands by default", async () => {
		await mountWithData([]);
		expect(capturedTemplates).toHaveLength(8);

		const commands = capturedTemplates.map((t) => t.command);
		expect(commands).toEqual(["clarify", "plan", "tdd", "review", "debug", "merge", "spike", "research"]);

		const ids = capturedTemplates.map((t) => t.id);
		expect(ids).toContain("clarify");
		expect(ids).toContain("to-plan");
		expect(ids).toContain("implement");
		expect(ids).toContain("code-review");
		expect(ids).toContain("diagnosing-bugs");
		expect(ids).toContain("resolving-merge-conflicts");
		expect(ids).toContain("prototype");
		expect(ids).toContain("research");

		const titles = capturedTemplates.map((t) => t.title);
		expect(titles).toContain("需求对齐");
		expect(titles).toContain("规划与拆工单");
		expect(titles).toContain("测试驱动实现");
		expect(titles).toContain("代码审查");
		expect(titles).toContain("系统化排错");
		expect(titles).toContain("解决合并冲突");
		expect(titles).toContain("快速原型");
		expect(titles).toContain("有据调研");
	});

	it("strictly preserves user-created custom templates from local storage / server", async () => {
		const customTpl = {
			id: "my-custom-flow-123",
			icon: "🚀",
			title: "我的发布上线检查",
			desc: "检查打包体积、changelog 与发布标签",
			command: "pre-release",
			prompt: "请按三步走检查当前工作区的打包状态与发布标签...",
		};

		await mountWithData([customTpl]);

		expect(capturedTemplates).toHaveLength(9);

		const found = capturedTemplates.find((t) => t.id === "my-custom-flow-123");
		expect(found).toBeDefined();
		expect(found?.title).toBe("我的发布上线检查");
		expect(found?.desc).toBe("检查打包体积、changelog 与发布标签");
		expect(found?.command).toBe("pre-release");
		expect(found?.icon).toBe("🚀");
		expect(found?.prompt).toBe("请按三步走检查当前工作区的打包状态与发布标签...");
		expect(found?.builtin).toBeUndefined();
	});

	it("preserves user modifications to legacy removed templates as custom entries", async () => {
		const legacyModified = {
			id: "grill-me",
			icon: "🔍",
			title: "我魔改的需求拷问",
			desc: "针对业务边界进行拷问",
			command: "mygrill",
			prompt: "这是用户自己定制的详细盘问流程...",
		};

		await mountWithData([legacyModified]);

		expect(capturedTemplates).toHaveLength(9);

		const found = capturedTemplates.find((t) => t.id === "grill-me");
		expect(found).toBeDefined();
		expect(found?.title).toBe("我魔改的需求拷问");
		expect(found?.command).toBe("mygrill");
		expect(found?.prompt).toBe("这是用户自己定制的详细盘问流程...");
	});

	it("respects user overrides on continuing built-in templates", async () => {
		const override = {
			id: "diagnosing-bugs",
			title: "根因排查大师",
			desc: "用户自定义的快速排错指导",
			command: "superdebug",
			prompt: "先看最近的 Sentry 日志和终端报错...",
		};

		await mountWithData([override]);

		expect(capturedTemplates).toHaveLength(8);
		const found = capturedTemplates.find((t) => t.id === "diagnosing-bugs");
		expect(found).toBeDefined();
		expect(found?.title).toBe("根因排查大师");
		expect(found?.desc).toBe("用户自定义的快速排错指导");
		expect(found?.command).toBe("superdebug");
		expect(found?.prompt).toBe("先看最近的 Sentry 日志和终端报错...");
		expect(found?.builtin).toBe(true);
	});
});
