// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBotsSection } from "../../web/src/components/AgentBotsSection";
import { closeContextMenu, getContextMenu } from "../../web/src/context-menu-state";

/**
 * 左栏「智能体」Bot 行的右键菜单：
 * 菜单项是宿主条目（`contextmenu.bot`），动作必须在本地跑通——私聊 / 引用到对话 / 编辑 / 记忆 / 复制。
 * 这里只认"菜单被打开 + 条目齐全 + 动作真的派发了对应事件"，不重写一遍跳转实现。
 */

vi.mock("../../web/src/i18n", () => ({
	useI18n: () => ({ locale: "zh" }),
	isZhLocale: () => true,
	useT: () => (key: string) => key,
}));

const bot = {
	id: "bot-1",
	name: "爱山东",
	enabled: true,
	deviceName: "DESKTOP-S1QKEI6",
	online: true,
	local: true,
	busy: false,
};
const panel = { bots: [bot], rooms: [], drafts: [], roomsAvailable: true };
// 编辑器要的是 `/local-bots/:id` 的完整 Bot（左栏投影没有提示词/工具）。
const fullBot = {
	id: bot.id,
	revision: 1,
	name: bot.name,
	description: "",
	systemPrompt: "",
	cwd: "E:/pi-web-ui",
	tools: [],
	skills: [],
	mcpServers: [],
	enabled: true,
};
const botOptions = {
	cwd: fullBot.cwd,
	defaultCwd: fullBot.cwd,
	models: [],
	tools: [],
	skills: [],
	mcpServers: [],
	projects: [],
	defaultTools: [],
};
const response = (data: unknown, status = 200) =>
	({ ok: status < 400, status, json: async () => data }) as unknown as Response;

let root: Root | undefined;
let host: HTMLDivElement;

function stubApi(data: typeof panel = panel) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			const path = String(url).split("/api/device-center/")[1]?.split("?")[0] ?? "";
			if (path === "bot-panel") return response(data);
			if (path.startsWith("local-bots/")) return response({ bot: fullBot });
			if (path.startsWith("local-bot-options")) return response(botOptions);
			return response({});
		}),
	);
}

async function render(data: typeof panel = panel) {
	stubApi(data);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(createElement(AgentBotsSection, { active: true })));
	// Bot 列表是异步拉取的：等到行渲染出来再断言。
	for (let i = 0; i < 20 && !host.querySelector(".lp-bot-row"); i++) {
		await act(async () => {
			await Promise.resolve();
		});
	}
	const row = host.querySelector<HTMLElement>(".lp-bot-row");
	expect(row).toBeTruthy();
	return row!;
}

afterEach(() => {
	closeContextMenu();
	vi.unstubAllGlobals();
	act(() => root?.unmount());
	root = undefined;
	host?.remove();
});

describe("智能体区 Bot 行右键菜单", () => {
	it("右键打开 contextmenu.bot，条目覆盖私聊/新开对话/引用/历史/编辑/管理/记忆/复制", async () => {
		const row = await render();
		// 右键点在整行容器上（行本身是按钮，容器负责接管 contextmenu）。
		await act(async () => {
			row.parentElement!.dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }),
			);
		});
		const menu = getContextMenu();
		expect(menu?.slot).toBe("contextmenu.bot");
		expect(menu?.target).toMatchObject({ id: bot.id, kind: "agent-bot", label: bot.name });
		expect(menu?.entries.map((entry) => entry.action)).toEqual([
			"chat",
			// 默认点行 = 回到同一个私聊；「新开对话」才是另起一条（fresh）。
			"new-chat",
			"reference",
			"history",
			"edit",
			"manage",
			"memory",
			"copy-id",
		]);
		expect(menu?.entries.every((entry) => entry.source === "host" && entry.slot === "contextmenu.bot")).toBe(true);
	});

	it("历史对话动作打开面板，并列出这个 Bot 的转录接口", async () => {
		const row = await render();
		await act(async () => {
			row.parentElement!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		});
		const menu = getContextMenu()!;
		const history = menu.entries.find((entry) => entry.action === "history")!;
		await act(async () => {
			menu.onHostAction?.(history, menu.target);
		});
		expect(host.querySelector(".lp-bot-history")).toBeTruthy();
		const urls = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map(([url]) =>
			String(url),
		);
		expect(urls.some((url) => url.includes(`/local-bots/${bot.id}/sessions`))).toBe(true);
	});

	it("编辑 Bot 就地弹编辑器，不切到设备中心", async () => {
		const row = await render();
		const switched: unknown[] = [];
		const onOpen = (event: Event) => switched.push((event as CustomEvent).detail);
		window.addEventListener("pi-web-ui:device-group-open", onOpen);
		await act(async () => {
			row.parentElement!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		});
		const menu = getContextMenu()!;
		const edit = menu.entries.find((entry) => entry.action === "edit")!;
		await act(async () => {
			menu.onHostAction?.(edit, menu.target);
		});
		window.removeEventListener("pi-web-ui:device-group-open", onOpen);
		expect(switched).toEqual([]);
		// 弹窗是 portal 到 body 的：等「取 Bot → 挂编辑器」。
		for (let i = 0; i < 30 && !document.querySelector(".dc-bot-editor"); i++) {
			await act(async () => {
				await Promise.resolve();
			});
		}
		expect(document.querySelector(".dc-bot-editor")).toBeTruthy();
	});

	it("Bot 有未完成任务时行上标「执行中」", async () => {
		await render({ ...panel, bots: [{ ...bot, busy: true }] });
		expect(host.querySelector(".lp-bot-busy")).toBeTruthy();
	});

	it("引用到对话派出 @ 提及请求，交给输入框落地", async () => {
		const row = await render();
		const seen: { botId: string; name: string }[] = [];
		const onMention = (event: Event) => seen.push((event as CustomEvent<{ botId: string; name: string }>).detail);
		window.addEventListener("pi-web:composer-mention", onMention);
		await act(async () => {
			row.parentElement!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		});
		const menu = getContextMenu()!;
		const reference = menu.entries.find((entry) => entry.action === "reference")!;
		await act(async () => {
			menu.onHostAction?.(reference, menu.target);
		});
		window.removeEventListener("pi-web:composer-mention", onMention);
		expect(seen).toEqual([{ botId: bot.id, name: bot.name }]);
	});
});
