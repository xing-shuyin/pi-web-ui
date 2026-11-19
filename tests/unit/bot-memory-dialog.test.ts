// @vitest-environment jsdom
/**
 * 记忆面板（人侧）：能看见每条记忆的日期与置信度、能本地搜索、晋升要区分「确认并晋升」，
 * 且 Bot 自写条目命中不足两次时按钮点不动（服务端同样拒绝）。
 *
 * 文案走真实 `useT()` 的无 Provider 回退（英文），不再由组件内联 `zh ? :` 决定。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotMemoryDialog } from "../../web/src/components/BotMemoryDialog";
import { en } from "../../web/src/i18n";

const CREATED = Date.UTC(2024, 0, 2);
const entries = [
	{
		id: "m1",
		scope: "project",
		summary: "只读审查",
		text: "候选模型只读，不要改代码",
		kind: "fact",
		confidence: "unverified",
		source: "bot",
		sourceId: "chat-1",
		hits: 3,
		createdAt: CREATED,
	},
	{
		id: "m2",
		scope: "project",
		summary: "bot 自写一次",
		text: "刚写下的猜测",
		kind: "fact",
		confidence: "confirmed",
		source: "bot",
		sourceId: "chat-1",
		hits: 1,
		createdAt: CREATED,
	},
	{
		id: "m3",
		scope: "global",
		summary: "用户偏好",
		text: "回答用中文",
		kind: "preference",
		confidence: "confirmed",
		source: "user",
		sourceId: "user-1",
		hits: 0,
		createdAt: CREATED,
	},
];

const response = (data: unknown, status = 200) =>
	({ ok: status < 400, status, json: async () => data }) as unknown as Response;

let root: Root | undefined;
let host: HTMLDivElement;

function stubApi(promote: (id: string) => Response = () => response({})) {
	const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
		if (String(url).includes("/memory/promote")) {
			const body = JSON.parse(String(init!.body)) as { id: string };
			return promote(body.id);
		}
		if (String(url).endsWith("/memory")) return response({ scopes: [], entries });
		return response({});
	});
	vi.stubGlobal("fetch", fetcher);
	return fetcher;
}

async function render() {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(createElement(BotMemoryDialog, { botId: "bot-1", botName: "审 PR", onClose: () => {} })),
	);
	for (let i = 0; i < 20 && host.querySelectorAll(".lp-memory-entry").length === 0; i++) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

const card = (text: string) =>
	[...host.querySelectorAll<HTMLElement>(".lp-memory-entry")].find((node) => node.textContent?.includes(text)) ?? null;
const promoteButton = (text: string) =>
	card(text)?.querySelector<HTMLButtonElement>(".lp-memory-entry-actions button") ?? null;

afterEach(() => {
	vi.unstubAllGlobals();
	act(() => root?.unmount());
	root = undefined;
	host?.remove();
});

describe("Bot 记忆面板", () => {
	it("每条显示创建日期与置信度，本地搜索按摘要/正文过滤", async () => {
		stubApi();
		await render();
		expect(host.querySelectorAll(".lp-memory-entry")).toHaveLength(3);
		const first = card("候选模型只读")!;
		expect(first.textContent).toContain(
			en["botMemory.created"].replace("{date}", new Date(CREATED).toLocaleDateString()),
		);
		expect(first.querySelector(".lp-memory-badge")?.textContent).toBe("unverified");

		const search = host.querySelector<HTMLInputElement>("input[type=search]")!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "中文");
			search.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(host.querySelectorAll(".lp-memory-entry")).toHaveLength(1);
		expect(host.textContent).toContain("回答用中文");

		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "没有这一条");
			search.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(host.querySelectorAll(".lp-memory-entry")).toHaveLength(0);
		expect(host.textContent).toContain(en["botMemory.searchEmpty"].replace("{query}", "没有这一条"));
	});

	it("未确认条目「确认并晋升」带 confirm:true，已确认条目直接晋升", async () => {
		const fetcher = stubApi();
		await render();

		await act(async () => promoteButton("候选模型只读")!.click());
		const unverifiedCall = fetcher.mock.calls.find(([url]) => String(url).includes("/memory/promote"))!;
		expect(JSON.parse(String(unverifiedCall[1]!.body))).toEqual({ id: "m1", confirm: true });

		await act(async () => promoteButton("回答用中文")!.click());
		const confirmedCall = fetcher.mock.calls.filter(([url]) => String(url).includes("/memory/promote"))[1]!;
		expect(JSON.parse(String(confirmedCall[1]!.body))).toEqual({ id: "m3" });
	});

	it("Bot 自写且命中不足两次的条目不能晋升，title 说明原因", async () => {
		stubApi();
		await render();
		const blocked = promoteButton("刚写下的猜测")!;
		expect(blocked.disabled).toBe(true);
		expect(blocked.getAttribute("title")).toBe(en["botMemory.promoteBlocked"]);
	});

	it("晋升失败原因显示在面板内（不是只塞 title）", async () => {
		stubApi(() => response({ code: "MEMORY_RESIDENT_FULL", error: "MEMORY.md is full (2KB)" }, 409));
		await render();
		await act(async () => promoteButton("候选模型只读")!.click());
		for (let i = 0; i < 20 && !host.querySelector(".lp-memory-error"); i++) {
			await act(async () => {
				await Promise.resolve();
			});
		}
		const banner = host.querySelector(".lp-memory-error")!;
		expect(banner.getAttribute("role")).toBe("alert");
		expect(banner.textContent).toBe("MEMORY.md is full (2KB)");
	});
});
