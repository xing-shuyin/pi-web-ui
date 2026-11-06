// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../../web/src/i18n";
import { GroupRouterSettings, type GroupRouterConfig } from "../../web/src/components/GroupRouterSettings";
import { GroupWorkItems } from "../../web/src/components/GroupWorkItems";

let root: Root;
let host: HTMLDivElement;
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as Response;
const config: GroupRouterConfig = {
	enabled: false,
	deviceId: "local",
	model: "p/local-model",
	thinkingLevel: "off",
	tools: ["reply"],
};
function mockApi(handler?: (url: URL, init: RequestInit) => Response | Promise<Response> | undefined) {
	return vi.fn(async (path: string, init: RequestInit = {}) => {
		const url = new URL(path, window.location.href);
		const custom = handler?.(url, init);
		if (custom !== undefined) return custom;
		if (url.pathname.endsWith("/devices"))
			return response({
				devices: [
					{ id: "local", name: "Local", online: true },
					{ id: "remote", name: "Remote", online: true },
				],
			});
		if (url.pathname.endsWith("/chat-status")) return response({ deviceId: "local" });
		if (url.pathname.endsWith("/router-models")) {
			const deviceId = url.searchParams.get("deviceId");
			return response({
				deviceId,
				models: [{ provider: "p", id: `${deviceId}-model`, name: `${deviceId} model`, reasoning: true }],
			});
		}
		return response({});
	});
}
async function mount(element: React.ReactElement) {
	await act(async () => root.render(createElement(LanguageProvider, null, element)));
}
async function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
			"value",
		)!.set!.call(element, value);
		element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
	});
}
function button(pattern: RegExp) {
	return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => pattern.test(item.textContent ?? ""))!;
}
beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
describe("group Router settings", () => {
	it("binds the model to its device, clears it on device change and saves independent permissions", async () => {
		const saved = vi.fn();
		const posts: any[] = [];
		vi.stubGlobal(
			"fetch",
			mockApi((_url, init) => {
				if (init.method === "POST") {
					posts.push(JSON.parse(String(init.body)));
					return response({});
				}
			}),
		);
		await mount(createElement(GroupRouterSettings, { roomId: "room", router: config, onSaved: saved }));
		const selects = host.querySelectorAll("select");
		await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
		await change(selects[0], "remote");
		expect(host.querySelector<HTMLInputElement>('input[placeholder="provider/modelId"]')!.value).toBe("");
		expect(button(/Save Router settings|保存 Router 配置/).disabled).toBe(true);
		await change(host.querySelector<HTMLInputElement>('input[placeholder="provider/modelId"]')!, "p/local-model");
		expect(button(/Save Router settings|保存 Router 配置/).disabled).toBe(true);
		await change(selects[1], "p/remote-model");
		await change(selects[2], "high");
		await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[2].click());
		await act(async () => button(/Save Router settings|保存 Router 配置/).click());
		expect(posts).toEqual([
			{
				router: {
					enabled: true,
					deviceId: "remote",
					model: "p/remote-model",
					thinkingLevel: "high",
					tools: ["reply", "dispatch"],
				},
			},
		]);
		expect(saved).toHaveBeenCalledOnce();
	});
	it("rejects a catalog for a different device instead of enabling a fallback model", async () => {
		vi.stubGlobal(
			"fetch",
			mockApi((url) =>
				url.pathname.endsWith("/router-models")
					? response({ deviceId: "other", models: [{ provider: "p", id: "local-model" }] })
					: undefined,
			),
		);
		await mount(
			createElement(GroupRouterSettings, { roomId: "room", router: { ...config, enabled: true }, onSaved: vi.fn() }),
		);
		expect(button(/Save Router settings|保存 Router 配置/).disabled).toBe(true);
		expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/does not match|不匹配/);
	});
	it("ignores an old device catalog arriving after the user switches devices", async () => {
		let release!: (value: Response) => void;
		vi.stubGlobal(
			"fetch",
			mockApi((url) =>
				url.pathname.endsWith("/router-models") && url.searchParams.get("deviceId") === "local"
					? new Promise<Response>((resolve) => {
							release = resolve;
						})
					: undefined,
			),
		);
		await mount(
			createElement(GroupRouterSettings, { roomId: "room", router: { ...config, enabled: true }, onSaved: vi.fn() }),
		);
		await change(host.querySelectorAll("select")[0], "remote");
		await act(async () => release(response({ deviceId: "local", models: [{ provider: "p", id: "local-model" }] })));
		expect(host.querySelectorAll("select")[1].textContent).toContain("remote model");
		expect(host.querySelectorAll("select")[1].textContent).not.toContain("local-model");
		expect(button(/Save Router settings|保存 Router 配置/).disabled).toBe(true);
	});
});
const workItem = {
	id: "ticket",
	title: "Investigate failure",
	text: "Customer request",
	source: { provider: "webhook", channelId: "support", threadId: "thread" },
	sourceTrust: { verified: true },
	authorization: { mode: "observe", authorizedBy: "policy" },
	status: "open",
	revision: 3,
	taskIds: ["task-a", "task-b"],
	updatedAt: 1,
};
describe("group work items", () => {
	it("lets a previously authorized item explicitly approve a newly observed event", async () => {
		let item: any = {
			...workItem,
			authorized: true,
			manualAuthorized: true,
			pendingAuthorization: true,
			latestEvent: {
				id: "new-event",
				text: "A new followup needs approval",
				author: { id: "requester" },
				authorized: false,
			},
		};
		const updates: any[] = [];
		vi.stubGlobal(
			"fetch",
			mockApi((_url, init) => {
				if (init.method === "PATCH") {
					updates.push(JSON.parse(String(init.body)));
					item = { ...item, pendingAuthorization: false, revision: 4 };
					return response({ workItem: item });
				}
				return response({ workItems: [item], routerJobs: [] });
			}),
		);
		await mount(createElement(GroupWorkItems, { roomId: "room" }));
		expect(host.textContent).toContain("A new followup needs approval");
		await act(async () => button(/Authorize latest event|授权最新事件/).click());
		expect(updates).toEqual([{ revision: 3, status: "open", authorize: true }]);
		expect(button(/Authorize latest event|授权最新事件/)).toBeUndefined();
	});
	it("paginates with cursors, merges refreshed revisions without losing older items and resets on room change", async () => {
		let polls = 0;
		const cursors: (string | null)[] = [];
		vi.stubGlobal(
			"fetch",
			mockApi((url) => {
				if (url.pathname.includes("/other/"))
					return response({ workItems: [{ ...workItem, id: "other", title: "Other room" }], nextCursor: null });
				const before = url.searchParams.get("before");
				cursors.push(before);
				if (before === "cursor one")
					return response({
						workItems: [
							{ ...workItem, id: "old", title: "Older item", createdAt: 1 },
							{ ...workItem, createdAt: 2 },
						],
						nextCursor: "cursor two",
					});
				if (before === "cursor two")
					return response({
						workItems: [{ ...workItem, id: "oldest", title: "Oldest item", createdAt: 0 }],
						nextCursor: null,
					});
				polls++;
				return response({
					workItems: [
						{
							...workItem,
							createdAt: 2,
							revision: polls > 1 ? 4 : 3,
							title: polls > 1 ? "Updated item" : workItem.title,
						},
					],
					nextCursor: "cursor one",
				});
			}),
		);
		await mount(createElement(GroupWorkItems, { roomId: "room" }));
		await act(async () => button(/Load more work items|加载更多工单/).click());
		expect(host.querySelectorAll("article")).toHaveLength(2);
		await act(async () => vi.advanceTimersByTimeAsync(5000));
		expect(host.textContent).toContain("Older item");
		expect(host.textContent).toContain("Updated item");
		expect(host.querySelectorAll("article")).toHaveLength(2);
		await act(async () => button(/Load more work items|加载更多工单/).click());
		expect(cursors.filter((cursor) => cursor !== null)).toEqual(["cursor one", "cursor two"]);
		expect(polls).toBeGreaterThanOrEqual(2);
		expect(host.querySelectorAll("article")).toHaveLength(3);
		expect(button(/Load more work items|加载更多工单/)).toBeUndefined();
		await mount(createElement(GroupWorkItems, { roomId: "other" }));
		expect(host.querySelectorAll("article")).toHaveLength(1);
		expect(host.textContent).toContain("Other room");
		expect(host.textContent).not.toContain("Older item");
	});
	it("retries a failed Router job and refreshes its status", async () => {
		let retried = false;
		const fetcher = mockApi((url, init) => {
			if (init.method === "POST") {
				expect(url.pathname).toBe("/api/device-center/rooms/room/router/jobs/job/retry");
				expect(JSON.parse(String(init.body))).toEqual({});
				retried = true;
				return response({});
			}
			return response({
				workItems: [],
				routerJobs: [{ id: "job", status: retried ? "queued" : "failed", updatedAt: 1 }],
			});
		});
		vi.stubGlobal("fetch", fetcher);
		await mount(createElement(GroupWorkItems, { roomId: "room" }));
		await act(async () => button(/Retry Router run|重试 Router 运行/).click());
		expect(retried).toBe(true);
		expect(button(/Retry Router run|重试 Router 运行/)).toBeUndefined();
	});
	it("shows a retry conflict for a job whose Router configuration changed", async () => {
		vi.stubGlobal(
			"fetch",
			mockApi((_url, init) =>
				init.method === "POST"
					? response({ error: "Router configuration changed; old job cannot be retried" }, 409)
					: response({ workItems: [], routerJobs: [{ id: "job", status: "failed", updatedAt: 1 }] }),
			),
		);
		await mount(createElement(GroupWorkItems, { roomId: "room" }));
		await act(async () => button(/Retry Router run|重试 Router 运行/).click());
		await act(async () => vi.advanceTimersByTimeAsync(5000));
		expect(host.querySelector('[role="alert"]')?.textContent).toContain("old job cannot be retried");
		expect(button(/Retry Router run|重试 Router 运行/).disabled).toBe(false);
	});
	it("preserves source and execution history, uses revisions for authorize, pause, resume and completion", async () => {
		let current = { ...workItem };
		const patches: any[] = [];
		vi.stubGlobal(
			"fetch",
			mockApi((url, init) => {
				if (init.method === "PATCH") {
					const body = JSON.parse(String(init.body));
					patches.push(body);
					current = {
						...current,
						status: body.status,
						revision: current.revision + 1,
						authorization: body.authorize ? { mode: "auto", authorizedBy: "human" } : current.authorization,
					};
					return response({ workItem: current });
				}
				if (url.pathname.endsWith("/work-items"))
					return response({
						workItems: [current],
						routerJobs: [{ id: "job", status: "failed", error: "Model unavailable", updatedAt: 2 }],
					});
			}),
		);
		await mount(createElement(GroupWorkItems, { roomId: "room" }));
		expect(host.textContent).toContain("webhook / support / thread");
		expect(host.textContent).toContain("observe");
		expect(host.textContent).toContain("task-a");
		expect(host.textContent).toContain("task-b");
		expect(host.textContent).toContain("Model unavailable");
		await act(async () => button(/^Authorize$|手动授权/).click());
		await act(async () => button(/^Pause$|^暂停$/).click());
		await act(async () => button(/^Resume$|^恢复$/).click());
		await act(async () => button(/^Complete$|完成工单/).click());
		expect(patches).toEqual([
			{ revision: 3, status: "open", authorize: true },
			{ revision: 4, status: "blocked" },
			{ revision: 5, status: "open" },
			{ revision: 6, status: "completed" },
		]);
		expect(host.textContent).toContain("auto");
	});
	it("disables authorization for an unverified source", async () => {
		vi.stubGlobal(
			"fetch",
			mockApi(() => response({ workItems: [{ ...workItem, sourceTrust: { verified: false } }], routerJobs: [] })),
		);
		await mount(createElement(GroupWorkItems, { roomId: "room" }));
		expect(button(/^Authorize$|手动授权/).disabled).toBe(true);
		expect(host.textContent).toMatch(/source is unverified|来源未经验证/);
	});
	it("shows revision conflicts without closing or optimistically authorizing the work item", async () => {
		vi.stubGlobal(
			"fetch",
			mockApi((_url, init) =>
				init.method === "PATCH" ? response({ error: "Revision conflict" }, 409) : response({ workItems: [workItem] }),
			),
		);
		await mount(createElement(GroupWorkItems, { roomId: "room" }));
		await act(async () => button(/^Authorize$|手动授权/).click());
		expect(host.querySelector('[role="alert"]')?.textContent).toBe("Revision conflict");
		expect(host.textContent).toContain("observe");
		expect(button(/^Authorize$|手动授权/).disabled).toBe(false);
	});
});
