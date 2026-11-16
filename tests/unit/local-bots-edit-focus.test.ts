// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { LocalBots } from "../../web/src/components/LocalBots.js";
import { clearBotEditRequest, requestBotEdit } from "../../web/src/bot-edit.js";

/**
 * 左栏智能体右键「编辑 Bot」→ 设备中心的 Bot 编辑器打开的就是那个 Bot。
 * 跨视图 + 异步拉列表，请求要能被"存放一下"，所以这里验的是 pending 被消费、
 * 编辑器里落的是目标 Bot（而不是默认空表单）。
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
	systemPrompt: "",
	cwd: "E:/pi-web-ui",
	tools: [],
	skills: [],
	mcpServers: [],
	enabled: true,
};

let root: Root | undefined;

afterEach(() => {
	clearBotEditRequest();
	vi.unstubAllGlobals();
	if (root) {
		act(() => root!.unmount());
		root = undefined;
	}
	document.body.innerHTML = "";
});

async function mount() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			const path = String(url).split("/api/device-center/")[1]?.split("?")[0] ?? "";
			const data =
				path === "local-bots"
					? { bots: [bot] }
					: {
							cwd: bot.cwd,
							defaultCwd: bot.cwd,
							models: [],
							tools: [],
							skills: [],
							mcpServers: [],
							projects: [],
							defaultTools: [],
						};
			return { ok: true, status: 200, json: async () => data } as unknown as Response;
		}),
	);
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(createElement(LocalBots, {})));
	// 等一轮「拉列表 → 渲染」
	for (let i = 0; i < 20 && !host.querySelector(".dc-bot-item"); i++) {
		await act(async () => {
			await Promise.resolve();
		});
	}
	return host;
}

describe("编辑 Bot 的跨视图跳转", () => {
	it("挂载后才收到请求：直接打开该 Bot 的编辑器", async () => {
		const host = await mount();
		expect(host.querySelector(".dc-bot-workspace.is-editing")).toBeNull();
		await act(async () => {
			requestBotEdit(bot.id);
		});
		const nameInput = host.querySelector<HTMLInputElement>("#bot-panel-identity input");
		expect(nameInput?.value).toBe(bot.name);
	});

	it("请求早于挂载：靠 pending 补上，不丢", async () => {
		requestBotEdit(bot.id);
		const host = await mount();
		const nameInput = host.querySelector<HTMLInputElement>("#bot-panel-identity input");
		expect(nameInput?.value).toBe(bot.name);
	});
});
