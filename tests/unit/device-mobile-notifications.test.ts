import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMobileNotificationForwarder } from "../../server/device-center/mobile-notification-forwarder.js";
import type { MobileNotificationEvent } from "../../server/mobile-notification-events.js";

type Options = Parameters<typeof createMobileNotificationForwarder>[0];
const epoch = Date.UTC(2026, 0, 1);
const event = (eventId = "event-1"): MobileNotificationEvent => ({
	eventId,
	kind: "done",
	clientId: "client-1",
	sessionId: "session-1",
	conversationId: "conversation-1",
	occurredAt: epoch,
});
const binding = () => ({
	hubUrl: "https://hub.example",
	deviceId: "device-1",
	accountId: "owner-1",
	credential: "execution-secret-must-not-persist",
	uiCredential: "human-secret-must-not-persist",
});
const dirs: string[] = [];
const forwarders: ReturnType<typeof createMobileNotificationForwarder>[] = [];
async function fixture(
	getBinding: Options["getBinding"] = binding,
	fetchHub = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 })),
) {
	const dataDir = await mkdtemp(join(tmpdir(), "device-mobile-notifications-"));
	dirs.push(dataDir);
	const fetchUser = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
	const transport = vi
		.fn<typeof fetch>()
		.mockImplementation((url, init) =>
			String(url).endsWith("/api/device-user/devices") ? fetchUser(url, init) : fetchHub(url, init),
		);
	const options: Options = { dataDir, getBinding, fetch: transport, now: Date.now };
	const start = () => {
		const forwarder = createMobileNotificationForwarder(options);
		forwarders.push(forwarder);
		return forwarder;
	};
	const file = join(dataDir, "device-mobile-notifications.json");
	const saved = async () => JSON.parse(await readFile(file, "utf8"));
	return { forwarder: start(), start, file, saved, fetchHub, fetchUser, transport, dataDir };
}
async function settled(check: () => void | Promise<void>) {
	await vi.waitFor(check, { timeout: 2000, interval: 10 });
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(epoch);
});
afterEach(async () => {
	await Promise.all(forwarders.splice(0).map((forwarder) => forwarder.dispose()));
	vi.useRealTimers();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("device mobile notification forwarder", () => {
	it("does not queue or send while unbound", async () => {
		const f = await fixture(() => undefined);
		await f.forwarder.enqueue(event());
		await vi.advanceTimersByTimeAsync(1000);
		expect(f.fetchHub).not.toHaveBeenCalled();
		await expect(readFile(f.file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("persists before background delivery, sends the allowlist with live credentials, then removes success", async () => {
		let complete!: (response: Response) => void;
		const f = await fixture(
			binding,
			vi.fn<typeof fetch>().mockImplementation(
				() =>
					new Promise((resolve) => {
						complete = resolve;
					}),
			),
		);
		await f.forwarder.enqueue({
			...event(),
			deviceId: "spoof",
			deviceName: "private name",
			accountId: "spoof-account",
			token: "private-token",
		} as MobileNotificationEvent);
		expect((await f.saved()).entries).toHaveLength(1);
		await settled(() => expect(f.fetchHub).toHaveBeenCalledTimes(1));
		const [url, init] = f.fetchHub.mock.calls[0];
		expect(url).toBe("https://hub.example/api/agent/mobile-notifications");
		expect(init).toMatchObject({
			method: "POST",
			redirect: "error",
			headers: {
				"X-Device-Id": "device-1",
				Authorization: `Bearer ${binding().credential}`,
			},
		});
		expect(JSON.parse(init!.body as string)).toEqual(event());
		const disk = await readFile(f.file, "utf8");
		for (const secret of [
			binding().credential,
			binding().uiCredential,
			"private-token",
			"private name",
			"spoof-account",
			"owner-1",
		])
			expect(disk).not.toContain(secret);
		complete(new Response(null, { status: 200 }));
		await settled(async () => expect((await f.saved()).entries).toHaveLength(0));
	});

	it("retries offline delivery after restart and deletes acknowledged events", async () => {
		const f = await fixture(
			binding,
			vi.fn<typeof fetch>().mockRejectedValue(new Error(`offline ${binding().credential}`)),
		);
		await f.forwarder.enqueue(event());
		await settled(async () => expect((await f.saved()).entries[0].attempts).toBe(1));
		await f.forwarder.dispose();
		expect(await readFile(f.file, "utf8")).not.toContain(binding().credential);
		f.fetchHub.mockResolvedValue(new Response(null, { status: 200 }));
		f.start();
		await vi.advanceTimersByTimeAsync(6000);
		await settled(() => expect(f.fetchHub).toHaveBeenCalledTimes(2));
		await settled(async () => expect((await f.saved()).entries).toHaveLength(0));
	});

	it("deduplicates concurrent enqueues while offline", async () => {
		const f = await fixture(binding, vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")));
		await Promise.all(Array.from({ length: 8 }, () => f.forwarder.enqueue(event())));
		expect((await f.saved()).entries).toHaveLength(1);
		await settled(() => expect(f.fetchHub).toHaveBeenCalledTimes(1));
	});

	it.each([429, 500, 503])("retries HTTP %i with finite backoff", async (status) => {
		const f = await fixture(binding, vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })));
		await f.forwarder.enqueue(event());
		await settled(() => expect(f.fetchHub).toHaveBeenCalledTimes(1));
		await settled(async () => expect((await f.saved()).entries[0].attempts).toBe(1));
		await vi.advanceTimersByTimeAsync(1000);
		expect(f.fetchHub).toHaveBeenCalledTimes(1);
		f.fetchHub.mockResolvedValue(new Response(null, { status: 200 }));
		await vi.advanceTimersByTimeAsync(6000);
		await settled(async () => expect((await f.saved()).entries).toHaveLength(0));
		expect(f.fetchHub).toHaveBeenCalledTimes(2);
	});

	it.each([401, 403])("permanently blocks revoked binding after HTTP %i, including restart", async (status) => {
		const f = await fixture(binding, vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })));
		await f.forwarder.enqueue(event());
		await settled(async () => {
			const outbox = await f.saved();
			expect(outbox.entries).toHaveLength(0);
			expect(outbox.blocked).toMatch(/^[a-f0-9]{64}$/);
		});
		await f.forwarder.dispose();
		const restarted = f.start();
		await restarted.enqueue(event("event-2"));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.fetchHub).toHaveBeenCalledTimes(1);
	});

	it("drops permanent payload failures without blocking future events", async () => {
		const f = await fixture(binding, vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 400 })));
		await f.forwarder.enqueue(event());
		await settled(async () => expect((await f.saved()).entries).toHaveLength(0));
		f.fetchHub.mockResolvedValue(new Response(null, { status: 200 }));
		await f.forwarder.enqueue(event("event-2"));
		await settled(() => expect(f.fetchHub).toHaveBeenCalledTimes(2));
	});

	it.each(["hubUrl", "deviceId", "accountId", "credential", "uiCredential", "unbind"] as const)(
		"drops old queued events after %s changes",
		async (field) => {
			let current: ReturnType<typeof binding> | undefined = binding();
			const f = await fixture(() => current, vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")));
			await f.forwarder.enqueue(event());
			await settled(() => expect(f.fetchHub).toHaveBeenCalledTimes(1));
			await f.forwarder.dispose();
			if (field === "unbind") current = undefined;
			else current = { ...binding(), [field]: field === "hubUrl" ? "https://new-hub.example" : "new-value" };
			f.fetchHub.mockResolvedValue(new Response(null, { status: 200 }));
			f.start();
			await settled(async () => expect((await f.saved()).entries).toHaveLength(0));
			await vi.advanceTimersByTimeAsync(10_000);
			expect(f.fetchHub).toHaveBeenCalledTimes(1);
		},
	);

	it.each([401, 403])(
		"rejects a remotely revoked UI grant (%i) even if the original device credential still works",
		async (status) => {
			const f = await fixture();
			f.fetchUser.mockResolvedValue(new Response(null, { status }));
			await f.forwarder.enqueue(event());
			await settled(async () => expect((await f.saved()).blocked).toBeDefined());
			expect(f.fetchHub).not.toHaveBeenCalled();
			expect(f.fetchUser.mock.calls[0]).toMatchObject([
				"https://hub.example/api/device-user/devices",
				{ method: "GET", headers: { "X-Device-Id": "device-1", Authorization: `Bearer ${binding().uiCredential}` } },
			]);
		},
	);

	it("rechecks the binding after UI verification before posting", async () => {
		let current = binding();
		const f = await fixture(() => current);
		f.fetchUser.mockImplementation(async () => {
			current = { ...binding(), accountId: "new-owner", uiCredential: "new-ui-grant" };
			return new Response(null, { status: 200 });
		});
		await f.forwarder.enqueue(event());
		await settled(async () => expect((await f.saved()).entries).toHaveLength(0));
		expect(f.fetchHub).not.toHaveBeenCalled();
	});

	it("supports existing bindings without a UI credential", async () => {
		const f = await fixture(() => ({ ...binding(), uiCredential: undefined }));
		await f.forwarder.enqueue(event());
		await settled(async () => expect((await f.saved()).entries).toHaveLength(0));
		expect(f.fetchUser).not.toHaveBeenCalled();
		expect(f.fetchHub).toHaveBeenCalledTimes(1);
	});

	it("uses a new binding only for new events after UI revocation", async () => {
		let current = binding();
		const f = await fixture(
			() => current,
			vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 })),
		);
		await f.forwarder.enqueue(event());
		await settled(async () => expect((await f.saved()).blocked).toBeDefined());
		current = { ...binding(), accountId: "new-owner", uiCredential: "new-ui-secret", credential: "new-device-secret" };
		f.fetchHub.mockResolvedValue(new Response(null, { status: 200 }));
		await f.forwarder.enqueue(event("event-2"));
		await settled(() => expect(f.fetchHub).toHaveBeenCalledTimes(2));
		expect(f.fetchHub.mock.calls[1][1]!.headers).toMatchObject({ Authorization: "Bearer new-device-secret" });
		expect(JSON.parse(f.fetchHub.mock.calls[1][1]!.body as string).eventId).toBe("event-2");
	});

	it("times out an unresponsive fetch without blocking enqueue or shutdown", async () => {
		const f = await fixture(
			binding,
			vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {})),
		);
		await f.forwarder.enqueue(event());
		await settled(() => expect(f.fetchHub).toHaveBeenCalledTimes(1));
		await vi.advanceTimersByTimeAsync(16_000);
		await settled(async () => expect((await f.saved()).entries[0].attempts).toBeGreaterThanOrEqual(1));
		await f.forwarder.enqueue(event("event-2"));
		expect((await f.saved()).entries).toHaveLength(2);
		await f.forwarder.dispose();
		expect(f.fetchHub.mock.calls[0][1]!.signal!.aborted).toBe(true);
	});

	it("expires events at 24 hours, including restored outboxes", async () => {
		const f = await fixture(binding, vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")));
		await f.forwarder.enqueue(event());
		await settled(() => expect(f.fetchHub).toHaveBeenCalledTimes(1));
		await f.forwarder.dispose();
		vi.setSystemTime(epoch + 24 * 60 * 60 * 1000);
		const restarted = f.start();
		await restarted.enqueue(event("expired"));
		expect((await f.saved()).entries).toHaveLength(0);
		expect(f.fetchHub).toHaveBeenCalledTimes(1);
	});

	it("drops restored events after the attempt limit", async () => {
		const f = await fixture(binding, vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")));
		await f.forwarder.enqueue(event());
		await f.forwarder.dispose();
		const outbox = await f.saved();
		outbox.entries[0].attempts = 32;
		await writeFile(f.file, JSON.stringify(outbox));
		f.start();
		await settled(async () => expect((await f.saved()).entries).toHaveLength(0));
		expect(f.fetchHub).not.toHaveBeenCalled();
	});

	it("keeps a bounded outbox and explicitly rejects overflow", async () => {
		const f = await fixture(
			binding,
			vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {})),
		);
		await Promise.all(Array.from({ length: 256 }, (_, i) => f.forwarder.enqueue(event(`event-${i}`))));
		await expect(f.forwarder.enqueue(event("overflow"))).rejects.toThrow("outbox is full");
		expect((await f.saved()).entries).toHaveLength(256);
	});

	it("does not send when durable persistence fails", async () => {
		const f = await fixture();
		await f.forwarder.dispose();
		await rm(f.dataDir, { recursive: true, force: true });
		await writeFile(f.dataDir, "not a directory");
		const restarted = f.start();
		await expect(restarted.enqueue(event())).rejects.toBeDefined();
		expect(f.fetchHub).not.toHaveBeenCalled();
	});
});
