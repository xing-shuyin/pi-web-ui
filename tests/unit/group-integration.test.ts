// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupDeliveries } from "../../web/src/components/GroupDeliveries";
import { GroupIntegration } from "../../web/src/components/GroupIntegration";
import {
	INTEGRATION_HTTP_TIMEOUT_MS,
	INTEGRATION_UI_TIMEOUT_MS,
	VERIFICATION_HTTP_TIMEOUT_MS,
	VERIFICATION_UI_TIMEOUT_MS,
} from "../../server/device-center/verification-limits";
import type { DeviceDelivery, DeviceIntegration, DeviceReview } from "../../web/src/types";

vi.mock("../../web/src/i18n", () => ({ useI18n: () => ({ locale: "en" }), isZhLocale: () => false }));

const delivery: DeviceDelivery = {
	id: "delivery",
	accountId: "account",
	roomId: "room",
	conversationId: "conversation",
	botId: "bot",
	taskId: "report-task",
	repository: "repository",
	baseCommit: "a".repeat(40),
	summary: "Feature ready",
	checks: [],
	limitations: [],
	createdAt: 1,
	acceptanceCriteria: ["Feature works", "Existing behavior preserved"],
	artifactRef: {
		artifactTaskId: "source-task",
		attemptId: "attempt",
		artifactId: "artifact",
		artifactDigest: "artifact-digest",
		contractId: "contract",
		contractRevision: 1,
		contractDigest: "contract-digest",
		manifestDigest: "manifest",
		baselineCommit: "a".repeat(40),
		repositoryId: "repository",
		inputTree: "input-tree",
		outputTree: "output-tree",
	},
};
const prepared: DeviceIntegration = {
	id: "integration",
	accountId: "account",
	roomId: "room",
	conversationId: "conversation",
	deliveryId: delivery.id,
	artifactRef: delivery.artifactRef,
	materializedCommit: "b".repeat(40),
	preparedTree: "output-tree",
	targetBotId: "bot",
	targetBotRevision: 1,
	targetBranch: "main",
	expectedTargetSha: delivery.baseCommit,
	status: "prepared",
	validationCommands: [],
	createdAt: 2,
	updatedAt: 2,
};
const verified: DeviceIntegration = {
	...prepared,
	status: "verified",
	verificationPlan: { commands: ["npm test"], digest: "plan", authorizedByAccountId: "account", authorizedAt: 3 },
	verification: {
		digest: "verification-digest",
		verifiedAt: 4,
		planDigest: "plan",
		artifactDigest: "artifact-digest",
		materializedCommit: prepared.materializedCommit!,
		treeBefore: "output-tree",
		treeAfter: "output-tree",
		results: [
			{ command: "npm test", status: "passed", exitCode: 0, outputDigest: "output", outputPreview: "2 passed" },
		],
	},
};
const accepted: DeviceReview = {
	id: "review",
	accountId: "account",
	roomId: "room",
	conversationId: "conversation",
	deliveryId: delivery.id,
	artifactRef: delivery.artifactRef,
	artifactDigest: "artifact-digest",
	integrationId: verified.id,
	verificationDigest: verified.verification!.digest,
	verdict: "accepted",
	summary: "Reviewed independently",
	criteriaResults: delivery.acceptanceCriteria!.map((_, criterionIndex) => ({
		criterionIndex,
		verdict: "met",
		evidence: `Evidence ${criterionIndex}`,
	})),
	reviewer: { type: "human", id: "account" },
	createdAt: 5,
};
const publishIntent: NonNullable<DeviceIntegration["publishIntent"]> = {
	version: 1,
	id: "intent",
	digest: "intent-digest",
	candidateSha: "c".repeat(40),
	accountId: "account",
	roomId: "room",
	conversationId: "conversation",
	integrationId: verified.id,
	targetDeviceId: "device",
	targetBotId: "bot",
	targetBotRevision: 1,
	actor: { accountId: "account" },
	repositoryId: "repository",
	objectFormat: "sha1",
	targetRef: "refs/heads/main",
	expectedOld: delivery.baseCommit,
	preparedTree: verified.preparedTree!,
	materializedCommit: verified.materializedCommit!,
	createdAt: 6,
	delivery: { id: delivery.id, artifactRef: delivery.artifactRef },
	review: accepted,
	verificationPlan: verified.verificationPlan!,
	verification: verified.verification!,
};
const observation: NonNullable<DeviceIntegration["publishObservation"]> = {
	intentId: publishIntent.id,
	intentDigest: publishIntent.digest,
	candidateSha: publishIntent.candidateSha,
	observedAt: 7,
	target: "expected_old",
	phase: "prepared",
	retryable: true,
};
const publishing: DeviceIntegration = {
	...verified,
	status: "applying",
	publishIntent,
	publishObservation: observation,
};
const stopped: NonNullable<DeviceIntegration["publishStop"]> = {
	intentId: publishIntent.id,
	intentDigest: publishIntent.digest,
	candidateSha: publishIntent.candidateSha,
	closed: true,
	stopConfirmed: true,
	pastEffect: "unknown",
	fencedAt: 8,
	stoppedAt: 9,
};
const published: DeviceIntegration = {
	...publishing,
	status: "applied",
	publishReceipt: {
		intentId: publishIntent.id,
		intentDigest: publishIntent.digest,
		candidateSha: publishIntent.candidateSha,
		outcome: "applied",
		proof: "cas_exit",
		observedAt: 8,
	},
	publishObservation: {
		...observation,
		target: "other",
		targetSha: "d".repeat(40),
		phase: "applied",
		retryable: false,
	},
};
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as Response;
let host: HTMLDivElement;
let root: Root;
async function press(text: string) {
	const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
		item.textContent!.includes(text),
	);
	expect(button, text).toBeDefined();
	await act(async () => button!.click());
}
async function fill(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
	await act(async () => {
		const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function open() {
	await act(async () => {
		const drawer = host.querySelector<HTMLDetailsElement>(".gi-panel")!;
		drawer.open = true;
		drawer.dispatchEvent(new Event("toggle"));
	});
}
async function renderIntegration(current: DeviceDelivery = delivery, review: DeviceReview | undefined = accepted) {
	await act(async () =>
		root.render(
			createElement(GroupIntegration, {
				roomId: current.roomId,
				conversationId: current.conversationId,
				delivery: current,
				review,
				bots: [{ id: "bot", name: "Builder" }],
				zh: false,
			}),
		),
	);
}
async function renderDeliveries(current: DeviceDelivery = delivery) {
	await act(async () =>
		root.render(
			createElement(GroupDeliveries, {
				roomId: "room",
				bots: [{ id: "bot", name: "Builder" }],
				conversations: [
					{ id: "conversation", botId: "bot", name: "Feature", status: "completed", latestDelivery: current },
				],
			}),
		),
	);
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

describe("durable publication recovery", () => {
	it("reopens and polls an unknown publication through observation only, without apply or resume", async () => {
		vi.useFakeTimers();
		const fetcher = vi.fn(async (url: string) =>
			url.endsWith("/reconcile")
				? response({ integration: publishing })
				: response({ integrations: [publishing], canResumePublication: true }),
		);
		vi.stubGlobal("fetch", fetcher);
		await renderIntegration();
		await open();
		expect(host.textContent).toContain("Publication outcome unknown");
		await act(async () => vi.advanceTimersByTimeAsync(5000));
		expect(fetcher.mock.calls.some(([url]) => url.endsWith("/reconcile"))).toBe(true);
		await act(async () => {
			const details = host.querySelector<HTMLDetailsElement>(".gi-panel")!;
			details.open = false;
			details.dispatchEvent(new Event("toggle"));
		});
		await open();
		expect(fetcher.mock.calls.every(([url]) => !/\/(apply|resume|cancel)$/.test(url))).toBe(true);
	});

	it("exhausts the publication observation budget without ever dispatching a write", async () => {
		vi.useFakeTimers();
		const fetcher = vi.fn(async (url: string) =>
			url.endsWith("/reconcile") ? response({ integration: publishing }) : response({ integrations: [publishing] }),
		);
		vi.stubGlobal("fetch", fetcher);
		await renderIntegration();
		await open();
		await act(async () => vi.advanceTimersByTimeAsync(INTEGRATION_UI_TIMEOUT_MS + 15000));
		const attempts = fetcher.mock.calls.length;
		expect(attempts).toBeGreaterThan(1);
		expect(attempts).toBeLessThanOrEqual(1 + Math.ceil(INTEGRATION_UI_TIMEOUT_MS / 5000));
		await act(async () => vi.advanceTimersByTimeAsync(INTEGRATION_UI_TIMEOUT_MS));
		expect(fetcher.mock.calls).toHaveLength(attempts);
		expect(fetcher.mock.calls.every(([url]) => !/\/(apply|resume|cancel)$/.test(url))).toBe(true);
		expect(host.textContent).toContain("writes are never retried automatically");
	});

	it("aborts reconciliation on delivery change and ignores a late receipt", async () => {
		let resolveReconcile!: (value: Response) => void;
		let signal!: AbortSignal;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, options: RequestInit) => {
				if (url.endsWith("/reconcile")) {
					signal = options.signal!;
					return new Promise<Response>((resolve) => {
						resolveReconcile = resolve;
					});
				}
				return response({ integrations: [publishing] });
			}),
		);
		await renderIntegration();
		await open();
		await press("Reconcile publication");
		await renderIntegration({ ...delivery, id: "next-delivery" });
		expect(signal.aborted).toBe(true);
		await act(async () => resolveReconcile(response({ integration: published })));
		expect(host.textContent).not.toContain("Publication effect recorded");
		expect(host.textContent).not.toContain("Resume same publication intent");
	});

	it("requires an explicit resume click and sends the original intent identity exactly once after a lost reply", async () => {
		const fetcher = vi.fn(async (url: string, _options: RequestInit) => {
			if (url.endsWith("/resume")) throw new DOMException("Reply lost", "TimeoutError");
			return response({ integrations: [publishing], canResumePublication: true });
		});
		vi.stubGlobal("fetch", fetcher);
		await renderIntegration();
		await open();
		expect(fetcher.mock.calls).toHaveLength(1);
		await press("Resume same publication intent");
		const resumes = fetcher.mock.calls.filter(([url]) => url.endsWith("/resume"));
		expect(resumes).toHaveLength(1);
		expect(JSON.parse(resumes[0][1].body as string)).toEqual({
			intentId: publishIntent.id,
			intentDigest: publishIntent.digest,
			candidateSha: publishIntent.candidateSha,
		});
		expect(fetcher.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
		expect(host.textContent).toContain("Publication outcome unknown");
	});

	it.each([
		{ name: "missing owner capability", capability: undefined, integration: publishing },
		{ name: "non-owner credentials", capability: false, integration: publishing },
		{
			name: "non-retryable observation",
			capability: true,
			integration: { ...publishing, publishObservation: { ...observation, retryable: false } },
		},
		{
			name: "different intent observation",
			capability: true,
			integration: { ...publishing, publishObservation: { ...observation, intentDigest: "different" } },
		},
		{
			name: "different intent ID",
			capability: true,
			integration: { ...publishing, publishObservation: { ...observation, intentId: "different" } },
		},
		{
			name: "different candidate SHA",
			capability: true,
			integration: { ...publishing, publishObservation: { ...observation, candidateSha: "f".repeat(40) } },
		},
		{
			name: "unknown CAS despite retryable flag",
			capability: true,
			integration: { ...publishing, publishObservation: { ...observation, phase: "cas_started" } },
		},
		{ name: "closed intent", capability: true, integration: { ...publishing, publishStop: stopped } },
		{ name: "confirmed receipt", capability: true, integration: published },
	])("does not offer resume for $name", async ({ capability, integration }) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response({ integrations: [integration], canResumePublication: capability })),
		);
		await renderIntegration();
		await open();
		expect(host.textContent).not.toContain("Resume same publication intent");
	});

	it("clears prior owner capability while reopening history", async () => {
		let finishReload!: (value: Response) => void;
		let loads = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				if (++loads === 1) return response({ integrations: [publishing], canResumePublication: true });
				return new Promise<Response>((resolve) => {
					finishReload = resolve;
				});
			}),
		);
		await renderIntegration();
		await open();
		expect(host.textContent).toContain("Resume same publication intent");
		await act(async () => {
			const details = host.querySelector<HTMLDetailsElement>(".gi-panel")!;
			details.open = false;
			details.dispatchEvent(new Event("toggle"));
		});
		await open();
		expect(host.textContent).not.toContain("Resume same publication intent");
		await act(async () => finishReload(response({ integrations: [publishing], canResumePublication: false })));
		expect(host.textContent).not.toContain("Resume same publication intent");
	});

	it("does not treat a cancelled status alone as proof of publication cancellation", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response({ integrations: [{ ...publishing, status: "cancelled" }] })),
		);
		await renderIntegration();
		await open();
		expect(host.textContent).not.toContain("Cancellation before publication is confirmed");
		expect(host.textContent).toContain("Publication outcome unknown");
		expect(host.textContent).not.toContain("Prepare isolated integration");
	});

	it("shows an explicit unknown target observation without publication evidence", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response({ integrations: [{ ...publishing, publishObservation: undefined }] })),
		);
		await renderIntegration();
		await open();
		expect(host.textContent).toContain("Current target observation: Unknown (not yet observed)");
		expect(host.textContent).not.toContain("Resume same publication intent");
	});

	it("keeps the durable receipt separate from a subsequently moved target", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response({ integrations: [published] })),
		);
		await renderIntegration();
		await open();
		expect(host.textContent).toContain("Publication effect recorded (proof: cas_exit)");
		expect(host.textContent).toContain("Current target observation: other");
		expect(host.textContent).toContain("d".repeat(40));
	});

	it("keeps cancellation unknown and blocked until process stop is confirmed", async () => {
		const cancelling: DeviceIntegration = {
			...publishing,
			status: "cancelling",
			publishStop: { ...stopped, stopConfirmed: false, stoppedAt: undefined },
		};
		const fetcher = vi.fn(async (url: string) =>
			url.endsWith("/cancel")
				? response({ integration: cancelling })
				: response({ integrations: [publishing], canResumePublication: true }),
		);
		vi.stubGlobal("fetch", fetcher);
		await renderIntegration();
		await open();
		await press("Cancel");
		expect(host.textContent).toContain("has not been confirmed stopped");
		expect(host.textContent).toContain("Publication outcome unknown");
		expect(host.textContent).not.toContain("Cancellation before publication is confirmed");
		expect(host.textContent).not.toContain("Resume same publication intent");
		expect(host.textContent).not.toContain("Start a new integration & verification");
	});

	it("stops polling a closed confirmed unknown publication but retains manual reconciliation and a new integration", async () => {
		vi.useFakeTimers();
		const closed: DeviceIntegration = { ...publishing, status: "cancelling", publishStop: stopped };
		const fetcher = vi.fn(async (url: string) =>
			url.endsWith("/reconcile")
				? response({ integration: closed })
				: response({ integrations: [closed], canResumePublication: true }),
		);
		vi.stubGlobal("fetch", fetcher);
		await renderIntegration();
		await open();
		await act(async () => vi.advanceTimersByTimeAsync(INTEGRATION_UI_TIMEOUT_MS + 5000));
		expect(fetcher.mock.calls).toHaveLength(1);
		expect(host.textContent).toContain("historical publication outcome remains unknown");
		expect(host.textContent).toContain("Start a new integration & verification");
		await press("Reconcile publication");
		expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/reconcile"))).toHaveLength(1);
	});

	it("allows legacy history to load without accepted review and does not invent a receipt", async () => {
		const legacy = { ...delivery, artifactRef: undefined, commit: "c".repeat(40) };
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				response({ integrations: [{ ...prepared, artifactRef: undefined, commit: legacy.commit, status: "applied" }] }),
			),
		);
		await renderDeliveries(legacy);
		expect(host.querySelector(".gi-panel")).not.toBeNull();
		await open();
		expect(host.textContent).toContain("Legacy applied record; no durable publication receipt");
		expect(host.textContent).not.toContain("Publication effect recorded");
		expect(host.textContent).not.toContain("Confirm & Merge");
	});
});

describe("artifact delivery verification and review", () => {
	it("renders without a commit, verifies before review, then binds every criterion to that verification", async () => {
		const fetcher = vi.fn(async (url: string, options: RequestInit) => {
			if (url.endsWith("/verify")) return response({ integration: verified });
			if (url.endsWith("/reviews")) return response({ review: accepted });
			if (options.method === "POST") return response({ integration: prepared });
			return response({ integrations: [] });
		});
		vi.stubGlobal("fetch", fetcher);
		await renderDeliveries();
		expect(host.textContent).toContain("source-task");
		expect(host.textContent).toContain("artifact-digest");
		expect(host.textContent).toContain("output-tree");
		expect(host.textContent).not.toContain("Commit SHA");
		await fill(host.querySelector("textarea")!, "Reviewed independently");
		expect(host.querySelector<HTMLButtonElement>(".gd-actions button")!.disabled).toBe(true);
		await open();
		await press("Prepare Isolated Integration");
		expect(fetcher.mock.calls.some(([url]) => url.endsWith("/reviews"))).toBe(false);
		await fill(host.querySelector<HTMLInputElement>('input[placeholder^="Custom command"]')!, "npm test");
		await press("Verify");
		const verifyCall = fetcher.mock.calls.find(([url]) => url.endsWith("/verify"))!;
		expect(JSON.parse(verifyCall[1].body as string)).toEqual({ commands: ["npm test"] });
		expect(host.querySelector('input[placeholder^="Custom command"]')).toBeNull();
		expect(host.textContent).toContain("Verification succeeded and is locked");
		expect(host.textContent).not.toContain("Confirm & Merge");
		const boxes = host.querySelectorAll<HTMLInputElement>("fieldset input[type=checkbox]");
		const evidence = host.querySelectorAll<HTMLTextAreaElement>("fieldset textarea");
		expect([...evidence].map((field) => field.maxLength)).toEqual([2000, 2000]);
		await act(async () => boxes[0].click());
		await fill(evidence[0], "Feature scenario passed");
		expect(host.querySelector<HTMLButtonElement>(".gd-actions button")!.disabled).toBe(true);
		await act(async () => boxes[1].click());
		await fill(evidence[1], "Regression suite passed");
		await press("Accept delivery");
		const reviewCall = fetcher.mock.calls.find(([url]) => url.endsWith("/reviews"))!;
		expect(JSON.parse(reviewCall[1].body as string)).toMatchObject({
			deliveryId: delivery.id,
			artifactDigest: "artifact-digest",
			integrationId: verified.id,
			verificationDigest: verified.verification!.digest,
			verdict: "accepted",
			criteriaResults: [
				{ criterionIndex: 0, verdict: "met", evidence: "Feature scenario passed" },
				{ criterionIndex: 1, verdict: "met", evidence: "Regression suite passed" },
			],
		});
		expect(JSON.parse(reviewCall[1].body as string)).not.toHaveProperty("commit");
		expect(host.textContent).toContain("Confirm & Merge into main");
	});

	it("allows requesting changes before verification without fabricating verification evidence", async () => {
		const fetcher = vi.fn(async (_url: string, _options: RequestInit) =>
			response({ review: { ...accepted, verdict: "changes_requested" } }),
		);
		vi.stubGlobal("fetch", fetcher);
		await renderDeliveries();
		await fill(host.querySelector("textarea")!, "Please fix the missing case");
		await press("Request changes");
		const body = JSON.parse(fetcher.mock.calls[0][1].body as string);
		expect(body).toMatchObject({ artifactDigest: "artifact-digest", verdict: "changes_requested" });
		for (const field of ["commit", "integrationId", "verificationDigest", "criteriaResults"])
			expect(body).not.toHaveProperty(field);
	});

	it("clears entered evidence when starting a new integration", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, options: RequestInit) =>
				options.method === "POST"
					? response({ integration: { ...prepared, id: "new-integration" } })
					: response({ integrations: [verified] }),
			),
		);
		await renderDeliveries();
		await open();
		await fill(host.querySelector("fieldset textarea")!, "Old verification evidence");
		await press("Start a new integration & verification");
		expect(host.querySelector<HTMLTextAreaElement>("fieldset textarea")!.value).toBe("");
		expect(host.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(true);
	});
});

describe("verification transport and recovery", () => {
	it.each(["prepare", "apply", "cancel"] as const)(
		"gives %s an outer deadline beyond its HTTP transport while leaving GET unchanged",
		async (action) => {
			const timeouts = vi.spyOn(AbortSignal, "timeout");
			const fetcher = vi.fn(async (_url: string, options: RequestInit) =>
				options.method === "POST"
					? response({
							integration: {
								...prepared,
								status: action === "apply" ? "applied" : action === "cancel" ? "cancelled" : "prepared",
							},
						})
					: response({ integrations: action === "prepare" ? [] : [action === "apply" ? verified : prepared] }),
			);
			vi.stubGlobal("fetch", fetcher);
			await renderIntegration();
			await open();
			expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([15000]);
			await press(
				action === "prepare" ? "Prepare Isolated Integration" : action === "apply" ? "Confirm & Merge" : "Cancel",
			);
			expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([15000, INTEGRATION_UI_TIMEOUT_MS]);
			expect(timeouts.mock.calls.at(-1)![0]).toBeGreaterThan(INTEGRATION_HTTP_TIMEOUT_MS);
			expect(fetcher.mock.calls.at(-1)![1].method).toBe("POST");
		},
	);

	it("uses the shared verification deadline beyond its HTTP transport", async () => {
		const timeouts = vi.spyOn(AbortSignal, "timeout");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				url.endsWith("/verify") ? response({ integration: verified }) : response({ integrations: [prepared] }),
			),
		);
		await renderIntegration();
		await open();
		expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([15000]);
		await fill(host.querySelector<HTMLInputElement>('input[placeholder^="Custom command"]')!, "npm test");
		await press("Verify");
		expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([15000, VERIFICATION_UI_TIMEOUT_MS]);
		expect(timeouts.mock.calls.at(-1)![0]).toBeGreaterThan(VERIFICATION_HTTP_TIMEOUT_MS);
	});

	it("polls an operation still running after a network error until its authoritative verification arrives", async () => {
		vi.useFakeTimers();
		const running = { ...prepared, status: "verifying" as const };
		const snapshots = [prepared, running, running, verified];
		const fetcher = vi.fn(async (url: string) =>
			url.endsWith("/verify")
				? response({ error: "Connection lost" }, 502)
				: response({ integrations: [snapshots.shift() ?? verified] }),
		);
		vi.stubGlobal("fetch", fetcher);
		await renderIntegration();
		await open();
		await fill(host.querySelector<HTMLInputElement>('input[placeholder^="Custom command"]')!, "npm test");
		await press("Verify");
		expect(host.textContent).not.toContain("Verification succeeded and is locked");
		await act(async () => vi.advanceTimersByTimeAsync(5000));
		expect(host.textContent).not.toContain("Verification succeeded and is locked");
		await act(async () => vi.advanceTimersByTimeAsync(5000));
		expect(host.textContent).toContain("Verification succeeded and is locked");
		expect(host.querySelector('[role="alert"]')).toBeNull();
		const completedCalls = fetcher.mock.calls.length;
		await act(async () => vi.advanceTimersByTimeAsync(30000));
		expect(fetcher).toHaveBeenCalledTimes(completedCalls);
		expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/verify"))).toHaveLength(1);
	});

	it("bounds polling and lets reopening refresh an operation that completed later", async () => {
		vi.useFakeTimers();
		let current: DeviceIntegration = { ...prepared, status: "verifying" };
		const fetcher = vi.fn(async () => response({ integrations: [current] }));
		vi.stubGlobal("fetch", fetcher);
		await renderIntegration();
		await open();
		await act(async () => vi.advanceTimersByTimeAsync(VERIFICATION_UI_TIMEOUT_MS + 5000));
		expect(host.textContent).toContain("Close and reopen this panel later");
		const boundedCalls = fetcher.mock.calls.length;
		await act(async () => vi.advanceTimersByTimeAsync(VERIFICATION_UI_TIMEOUT_MS));
		expect(fetcher).toHaveBeenCalledTimes(boundedCalls);
		current = verified;
		await act(async () => {
			const drawer = host.querySelector<HTMLDetailsElement>(".gi-panel")!;
			drawer.open = false;
			drawer.dispatchEvent(new Event("toggle"));
		});
		await open();
		expect(host.textContent).toContain("Verification succeeded and is locked");
	});

	it.each(["close", "switch"] as const)(
		"aborts a pending status refresh on %s and ignores its late receipt",
		async (action) => {
			vi.useFakeTimers();
			let resolveRefresh!: (value: Response) => void;
			let refreshSignal!: AbortSignal;
			let loads = 0;
			const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
				if (loads++ === 0) return response({ integrations: [{ ...prepared, status: "verifying" }] });
				if (loads === 2) {
					refreshSignal = options.signal!;
					return new Promise<Response>((resolve) => {
						resolveRefresh = resolve;
					});
				}
				return response({ integrations: [] });
			});
			vi.stubGlobal("fetch", fetcher);
			await renderIntegration();
			await open();
			await act(async () => vi.advanceTimersByTimeAsync(5000));
			if (action === "close") {
				await act(async () => {
					const drawer = host.querySelector<HTMLDetailsElement>(".gi-panel")!;
					drawer.open = false;
					drawer.dispatchEvent(new Event("toggle"));
				});
			} else await renderIntegration({ ...delivery, id: "next-delivery" });
			expect(refreshSignal.aborted).toBe(true);
			await act(async () => resolveRefresh(response({ integrations: [verified] })));
			expect(host.textContent).not.toContain("Verification succeeded and is locked");
			const stoppedCalls = fetcher.mock.calls.length;
			await act(async () => vi.advanceTimersByTimeAsync(30000));
			expect(fetcher).toHaveBeenCalledTimes(stoppedCalls);
		},
	);
});

describe("integration confirmation gates", () => {
	it.each(["prepared", "failed"] as const)(
		"does not offer confirmation for %s even with an accepted review",
		async (status) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => response({ integrations: [{ ...verified, status }] })),
			);
			await renderIntegration();
			await open();
			expect(host.textContent).not.toContain("Confirm & Merge");
		},
	);
	it.each([
		{ ...accepted, integrationId: "old-integration" },
		{ ...accepted, verificationDigest: "old-verification" },
		{ ...accepted, artifactDigest: "old-artifact" },
		{ ...accepted, criteriaResults: [accepted.criteriaResults![0]] },
		{ ...accepted, criteriaResults: [accepted.criteriaResults![0], accepted.criteriaResults![0]] },
		{ ...accepted, criteriaResults: accepted.criteriaResults!.map((criterion) => ({ ...criterion, evidence: " " })) },
		{ ...accepted, verdict: "changes_requested" as const },
	])("does not confirm with stale or incomplete accepted evidence %#", async (review) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response({ integrations: [verified] })),
		);
		await renderIntegration(delivery, review);
		await open();
		expect(host.textContent).not.toContain("Confirm & Merge");
	});
	it("requires an accepted review before offering the legacy commit workflow", async () => {
		await act(async () =>
			root.render(
				createElement(GroupIntegration, {
					roomId: "room",
					conversationId: "conversation",
					delivery: { ...delivery, artifactRef: undefined, commit: "c".repeat(40) },
					bots: [{ id: "bot", name: "Builder" }],
					zh: false,
				}),
			),
		);
		expect(
			[...host.querySelectorAll("button")].find((item) => item.textContent?.includes("Prepare Isolated Integration"))
				?.disabled,
		).toBe(true);
	});

	it("requires a real verification receipt on legacy commit deliveries too", async () => {
		const legacy = { ...delivery, artifactRef: undefined, commit: "c".repeat(40) };
		const review = { ...accepted, artifactRef: undefined, artifactDigest: undefined, commit: legacy.commit };
		const integration = {
			...verified,
			artifactRef: undefined,
			commit: legacy.commit,
			reviewId: review.id,
			verification: undefined,
		};
		const fetcher = vi.fn(async () => response({ integrations: [integration] }));
		vi.stubGlobal("fetch", fetcher);
		await renderIntegration(legacy, review);
		await open();
		expect(host.textContent).not.toContain("Confirm & Merge");
		fetcher.mockResolvedValue(response({ integrations: [{ ...integration, verification: verified.verification }] }));
		await act(async () => {
			const drawer = host.querySelector<HTMLDetailsElement>("details")!;
			drawer.open = false;
			drawer.dispatchEvent(new Event("toggle"));
		});
		await open();
		expect(host.textContent).toContain("Confirm & Merge");
	});

	it("keeps a frozen command plan on retries and posts cancellation", async () => {
		const fetcher = vi.fn(async (url: string, _options: RequestInit) =>
			url.endsWith("/cancel")
				? response({ integration: { ...prepared, status: "cancelled" } })
				: url.endsWith("/verify")
					? response({ integration: verified })
					: response({
							integrations: [{ ...prepared, status: "failed", verificationPlan: verified.verificationPlan }],
						}),
		);
		vi.stubGlobal("fetch", fetcher);
		await renderIntegration();
		await open();
		expect(host.querySelector<HTMLInputElement>('input[placeholder^="Custom command"]')!.disabled).toBe(true);
		await press("Verify");
		expect(JSON.parse(fetcher.mock.calls.find(([url]) => url.endsWith("/verify"))![1].body as string)).toEqual({
			commands: ["npm test"],
		});
		await press("Cancel");
		expect(fetcher.mock.calls.find(([url]) => url.endsWith("/cancel"))![1].method).toBe("POST");
	});

	it("refreshes a verification saved before an error response and keeps it immutable", async () => {
		let loads = 0;
		const fetcher = vi.fn(async (url: string, _options: RequestInit) => {
			if (url.endsWith("/verify")) return response({ error: "Response interrupted" }, 504);
			return response({ integrations: [loads++ === 0 ? prepared : verified] });
		});
		vi.stubGlobal("fetch", fetcher);
		await renderIntegration();
		await open();
		await fill(host.querySelector<HTMLInputElement>('input[placeholder^="Custom command"]')!, "npm test");
		await press("Verify");
		expect(host.textContent).toContain("Verification succeeded and is locked");
		expect(host.querySelector('input[placeholder^="Custom command"]')).toBeNull();
		expect(host.textContent).toContain("2 passed");
	});

	it("ignores an old operation after closing and reopening the same delivery", async () => {
		let resolveOld!: (response: Response) => void;
		let prepares = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, options: RequestInit) => {
				if (options.method === "POST") {
					if (prepares++ === 0)
						return new Promise<Response>((resolve) => {
							resolveOld = resolve;
						});
					return response({ integration: { ...prepared, id: "current-operation", diff: "CURRENT DIFF" } });
				}
				return response({ integrations: [] });
			}),
		);
		await renderIntegration();
		await open();
		await press("Prepare Isolated Integration");
		await act(async () => {
			const drawer = host.querySelector<HTMLDetailsElement>(".gi-panel")!;
			drawer.open = false;
			drawer.dispatchEvent(new Event("toggle"));
		});
		await open();
		await press("Prepare Isolated Integration");
		await act(async () => resolveOld(response({ integration: { ...prepared, diff: "OLD DIFF" } })));
		expect(host.textContent).toContain("CURRENT DIFF");
		expect(host.textContent).not.toContain("OLD DIFF");
	});

	it("aborts a pending operation when the selected delivery changes and ignores its late response", async () => {
		let resolvePrepare!: (response: Response) => void;
		let operationSignal!: AbortSignal;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, options: RequestInit) => {
				if (options.method === "POST") {
					operationSignal = options.signal!;
					return new Promise<Response>((resolve) => {
						resolvePrepare = resolve;
					});
				}
				return response({ integrations: [] });
			}),
		);
		await renderIntegration();
		await open();
		await press("Prepare Isolated Integration");
		await renderIntegration({ ...delivery, id: "next-delivery" });
		expect(operationSignal.aborted).toBe(true);
		await act(async () => resolvePrepare(response({ integration: { ...prepared, diff: "OLD DELIVERY DIFF" } })));
		expect(host.textContent).not.toContain("OLD DELIVERY DIFF");
		expect(host.textContent).toContain("Prepare Isolated Integration");
	});
});
