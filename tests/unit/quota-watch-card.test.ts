// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuotaCard } from "../../plugins/quota-watch/client/card.mjs";
import { createSummaryStore } from "../../plugins/quota-watch/client/store.mjs";

function summaryPayload(overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		updatedAt: new Date().toISOString(),
		staleMs: 0,
		ttlMs: 60_000,
		refreshSeconds: 60,
		lastGoodAt: new Date().toISOString(),
		providers: [
			{
				id: "deepseek",
				name: "DeepSeek",
				status: "ok",
				plan: "Pro",
				windows: [{ label: "5 小时窗口", remainingPercent: 12.34, resetAt: "2099-01-01T00:00:00Z" }],
				balance: { text: "¥14.46" },
				extra: [{ label: "充值", value: "¥20.00" }],
			},
		],
		...overrides,
	};
}

let fetchCalls: string[] = [];
let payload: any = summaryPayload();
let container: HTMLElement;

beforeEach(() => {
	document.documentElement.lang = "zh-CN";
	fetchCalls = [];
	payload = summaryPayload();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			fetchCalls.push(String(url));
			return { ok: true, status: 200, json: async () => payload };
		}),
	);
	container = document.createElement("div");
	document.body.appendChild(container);
});

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
	document.documentElement.removeAttribute("lang");
});

/** 等内容里的 fetch 落地并画完 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("底栏小卡片的内容（外壳归宿主）", () => {
	it("往宿主给的容器里画当前供应商，并留上卡片类名", async () => {
		const cleanup = createQuotaCard({ apiBase: "/plugins-api/quota-watch" })(container);
		await settle();
		expect(container.classList.contains("qw-card")).toBe(true);
		expect(container.querySelector('[data-role="name"]')?.textContent).toBe("DeepSeek");
		expect(container.querySelector('[data-role="plan"]')?.textContent).toBe("Pro");
		expect(container.querySelector(".qw-win-pct")?.textContent).toBe("12.3%");
		expect(container.querySelector(".qw-amount")?.textContent).toBe("¥14.46");
		expect(container.querySelector(".qw-chip")?.textContent).toBe("充值 ¥20.00");
		// 新鲜度是这一版的重点：卡片必须自己说清数据有多旧
		expect(container.querySelector('[data-role="age"]')?.textContent).toBe("刚刚");
		expect(container.querySelector('[data-role="auto"]')?.textContent).toContain("每分钟");
		expect(fetchCalls).toHaveLength(1);
		cleanup();
	});

	it("认不出当前模型时给一句人话，而不是空白", async () => {
		payload = summaryPayload({ providers: [] });
		const cleanup = createQuotaCard({ apiBase: "/x" })(container);
		await settle();
		expect(container.querySelector(".qw-empty")?.textContent).toContain("没有对应的额度来源");
		cleanup();
	});

	it("⟳ 用 force=1 绕过缓存重取", async () => {
		const cleanup = createQuotaCard({ apiBase: "/x" })(container);
		await settle();
		(container.querySelector('[data-role="refresh"]') as HTMLElement).click();
		await settle();
		expect(fetchCalls.some((url) => url.includes("force=1"))).toBe(true);
		cleanup();
	});

	it("数据比 TTL 旧时标成陈旧并给出「上次成功」", async () => {
		const updatedAt = new Date(Date.now() - 5 * 60_000).toISOString();
		payload = summaryPayload({
			updatedAt,
			staleMs: 5 * 60_000,
			providers: [
				{
					id: "deepseek",
					name: "DeepSeek",
					status: "error",
					error: "余额接口超时",
					balance: { text: "¥14.46" },
					stale: true,
					staleSince: updatedAt,
				},
			],
		});
		const cleanup = createQuotaCard({ apiBase: "/x" })(container);
		await settle();
		expect(container.querySelector(".qw-amount")?.getAttribute("data-stale")).toBe("1");
		expect(container.querySelector('[data-role="age"]')?.getAttribute("data-stale")).toBe("");
		expect(container.querySelector('[data-role="age"]')?.textContent).toContain("陈旧");
		expect(container.querySelector(".qw-note[data-kind='stale']")?.textContent).toContain("上次成功读取");
		cleanup();
	});

	it("清理函数停掉轮询、摘掉卡片类名（宿主关浮层时调用）", async () => {
		const cleanup = createQuotaCard({ apiBase: "/x" })(container);
		await settle();
		cleanup();
		expect(container.classList.contains("qw-card")).toBe(false);
		// 关掉后不再画：插件后续不会往已卸载的容器里写
		const before = fetchCalls.length;
		(container.querySelector('[data-role="refresh"]') as HTMLElement | null)?.click();
		await settle();
		expect(fetchCalls).toHaveLength(before);
	});
});

describe("底栏与浮层共用一份快照", () => {
	it("两张卡订阅同一个 store：只发一次请求，刷新一次两边同时变", async () => {
		const store = createSummaryStore({ apiBase: "/x" });
		const render = createQuotaCard({ apiBase: "/x", store });
		const other = document.createElement("div");
		document.body.appendChild(other);
		const cleanupA = render(container);
		const cleanupB = render(other);
		await settle();
		await settle();
		expect(fetchCalls).toHaveLength(1);
		expect(container.querySelector(".qw-amount")?.textContent).toBe("¥14.46");
		expect(other.querySelector(".qw-amount")?.textContent).toBe("¥14.46");

		payload = summaryPayload({
			providers: [{ id: "deepseek", name: "DeepSeek", status: "ok", balance: { text: "¥14.00" }, windows: [] }],
		});
		(container.querySelector('[data-role="refresh"]') as HTMLElement).click();
		await settle();
		await settle();
		expect(fetchCalls.filter((url) => url.includes("force=1"))).toHaveLength(1);
		// 浮层里点的那一下，另一个订阅者（底栏那格走的是同一个 store）同步拿到新值
		expect(other.querySelector(".qw-amount")?.textContent).toBe("¥14.00");
		cleanupA();
		cleanupB();
	});

	it("浮层关掉后不再有卡片订阅者，轮询回到慢档", async () => {
		const store = createSummaryStore({ apiBase: "/x", idleMs: 60_000, activeMs: 15_000 });
		store.start();
		expect(store.intervalMs()).toBe(60_000);
		const release = store.hold();
		expect(store.intervalMs()).toBe(15_000);
		release();
		expect(store.intervalMs()).toBe(60_000);
		store.stop();
	});
});
