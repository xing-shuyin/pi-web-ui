// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupIntegration } from "../../web/src/components/GroupIntegration";
import { GroupDeliveries } from "../../web/src/components/GroupDeliveries";
import type { DeviceDelivery, DeviceIntegration, DevicePublishObservation } from "../../server/protocol";
import { publicationFixture } from "../helpers/publish-intent-fixture";

vi.mock("../../web/src/i18n", () => ({ useI18n: () => ({ locale: "en" }), isZhLocale: () => false }));
const { integration: verified, intent } = publicationFixture();
const identity = { intentId: intent.id, intentDigest: intent.digest, candidateSha: intent.candidateSha };
const delivery: DeviceDelivery = {
	id: "delivery",
	accountId: "account",
	roomId: "room",
	conversationId: "conversation",
	botId: "bot",
	taskId: "task",
	repository: "repo:test",
	baseCommit: intent.expectedOld,
	commit: verified.commit,
	summary: "Ready",
	checks: [],
	limitations: [],
	createdAt: 1,
};
const response = (value: unknown, status = 200) => ({ ok: status < 400, status, json: async () => value }) as Response;
function pending(observation: Partial<DevicePublishObservation> = {}): DeviceIntegration {
	return {
		...verified,
		status: "applying",
		publishIntent: intent,
		publishObservation: {
			...identity,
			observedAt: 1,
			target: "expected_old",
			targetSha: intent.expectedOld,
			phase: "cas_started",
			retryable: false,
			...observation,
		},
	};
}
function applied(): DeviceIntegration {
	return {
		...pending(),
		status: "applied",
		publishReceipt: { ...identity, outcome: "applied", proof: "cas_exit", observedAt: 2 },
		publishObservation: {
			...identity,
			observedAt: 3,
			target: "other",
			targetSha: "e".repeat(40),
			phase: "applied",
			retryable: false,
		},
	};
}
let host: HTMLDivElement;
let root: Root;
async function mount(review = intent.review) {
	await act(async () =>
		root.render(
			createElement(GroupIntegration, {
				roomId: "room",
				conversationId: "conversation",
				delivery,
				review,
				bots: [{ id: "bot", name: "Builder" }],
				zh: false,
			}),
		),
	);
	await act(async () => {
		const panel = host.querySelector<HTMLDetailsElement>(".gi-panel")!;
		panel.open = true;
		panel.dispatchEvent(new Event("toggle"));
	});
}
function button(label: string) {
	return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes(label));
}
async function click(label: string) {
	expect(button(label)).toBeDefined();
	await act(async () => button(label)!.click());
}
function writes(fetch: ReturnType<typeof vi.fn>, suffix: string) {
	return fetch.mock.calls.filter(([url, options]) => String(url).endsWith(suffix) && options?.method === "POST");
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
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("publication recovery UI", () => {
	it("polls only reconciliation for an open intent and preserves an applied fact after target movement", async () => {
		vi.useFakeTimers();
		const fetch = vi.fn(async (url: string) =>
			response(
				String(url).endsWith("/reconcile")
					? { integration: applied() }
					: { integrations: [pending()], canResumePublication: true },
			),
		);
		vi.stubGlobal("fetch", fetch);
		await mount();
		expect(host.textContent).toContain("Publication outcome unknown");
		expect(button("Resume same")).toBeUndefined();
		await act(async () => vi.advanceTimersByTimeAsync(5000));
		expect(writes(fetch, "/reconcile")).toHaveLength(1);
		expect(writes(fetch, "/apply")).toHaveLength(0);
		expect(writes(fetch, "/resume")).toHaveLength(0);
		expect(host.textContent).toContain("Publication effect recorded");
		expect(host.textContent).toContain("Current target observation: other");
		expect(host.textContent).toContain("e".repeat(40));
		await act(async () => vi.advanceTimersByTimeAsync(15000));
		expect(writes(fetch, "/reconcile")).toHaveLength(1);
	});

	it("requires an explicit owner click and sends only the exact same intent binding to resume", async () => {
		const fetch = vi.fn(async (url: string) =>
			response(
				String(url).endsWith("/resume")
					? { integration: applied() }
					: { integrations: [pending({ phase: "prepared", retryable: true })], canResumePublication: true },
			),
		);
		vi.stubGlobal("fetch", fetch);
		await mount();
		expect(writes(fetch, "/resume")).toHaveLength(0);
		await click("Resume same publication intent");
		const calls = writes(fetch, "/resume");
		expect(calls).toHaveLength(1);
		expect(JSON.parse(calls[0][1].body)).toEqual(identity);
		expect(host.textContent).toContain("Publication effect recorded");
	});

	it.each([false, undefined])("hides resume without trusted owner capability (%s)", async (capability) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				response({ integrations: [pending({ phase: "prepared", retryable: true })], canResumePublication: capability }),
			),
		);
		await mount();
		expect(button("Resume same")).toBeUndefined();
	});

	it("does not poll confirmed closed unknown history but retains manual evidence queries", async () => {
		vi.useFakeTimers();
		const closed: DeviceIntegration = {
			...pending(),
			status: "cancelling",
			publishStop: { ...identity, closed: true, stopConfirmed: true, pastEffect: "unknown", fencedAt: 2, stoppedAt: 3 },
		};
		const fetch = vi.fn(async (url: string) =>
			response(
				String(url).endsWith("/reconcile")
					? { integration: closed }
					: { integrations: [closed], canResumePublication: true },
			),
		);
		vi.stubGlobal("fetch", fetch);
		await mount();
		expect(host.textContent).toContain("historical publication outcome remains unknown");
		expect(button("Resume same")).toBeUndefined();
		await act(async () => vi.advanceTimersByTimeAsync(15000));
		expect(writes(fetch, "/reconcile")).toHaveLength(0);
		await click("Reconcile publication");
		expect(writes(fetch, "/reconcile")).toHaveLength(1);
		expect(writes(fetch, "/apply")).toHaveLength(0);
	});

	it("keeps an unconfirmed stop isolated and querying rather than offering new writes", async () => {
		vi.useFakeTimers();
		const unknown: DeviceIntegration = {
			...pending(),
			status: "cancelling",
			publishStop: { ...identity, closed: true, stopConfirmed: false, pastEffect: "unknown", fencedAt: 2 },
		};
		const fetch = vi.fn(async (url: string) =>
			response(
				String(url).endsWith("/reconcile")
					? { integration: unknown }
					: { integrations: [unknown], canResumePublication: true },
			),
		);
		vi.stubGlobal("fetch", fetch);
		await mount();
		expect(host.textContent).toContain("has not been confirmed stopped and remains isolated");
		expect(button("Start a new integration")).toBeUndefined();
		expect(button("Resume same")).toBeUndefined();
		await act(async () => vi.advanceTimersByTimeAsync(5000));
		expect(writes(fetch, "/reconcile")).toHaveLength(1);
	});

	it("preserves an applied effect while continuing to query its unconfirmed original process stop", async () => {
		vi.useFakeTimers();
		const value: DeviceIntegration = {
			...applied(),
			publishStop: { ...identity, closed: true, stopConfirmed: false, pastEffect: "applied", fencedAt: 2 },
		};
		const stopped: DeviceIntegration = {
			...value,
			publishStop: { ...identity, closed: true, stopConfirmed: true, pastEffect: "applied", fencedAt: 2, stoppedAt: 3 },
		};
		const fetch = vi.fn(async (url: string) =>
			response(
				String(url).endsWith("/cancel")
					? { integration: stopped }
					: String(url).endsWith("/reconcile")
						? { integration: value }
						: { integrations: [value], canResumePublication: true },
			),
		);
		vi.stubGlobal("fetch", fetch);
		await mount();
		expect(host.textContent).toContain("Publication effect recorded");
		expect(host.textContent).toContain("has not been confirmed stopped and remains isolated");
		expect(button("Start a new integration")).toBeUndefined();
		await act(async () => vi.advanceTimersByTimeAsync(5000));
		expect(writes(fetch, "/reconcile")).toHaveLength(1);
		await click("Fence writes & confirm process stop");
		expect(writes(fetch, "/cancel")).toHaveLength(1);
		expect(host.textContent).toContain("Publication effect recorded");
		expect(button("Fence writes & confirm process stop")).toBeUndefined();
		await act(async () => vi.advanceTimersByTimeAsync(10000));
		expect(writes(fetch, "/reconcile")).toHaveLength(1);
	});

	it("refreshes a lost apply ACK and only reconciles the reserved intent afterward", async () => {
		vi.useFakeTimers();
		let sent = false;
		const fetch = vi.fn(async (url: string) => {
			if (String(url).endsWith("/apply")) {
				sent = true;
				throw new Error("response lost");
			}
			if (String(url).endsWith("/reconcile")) return response({ integration: applied() });
			return response({
				integrations: [sent ? pending() : { ...verified, reviewId: intent.review.id }],
				canResumePublication: true,
			});
		});
		vi.stubGlobal("fetch", fetch);
		await mount();
		await click("Confirm & Merge");
		expect(host.textContent).toContain("Publication outcome unknown");
		await act(async () => vi.advanceTimersByTimeAsync(5000));
		expect(writes(fetch, "/apply")).toHaveLength(1);
		expect(writes(fetch, "/reconcile")).toHaveLength(1);
		expect(writes(fetch, "/resume")).toHaveLength(0);
	});

	it("keeps legacy publication history accessible after review invalidation without permitting preparation", async () => {
		const fetch = vi.fn(async (url: string) => {
			if (String(url).endsWith("/deliveries")) return response({ deliveries: [delivery] });
			if (String(url).endsWith("/reviews")) return response({ reviews: [] });
			return response({ integrations: [{ ...verified, status: "applying" }], canResumePublication: true });
		});
		vi.stubGlobal("fetch", fetch);
		await act(async () =>
			root.render(
				createElement(GroupDeliveries, {
					roomId: "room",
					bots: [{ id: "bot", name: "Builder" }],
					conversations: [
						{ id: "conversation", botId: "bot", name: "Feature", status: "completed", latestDelivery: delivery },
					],
				}),
			),
		);
		const panel = host.querySelector<HTMLDetailsElement>(".gi-panel");
		expect(panel).not.toBeNull();
		await act(async () => {
			panel!.open = true;
			panel!.dispatchEvent(new Event("toggle"));
		});
		expect(host.textContent).toContain("Legacy publication has no durable intent");
		expect(button("Start a new integration")).toBeUndefined();
		expect(button("Confirm & Merge")).toBeUndefined();
		expect(writes(fetch, "/apply")).toHaveLength(0);
	});
});
