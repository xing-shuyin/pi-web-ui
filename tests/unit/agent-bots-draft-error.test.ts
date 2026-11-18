// @vitest-environment jsdom
/**
 * 确认草案失败必须讲原因，而且草案不能被当成已消失。
 *
 * 以前失败原因被塞进列表加载错误（横幅只渲染「加载失败」+ 重试），用户看不到「目录无效 / Bot 忙」这类
 * 真正可行动的原因。这里守三件事：原因贴在待确认区、失败后草案仍在、重试直接重发同一次确认。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBotsSection } from "../../web/src/components/AgentBotsSection";
import { closeContextMenu } from "../../web/src/context-menu-state";

vi.mock("../../web/src/i18n", () => ({
	useI18n: () => ({ locale: "zh" }),
	isZhLocale: () => true,
	// 只翻译测试用得到的几个键（其余返回键名，渲染不依赖具体文案）。
	useT: () => (key: string) =>
		({
			agentBotsApprove: "创建",
			agentBotsRetry: "重试",
			agentBotsDraftErrorDismiss: "知道了",
			agentBotsDraftBusy: "Bot 正在执行任务，等它跑完再试。",
		})[key] ?? key,
}));

const draft = {
	id: "draft-1",
	name: "审 PR 助手",
	description: "只读审查",
	systemPrompt: "",
	cwd: "D:/project",
	tools: ["read"],
	trigger: "on_demand",
	bootstrap: true,
	highPrivilegeTools: [] as string[],
	createdBy: "model",
	createdAt: 1,
};

const response = (data: unknown, status = 200) =>
	({ ok: status < 400, status, json: async () => data }) as unknown as Response;

let root: Root | undefined;
let host: HTMLDivElement;

function stubApi(onApprove: (attempt: number) => Response) {
	let attempts = 0;
	const fetcher = vi.fn(async (url: string) => {
		const path = String(url).split("/api/device-center/")[1]?.split("?")[0] ?? "";
		if (path === "bot-panel") return response({ bots: [], drafts: [draft] });
		if (path === `bot-drafts/${draft.id}/approve`) return onApprove(++attempts);
		return response({});
	});
	vi.stubGlobal("fetch", fetcher);
	return fetcher;
}

async function settle(check: () => boolean) {
	for (let i = 0; i < 20 && !check(); i++) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

async function render() {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(createElement(AgentBotsSection, { active: true })));
	await settle(() => Boolean(host.querySelector(".lp-bot-draft")));
}

const button = (label: string, scope: ParentNode = host) =>
	[...scope.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);

afterEach(() => {
	closeContextMenu();
	vi.unstubAllGlobals();
	act(() => root?.unmount());
	root = undefined;
	host?.remove();
});

describe("待确认草案的失败提示", () => {
	it("没有 detail 时按 code 给出可行动原因，草案仍在，可直接重试", async () => {
		const fetcher = stubApi(() => response({ code: "BOT_BUSY", error: "Bot is busy" }, 409));
		await render();

		await act(async () => button("创建")!.click());
		await settle(() => Boolean(host.querySelector(".lp-bot-drafts-error")));

		const banner = host.querySelector(".lp-bot-drafts-error")!;
		expect(banner.getAttribute("role")).toBe("alert");
		expect(banner.textContent).toContain("Bot 正在执行任务，等它跑完再试。");
		// 失败不等于草案消失：卡还在，重试才有意义。
		expect(host.querySelector(".lp-bot-draft")).toBeTruthy();

		await act(async () => button("重试", banner)!.click());
		await settle(() => fetcher.mock.calls.filter(([url]) => String(url).endsWith("/approve")).length > 1);
		expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/approve"))).toHaveLength(2);
	});

	it("后端 detail 原样展示，`知道了` 收起提示后草案仍可再创建", async () => {
		const fetcher = stubApi(() => response({ code: "BOT_CWD_INVALID", detail: "目录不存在：D:/gone" }, 400));
		await render();

		await act(async () => button("创建")!.click());
		await settle(() => Boolean(host.querySelector(".lp-bot-drafts-error")));
		expect(host.querySelector(".lp-bot-drafts-error")!.textContent).toContain("目录不存在：D:/gone");

		await act(async () => button("知道了")!.click());
		expect(host.querySelector(".lp-bot-drafts-error")).toBeNull();
		expect(host.querySelector(".lp-bot-draft")).toBeTruthy();
		expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/approve"))).toHaveLength(1);
	});
});
