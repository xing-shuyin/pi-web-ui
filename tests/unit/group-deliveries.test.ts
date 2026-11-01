// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupDeliveries } from "../../web/src/components/GroupDeliveries";
import { LanguageProvider } from "../../web/src/i18n";
import type { GroupBotConversation } from "../../web/src/device-group-messages";
import type { DeviceDelivery, DeviceReview } from "../../web/src/types";

vi.mock("../../web/src/i18n", () => ({
	LanguageProvider: ({ children }: { children: import("react").ReactNode }) => children,
	useI18n: () => ({ locale: "en" }),
	isZhLocale: (locale: string) => locale.startsWith("zh"),
}));

const delivery: DeviceDelivery = {
	id: "delivery-v2",
	conversationId: "stable/bot",
	accountId: "account",
	roomId: "room",
	botId: "bot",
	taskId: "task",
	repository: "/long/repository/path",
	baseCommit: "a".repeat(40),
	commit: "b".repeat(40),
	branch: "feature/delivery",
	summary: "Implemented the feature",
	checks: [{ command: "npm test", status: "passed", result: "5 passed", source: "bot_reported", exitCode: 0 }],
	limitations: ["Manual browser testing pending"],
	createdAt: 2,
};
const oldReview: DeviceReview = {
	id: "review",
	conversationId: "stable/bot",
	accountId: "account",
	roomId: "room",
	deliveryId: "delivery-v1",
	commit: "a".repeat(40),
	verdict: "accepted",
	summary: "Old version approved",
	reviewer: { type: "human", id: "human" },
	createdAt: 3,
};
const conversation: GroupBotConversation = {
	id: "stable/bot",
	botId: "bot",
	name: "Feature",
	status: "idle",
	latestDelivery: delivery,
	latestReview: oldReview,
	deliveryCount: 1,
	reviewCount: 1,
};
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as Response;
let host: HTMLDivElement;
let root: Root;
async function render(conversations = [conversation], roomId = "room", disabled = false) {
	await act(async () =>
		root.render(
			createElement(
				LanguageProvider,
				null,
				createElement(GroupDeliveries, { roomId, conversations, bots: [{ id: "bot", name: "Builder" }], disabled }),
			),
		),
	);
}
async function input(text: string) {
	await act(async () => {
		const field = host.querySelector("textarea")!;
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function click(index = 0) {
	await act(async () => host.querySelectorAll<HTMLButtonElement>(".gd-actions button")[index].click());
}
beforeEach(() => {
	localStorage.clear();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("group deliveries", () => {
	it("starts collapsed and distinguishes execution ending from delivery without a review form", async () => {
		await render([{ id: "finished", botId: "bot", name: "Daily chat", status: "idle" }]);
		expect(host.querySelector("details")!.open).toBe(false);
		expect(host.textContent).toContain("Nothing needs attention right now.");
		await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
		expect(host.textContent).toMatch(/execution ending does not imply delivery|执行结束不代表已交付/);
		expect(host.querySelector("form")).toBeNull();
	});
	it("answers a human question through its original conversation and unique question ID", async () => {
		const fetcher = vi.fn(async () => response({ task: { id: "continued" } }));
		vi.stubGlobal("fetch", fetcher);
		await render([
			{
				id: "question-conversation",
				botId: "bot",
				name: "Decision",
				status: "completed",
				attention: { id: "question-id", taskId: "task", kind: "decision", question: "Which option?", createdAt: 1 },
			},
		]);
		expect(host.textContent).toContain("Waiting for a decision");
		expect(host.textContent).toContain("Which option?");
		await input("Option A");
		await act(async () =>
			host
				.querySelector<HTMLFormElement>("form")!
				.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
		);
		const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toContain("/conversations/question-conversation/messages");
		expect(JSON.parse(init.body as string)).toMatchObject({ text: "Option A", attentionId: "question-id" });
		expect(host.textContent).toContain("Answer sent");
	});
	it("filters actionable conversations and lets users show all conversations", async () => {
		await render([
			conversation,
			{ id: "failed", botId: "bot", name: "Broken task", status: "failed" },
			{ id: "running", botId: "bot", name: "Working task", status: "running" },
		]);
		expect(host.querySelector("summary")!.textContent).toContain("Needs attention · 2");
		expect(host.textContent).toContain("Broken task");
		expect(host.textContent).not.toContain("Working task");
		await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
		expect(host.textContent).toContain("Working task");
	});
	it("shows full delivery evidence, Bot provenance and ignores reviews of other versions or commits", async () => {
		await render([{ ...conversation, reviews: [oldReview, { ...oldReview, deliveryId: delivery.id }] }]);
		expect(host.textContent).toContain(delivery.repository);
		expect(host.textContent).toContain(delivery.commit);
		expect(host.textContent).toContain(delivery.summary);
		expect(host.textContent).toContain(delivery.limitations[0]);
		expect(host.textContent).toMatch(/Bot self-report; not verified by host or CI|Bot 自报，未经宿主或 CI 验证/);
		expect(host.textContent).toContain("passed · 5 passed");
		expect(host.querySelector(".gd-status")!.textContent).toMatch(/Awaiting review|待验收/);
		expect(host.textContent).not.toContain(oldReview.summary);
	});
	it.each(["accepted", "changes_requested"] as const)("posts %s bound to delivery id and full SHA", async (verdict) => {
		const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
			response({
				review: {
					...oldReview,
					deliveryId: delivery.id,
					commit: delivery.commit,
					verdict,
					summary: JSON.parse(init.body as string).summary,
				},
			}),
		);
		vi.stubGlobal("fetch", fetcher);
		await render();
		expect(host.querySelector<HTMLButtonElement>(".gd-actions button")!.disabled).toBe(true);
		await input("  Checked the result  ");
		await click(verdict === "accepted" ? 0 : 1);
		expect(fetcher).toHaveBeenCalledTimes(1);
		const [url, options] = fetcher.mock.calls[0];
		expect(url).toMatch(/\/api\/device-center\/rooms\/room\/conversations\/stable%2Fbot\/reviews$/);
		expect(JSON.parse(options.body as string)).toEqual({
			deliveryId: delivery.id,
			commit: delivery.commit,
			verdict,
			summary: "Checked the result",
			idempotencyKey: expect.any(String),
		});
		expect(options.credentials).toBe("same-origin");
		expect(host.querySelector(".gd-status")!.textContent).toMatch(
			verdict === "accepted" ? /Accepted|验收通过/ : /Changes requested|需返工/,
		);
		expect(host.querySelector("textarea")!.value).toBe("");
	});
	it("keeps failed review text and reuses the key only for an identical retry", async () => {
		const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
			response({ error: "Conflict; refresh delivery" }, 409),
		);
		vi.stubGlobal("fetch", fetcher);
		await render();
		await input("Needs work");
		await click();
		await click();
		const bodies = () => fetcher.mock.calls.map((call) => JSON.parse(call[1].body as string));
		expect(bodies()[0].idempotencyKey).toBe(bodies()[1].idempotencyKey);
		expect(host.querySelector("textarea")!.value).toBe("Needs work");
		expect(host.querySelector('[role="alert"]')!.textContent).toContain("Conflict");
		await click(1);
		expect(bodies()[2].idempotencyKey).not.toBe(bodies()[1].idempotencyKey);
	});
	it("aborts a pending review when the room changes and ignores late responses", async () => {
		let resolve!: (response: Response) => void;
		let signal!: AbortSignal;
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string, init: RequestInit) => {
				signal = init.signal!;
				return new Promise<Response>((done) => {
					resolve = done;
				});
			}),
		);
		await render();
		await input("Looks good");
		await click();
		expect(host.querySelector<HTMLButtonElement>(".gd-actions button")!.disabled).toBe(true);
		await render([conversation], "another-room");
		expect(signal.aborted).toBe(true);
		await act(async () =>
			resolve(response({ review: { ...oldReview, deliveryId: delivery.id, commit: delivery.commit } })),
		);
		expect(host.querySelector(".gd-status")!.textContent).toMatch(/Awaiting review|待验收/);
	});
	it("requires full evidence before reviewing a truncated summary and reloads an open panel for new versions", async () => {
		const next = { ...delivery, id: "delivery-v3", commit: "c".repeat(40), summary: "Next version" };
		let current = delivery;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response({ deliveries: [current], reviews: [] })),
		);
		await render([{ ...conversation, deliverySummaryTruncated: true }]);
		await input("Verified");
		expect(host.querySelector<HTMLButtonElement>(".gd-actions button")!.disabled).toBe(true);
		await act(async () => {
			const panel = host.querySelector<HTMLDetailsElement>(".gd-history")!;
			panel.open = true;
			panel.dispatchEvent(new Event("toggle"));
		});
		expect(host.querySelector<HTMLButtonElement>(".gd-actions button")!.disabled).toBe(false);
		current = next;
		await render([{ ...conversation, latestDelivery: next, deliverySummaryTruncated: true }]);
		expect(host.textContent).toContain("Next version");
		expect(host.textContent).toContain(next.commit);
		expect(host.textContent).not.toContain("Summary only.");
	});
	it("loads bounded history only when requested and keeps each review on its delivery", async () => {
		const first = { ...delivery, id: "delivery-v1", commit: "a".repeat(40), summary: "Previous implementation" };
		const fetcher = vi.fn(async () => response({ conversation, deliveries: [first, delivery], reviews: [oldReview] }));
		vi.stubGlobal("fetch", fetcher);
		await render([{ ...conversation, deliveryCount: 2 }]);
		expect(fetcher).not.toHaveBeenCalled();
		await act(async () => {
			const history = host.querySelector<HTMLDetailsElement>(".gd-history")!;
			history.open = true;
			history.dispatchEvent(new Event("toggle"));
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(host.querySelectorAll(".gd-delivery")).toHaveLength(2);
		expect(host.querySelectorAll("form")).toHaveLength(1);
		expect(host.querySelectorAll(".gd-status")[0].textContent).toMatch(/Awaiting review|待验收/);
		expect(host.querySelectorAll(".gd-status")[1].textContent).toMatch(/Accepted|验收通过/);
	});
});
