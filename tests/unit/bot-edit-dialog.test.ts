// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotEditDialog } from "../../web/src/components/BotEditDialog";

/**
 * 左栏右键「编辑 Bot」= **就地弹编辑器**，不再切到设备中心。
 *
 * 这里守两条边界：
 * 1. 编辑器里落的是服务端返回的**完整** Bot（左栏 `bot-panel` 的投影没有提示词/工具，拼出来会清空字段）；
 * 2. 保存后弹窗自己收尾（`onClose`），并且提交的是带 `id`/`revision` 的整份草稿。
 */

vi.mock("../../web/src/i18n", () => ({
	useI18n: () => ({ locale: "zh" }),
	isZhLocale: () => true,
	useT: () => (key: string) => key,
}));

const bot = {
	id: "bot-1",
	revision: 3,
	name: "爱山东",
	description: "diag",
	systemPrompt: "你是诊断助手",
	cwd: "E:/pi-web-ui",
	tools: ["read"],
	skills: [],
	mcpServers: [],
	enabled: true,
};
const options = {
	cwd: bot.cwd,
	defaultCwd: bot.cwd,
	defaultModel: "openrouter/anthropic/claude",
	models: [],
	tools: [{ id: "read", name: "Read files", description: "Inspect files" }],
	skills: [],
	mcpServers: [],
	projects: [],
	defaultTools: [],
};
const response = (data: unknown, ok = true, status = 200) =>
	({ ok, status, json: async () => data }) as unknown as Response;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function stubApi(botResult: () => Response, posts: unknown[] = []) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const path = String(url).split("/api/device-center/")[1]?.split("?")[0] ?? "";
			if (path === "local-bots/bot-1") return botResult();
			if (path.startsWith("local-bot-options")) return response(options);
			if (path === "local-bots" && init?.method === "POST") {
				posts.push(JSON.parse(String(init.body)));
				return response({ bot: { ...bot, revision: 4 }, synced: true });
			}
			return response({});
		}),
	);
}

async function render(onClose = vi.fn()) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(createElement(BotEditDialog, { botId: bot.id, onClose })));
	// 等「取 Bot → 挂编辑器（内部还要拉一次 options）」这两跳。
	for (let i = 0; i < 30 && !document.querySelector(".dc-bot-editor"); i++) {
		await act(async () => {
			await Promise.resolve();
		});
	}
	return onClose;
}

afterEach(() => {
	vi.unstubAllGlobals();
	act(() => root?.unmount());
	root = undefined;
	host?.remove();
	host = undefined;
	document.body.innerHTML = "";
});

describe("编辑 Bot 的就地弹窗", () => {
	it("按 id 取完整 Bot 后直接打开编辑器（不跳设备中心）", async () => {
		stubApi(() => response({ bot }));
		await render();
		const nameInput = document.querySelector<HTMLInputElement>("#bot-panel-identity input");
		expect(nameInput?.value).toBe(bot.name);
		const prompt = document.querySelector<HTMLTextAreaElement>(".dc-bot-prompt");
		expect(prompt?.value).toBe(bot.systemPrompt);
	});

	it("取不到 Bot 时给错误和关闭入口，不留空白弹窗", async () => {
		stubApi(() => response({ error: "Bot is not configured on this device" }, false, 404));
		const onClose = await render();
		const alert = document.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain("Bot is not configured on this device");
		expect(document.querySelector(".dc-bot-editor")).toBeNull();
		const close = [...document.querySelectorAll("button")].find(
			(button) => button.textContent === "agentBotsMemoryClose",
		);
		expect(close).toBeTruthy();
		await act(async () => close!.click());
		expect(onClose).toHaveBeenCalled();
	});

	it("保存提交带 id/revision 的整份草稿，并关闭弹窗", async () => {
		const posts: unknown[] = [];
		stubApi(() => response({ bot }), posts);
		const onClose = await render();
		const form = document.querySelector<HTMLFormElement>(".dc-bot-editor")!;
		const save = [...form.querySelectorAll("button")].find((button) => button.textContent === "localBotSave")!;
		await act(async () => save.click());
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({
			id: bot.id,
			revision: bot.revision,
			name: bot.name,
			systemPrompt: bot.systemPrompt,
			tools: bot.tools,
		});
		expect(onClose).toHaveBeenCalled();
	});
});
