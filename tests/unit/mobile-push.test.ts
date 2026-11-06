import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express, Request, Response as ExpressResponse } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMobilePushService, type MobilePushService } from "../../server/mobile-push.js";
import type { MobileNotificationEvent } from "../../server/mobile-notification-events.js";

const DAY = 86_400_000;
const env = {
	PI_WEB_JPUSH_APP_KEY: "app-key",
	PI_WEB_JPUSH_MASTER_SECRET: "master-secret",
	PI_WEB_JPUSH_APNS_PRODUCTION: "false",
};
const base = "/api/mobile-push";
let dataDir: string;
let clock: number;
let services: MobilePushService[];

function event(overrides: Partial<MobileNotificationEvent> = {}): MobileNotificationEvent {
	return {
		eventId: randomUUID(),
		kind: "done",
		clientId: "client-1",
		sessionId: "session-1",
		conversationId: "conversation-1",
		occurredAt: clock,
		...overrides,
	};
}
function device(overrides: Record<string, unknown> = {}) {
	return {
		deviceId: randomUUID(),
		registrationId: `registration_${randomUUID().replaceAll("-", "")}`,
		platform: "android",
		...overrides,
	};
}
function harness(
	fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 })),
	configuration: NodeJS.ProcessEnv = env,
	scoped = false,
) {
	const service = createMobilePushService({ dataDir, env: configuration, fetch: fetcher, now: () => clock });
	services.push(service);
	const routes = new Map<string, (req: Request, res: ExpressResponse) => void>();
	const app = {} as Express;
	for (const method of ["get", "post", "patch", "delete"] as const) {
		(app[method] as unknown) = (path: string, handler: (req: Request, res: ExpressResponse) => void) => {
			routes.set(`${method} ${path}`, handler);
		};
	}
	service.registerRoutes(app, scoped ? { getScope: (req) => req.headers["x-test-scope"] as string } : {});
	async function request(
		method: string,
		path: string,
		body?: unknown,
		deviceId?: string,
		scopeId?: string,
	): Promise<{ status: number; body: any }> {
		const handler = routes.get(`${method} ${base}${path}`);
		if (!handler) throw new Error("Missing route");
		return new Promise((resolve) => {
			let status = 200;
			const response = {
				headersSent: false,
				status(value: number) {
					status = value;
					return response;
				},
				json(value: unknown) {
					resolve({ status, body: value });
					return response;
				},
			} as unknown as ExpressResponse;
			handler(
				{
					body,
					headers: { "x-test-scope": scopeId },
					params: { deviceId },
					query: method === "get" && deviceId !== undefined ? { deviceId } : {},
				} as unknown as Request,
				response,
			);
		});
	}
	return { service, fetcher, request };
}
async function disk() {
	return JSON.parse(await readFile(join(dataDir, "mobile-push.json"), "utf8"));
}
async function advance(ms: number) {
	clock += ms;
	await vi.advanceTimersByTimeAsync(ms);
}
async function settledOutbox(size: number) {
	await vi.waitFor(async () => expect((await disk()).outbox).toHaveLength(size), { timeout: 3000 });
}

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "pi-mobile-push-"));
	clock = 1_750_000_000_000;
	services = [];
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(async () => {
	await Promise.all(services.map((service) => service.dispose()));
	vi.useRealTimers();
	await rm(dataDir, { recursive: true, force: true });
});

describe("mobile-push registration and storage", () => {
	it("validates registration/settings and never exposes credentials or registration IDs", async () => {
		const h = harness();
		for (const bad of [
			{},
			device({ deviceId: "path/../../secret" }),
			device({ registrationId: "bad token" }),
			device({ platform: "web" }),
			device({ enabled: "yes" }),
			device({ kinds: ["unknown"] }),
			device({ kinds: null }),
			device({ preview: "full" }),
			device({ watchClientIds: ["\n"] }),
			device({ secret: "input-secret" }),
		])
			expect((await h.request("post", "/devices", bad)).status).toBe(400);
		const d = device();
		const registration = await h.request("post", "/devices", d);
		expect(registration.status).toBe(200);
		expect(registration.body.device).toMatchObject({ deviceId: d.deviceId, enabled: true, preview: "generic" });
		const status = await h.request("get", "/status");
		expect(status.body).toMatchObject({
			configured: true,
			enabled: true,
			channel: { provider: "jpush", ios: { apnsProduction: false } },
		});
		for (const value of [
			JSON.stringify(registration),
			JSON.stringify(status),
			await readFile(join(dataDir, "mobile-push.json"), "utf8"),
		]) {
			expect(value).not.toContain(env.PI_WEB_JPUSH_MASTER_SECRET);
			expect(value).not.toContain(env.PI_WEB_JPUSH_APP_KEY);
			expect(value).not.toContain(Buffer.from("app-key:master-secret").toString("base64"));
		}
		expect(JSON.stringify(registration)).not.toContain(d.registrationId);
		expect(JSON.stringify(status)).not.toContain(d.registrationId);
		if (process.platform !== "win32") expect((await stat(join(dataDir, "mobile-push.json"))).mode & 0o777).toBe(0o600);
		expect(await readdir(dataDir)).toEqual(["mobile-push.json"]);
		expect(h.fetcher).not.toHaveBeenCalled();
	});

	it("upserts a single device on token rotation, preserves settings, and prevents duplicate token ownership", async () => {
		const h = harness();
		const d = device({ kinds: ["question"], watchClientIds: ["client-1"] });
		await h.request("post", "/devices", d);
		expect((await h.request("patch", "/devices/:deviceId", { enabled: false }, d.deviceId as string)).status).toBe(200);
		const next = { deviceId: d.deviceId, registrationId: "rotated_token_1234", platform: "android" };
		expect((await h.request("post", "/devices", next)).status).toBe(200);
		const saved = await disk();
		expect(saved.devices).toHaveLength(1);
		expect(saved.devices[0]).toMatchObject({
			registrationId: next.registrationId,
			enabled: false,
			kinds: ["question"],
		});
		expect((await h.request("post", "/devices", device({ registrationId: next.registrationId }))).status).toBe(409);
		expect(
			(await h.request("patch", "/devices/:deviceId", { registrationId: "forbidden_token" }, d.deviceId as string))
				.status,
		).toBe(400);
		await h.request("delete", "/devices/:deviceId", undefined, d.deviceId as string);
		expect((await disk()).devices).toEqual([]);
		expect((await h.request("get", "/status")).body.enabled).toBe(false);
	});

	it("returns stable instance identity and only the requested installation subscription", async () => {
		const h = harness();
		const first = device({ enabled: false, kinds: ["question"], watchClientIds: ["client-1"] });
		const second = device();
		await h.request("post", "/devices", first);
		await h.request("post", "/devices", second);
		const status = await h.request("get", "/status", undefined, first.deviceId as string);
		expect(status.body).toMatchObject({
			enabled: true,
			instanceId: (await disk()).instanceId,
			device: { deviceId: first.deviceId, enabled: false, kinds: ["question"] },
		});
		expect(JSON.stringify(status)).not.toContain(first.registrationId);
		expect(JSON.stringify(status)).not.toContain(second.deviceId);
		expect((await h.request("get", "/status", undefined, randomUUID())).body.device).toBeNull();
		expect((await h.request("get", "/status", undefined, "bad-id")).status).toBe(400);
		await h.request("patch", "/devices/:deviceId", { watchClientIds: null }, first.deviceId as string);
		expect((await disk()).devices.find((d: any) => d.deviceId === first.deviceId)).not.toHaveProperty("watchClientIds");
	});

	it("reports registration and initialization storage failures without accepting phantom devices", async () => {
		const h = harness();
		await h.request("get", "/status");
		const { mkdir } = await import("node:fs/promises");
		await rm(join(dataDir, "mobile-push.json"));
		await mkdir(join(dataDir, "mobile-push.json"));
		expect((await h.request("post", "/devices", device())).status).toBe(503);
		expect((await h.request("get", "/status")).body.enabled).toBe(false);
		expect(await readdir(dataDir)).toEqual(["mobile-push.json"]);
		await rm(join(dataDir, "mobile-push.json"), { recursive: true });
		await writeFile(join(dataDir, "mobile-push.json"), "{broken");
		const broken = harness();
		expect(await broken.request("get", "/status")).toEqual({
			status: 503,
			body: { error: "Mobile push storage unavailable" },
		});
		expect((await broken.request("post", "/devices", device())).status).toBe(503);
	});

	it("persists the instanceId even before any device is registered", async () => {
		const first = harness();
		const status = await first.request("get", "/status");
		await first.service.dispose();
		const restarted = harness();
		expect((await restarted.request("get", "/status")).body.instanceId).toBe(status.body.instanceId);
	});

	it("does not accumulate an outbox or contact JPush without server credentials", async () => {
		const h = harness(undefined, {});
		const d = device();
		await h.request("post", "/devices", d);
		for (let i = 0; i < 100; i++) await h.service.handleEvent(event());
		await advance(DAY);
		expect(h.fetcher).not.toHaveBeenCalled();
		expect((await disk()).outbox).toEqual([]);
		expect((await disk()).seen).toEqual([]);
		expect((await h.request("post", "/devices/:deviceId/test", {}, d.deviceId as string)).status).toBe(409);
		expect((await h.request("get", "/status")).body.configured).toBe(false);
	});
});

describe("mobile-push event privacy and targeting", () => {
	it("deduplicates concurrent events, sends only generic content and exact routing extras, never broadcasts", async () => {
		const h = harness();
		const d = device();
		await h.request("post", "/devices", d);
		const e = {
			...event({ kind: "approval" }),
			text: "PRIVATE CONVERSATION",
			path: "/secret/file",
			toolArgs: { argument: "PRIVATE PARAMETER" },
		};
		await Promise.all([h.service.handleEvent(e), h.service.handleEvent(e), h.service.handleEvent(e)]);
		await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(1));
		await settledOutbox(0);
		const [url, init] = h.fetcher.mock.calls[0];
		expect(url).toBe("https://api.jpush.cn/v3/push");
		expect(init).toMatchObject({
			redirect: "error",
			headers: { Authorization: `Basic ${Buffer.from("app-key:master-secret").toString("base64")}` },
		});
		const payload = JSON.parse(init!.body as string);
		expect(payload.audience).toEqual({ registration_id: [d.registrationId] });
		expect(payload.notification.android).toMatchObject({
			priority: 2,
			channel_id: "pi_attention",
			title: "有操作等待审批",
		});
		expect(payload.notification.android.extras).toEqual({
			eventId: e.eventId,
			kind: "approval",
			clientId: e.clientId,
			sessionId: e.sessionId,
			conversationId: e.conversationId,
			instanceId: (await disk()).instanceId,
		});
		const serialized = JSON.stringify({ payload, disk: await disk() });
		for (const privateValue of [e.text, e.path, e.toolArgs.argument]) expect(serialized).not.toContain(privateValue);
		await h.service.handleEvent(e);
		await advance(60_000);
		expect(h.fetcher).toHaveBeenCalledTimes(1);
	});

	it("applies enabled, kind and watched-client filters and drops work on unbind", async () => {
		const h = harness();
		const target = device({ kinds: ["question"], watchClientIds: ["client-1"] });
		for (const d of [
			target,
			device({ enabled: false }),
			device({ kinds: [] }),
			device({ watchClientIds: [] }),
			device({ watchClientIds: ["other-client"] }),
		])
			await h.request("post", "/devices", d);
		await h.service.handleEvent(event({ kind: "done" }));
		expect((await disk()).outbox).toHaveLength(0);
		await h.service.handleEvent(event({ kind: "question" }));
		expect((await disk()).outbox).toHaveLength(1);
		await h.request("delete", "/devices/:deviceId", undefined, target.deviceId as string);
		expect((await disk()).outbox).toHaveLength(0);
		await advance(1000);
		expect(h.fetcher).not.toHaveBeenCalled();
	});

	it.each(["true", "false"])("uses explicit APNs production=%s and the ios audience only", async (production) => {
		const h = harness(undefined, { ...env, PI_WEB_JPUSH_APNS_PRODUCTION: production });
		const d = device({ platform: "ios" });
		await h.request("post", "/devices", d);
		await h.service.handleEvent(event());
		await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(1));
		const payload = JSON.parse(h.fetcher.mock.calls[0][1]!.body as string);
		expect(payload.platform).toEqual(["ios"]);
		expect(payload.options.apns_production).toBe(production === "true");
		expect(payload.notification.ios.alert.body).toBe("请打开应用查看最新状态。");
	});

	it("requires explicit APNs configuration and test requests before test notifications", async () => {
		const h = harness(undefined, { ...env, PI_WEB_JPUSH_APNS_PRODUCTION: undefined });
		const ios = device({ platform: "ios" });
		const android = device({ kinds: [], watchClientIds: [] });
		await h.request("post", "/devices", ios);
		await h.request("post", "/devices", android);
		await h.service.handleEvent(event());
		await advance(1000);
		expect(h.fetcher).not.toHaveBeenCalled();
		expect((await h.request("post", "/devices/:deviceId/test", {}, ios.deviceId as string)).status).toBe(409);
		expect(await h.request("post", "/devices/:deviceId/test", {}, android.deviceId as string)).toEqual({
			status: 202,
			body: { queued: true },
		});
		await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(1));
		expect(JSON.parse(h.fetcher.mock.calls[0][1]!.body as string).notification.android.title).toBe("推送测试");
	});
});

describe("mobile-push Hub account isolation", () => {
	it("isolates subscription routes and prevents cross-account installation/token takeover", async () => {
		const h = harness(undefined, env, true);
		const a = device();
		const b = device();
		const registerA = await h.request("post", "/devices", a, undefined, "account-a");
		expect(registerA.status).toBe(200);
		expect(registerA.body.device).not.toHaveProperty("scopeId");
		expect((await h.request("get", "/status", undefined, undefined, "account-b")).body.enabled).toBe(false);
		expect((await h.request("get", "/status", undefined, a.deviceId as string, "account-b")).body.device).toBeNull();
		expect(
			(await h.request("post", "/devices", { ...a, registrationId: "stolen_registration_123" }, undefined, "account-b"))
				.status,
		).toBe(409);
		expect(
			(await h.request("post", "/devices", { ...b, registrationId: a.registrationId }, undefined, "account-b")).status,
		).toBe(409);
		expect((await h.request("post", "/devices", { ...b, scopeId: "account-a" }, undefined, "account-b")).status).toBe(
			400,
		);
		expect(
			(await h.request("patch", "/devices/:deviceId", { enabled: false }, a.deviceId as string, "account-b")).status,
		).toBe(404);
		expect((await h.request("post", "/devices/:deviceId/test", {}, a.deviceId as string, "account-b")).status).toBe(
			404,
		);
		expect((await h.request("delete", "/devices/:deviceId", undefined, a.deviceId as string, "account-b")).status).toBe(
			200,
		);
		expect((await h.request("get", "/status", undefined, a.deviceId as string, "account-a")).body.device.enabled).toBe(
			true,
		);
		await h.request("post", "/devices", b, undefined, "account-b");
		await h.request("patch", "/devices/:deviceId", { enabled: false }, a.deviceId as string, "account-a");
		expect((await h.request("get", "/status", undefined, undefined, "account-a")).body.enabled).toBe(false);
		expect((await h.request("get", "/status", undefined, undefined, "account-b")).body.enabled).toBe(true);
		expect((await disk()).devices.map((d: any) => d.scopeId).sort()).toEqual(["account-a", "account-b"]);
		expect(h.fetcher).not.toHaveBeenCalled();
	});

	it("rejects missing/invalid authenticated scopes instead of falling back to local", async () => {
		const h = harness(undefined, env, true);
		for (const scope of [undefined, "", " ", "bad\nscope"]) {
			expect((await h.request("post", "/devices", device(), undefined, scope)).status).toBe(401);
			expect((await h.request("get", "/status", undefined, undefined, scope)).status).toBe(401);
		}
		await expect(h.service.handleEvent(event(), "")).rejects.toMatchObject({ status: 401 });
		expect(h.fetcher).not.toHaveBeenCalled();
	});

	it("rejects corrupt persisted account identities instead of migrating them to local", async () => {
		const first = harness();
		await first.request("post", "/devices", device());
		await first.service.dispose();
		const saved = await disk();
		saved.devices[0].scopeId = null;
		await writeFile(join(dataDir, "mobile-push.json"), JSON.stringify(saved));
		const restarted = harness(undefined, env, true);
		expect((await restarted.request("get", "/status", undefined, undefined, "account-a")).status).toBe(503);
		expect(restarted.fetcher).not.toHaveBeenCalled();
	});

	it("routes all trusted source devices within their account and deduplicates by account/source", async () => {
		const h = harness(undefined, env, true);
		const a1 = device();
		const a2 = device();
		const b = device();
		const local = device();
		await h.request("post", "/devices", a1, undefined, "account-a");
		await h.request("post", "/devices", a2, undefined, "account-a");
		await h.request("post", "/devices", b, undefined, "account-b");
		await h.request("post", "/devices", local, undefined, "local");
		const name = "工作电脑".repeat(12);
		const e = { ...event({ deviceId: "hub-device-1", deviceName: name }), scopeId: "forged-scope" };
		await h.service.handleEvent(e, "account-a");
		await h.service.handleEvent(e, "account-a");
		await h.service.handleEvent(e, "account-b");
		await h.service.handleEvent(e, "account-b");
		await h.service.handleEvent({ ...e, deviceId: "hub-device-2" }, "account-a");
		await h.service.handleEvent(e);
		const queued = (await disk()).outbox;
		expect(queued.filter((p: any) => p.scopeId === "account-a")).toHaveLength(4);
		expect(queued.filter((p: any) => p.scopeId === "account-b")).toHaveLength(1);
		expect(queued.filter((p: any) => p.scopeId === "local")).toHaveLength(1);
		await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(6));
		await settledOutbox(0);
		const sent = h.fetcher.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
		const bSent = sent.filter((p) => p.audience.registration_id[0] === b.registrationId);
		expect(bSent).toHaveLength(1);
		expect(bSent[0].notification.android.extras.deviceId).toBe("hub-device-1");
		const aSent = sent.filter((p) => [a1.registrationId, a2.registrationId].includes(p.audience.registration_id[0]));
		expect(aSent.map((p) => p.notification.android.extras.deviceId).sort()).toEqual([
			"hub-device-1",
			"hub-device-1",
			"hub-device-2",
			"hub-device-2",
		]);
		for (const payload of sent) {
			expect(payload.notification.android.title).toBe(`${Array.from(name).slice(0, 24).join("")} · 任务已完成`);
			expect(payload.notification.android.extras).not.toHaveProperty("deviceName");
			expect(payload.notification.android.extras).not.toHaveProperty("scopeId");
			expect(payload.notification.android.extras.instanceId).toBe((await disk()).instanceId);
		}
	});

	it("keeps watched-client filters scoped and sends an explicit test only to its owning account", async () => {
		const h = harness(undefined, env, true);
		const a = device({ watchClientIds: ["client-2"] });
		const b = device();
		await h.request("post", "/devices", a, undefined, "account-a");
		await h.request("post", "/devices", b, undefined, "account-b");
		await h.service.handleEvent(event({ deviceId: "source-a" }), "account-a");
		expect((await disk()).outbox).toHaveLength(0);
		await h.service.handleEvent(event({ clientId: "client-2", deviceId: "source-a" }), "account-a");
		await h.request("post", "/devices/:deviceId/test", {}, b.deviceId as string, "account-b");
		await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(2));
		await settledOutbox(0);
		const payloads = h.fetcher.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
		expect(
			payloads.find((p) => p.audience.registration_id[0] === a.registrationId).notification.android.extras.deviceId,
		).toBe("source-a");
		expect(payloads.find((p) => p.audience.registration_id[0] === b.registrationId).notification.android.title).toBe(
			"推送测试",
		);
	});

	it("retains scoped outbox/dedupe and source device routing across restart", async () => {
		const first = harness(undefined, env, true);
		const a = device();
		const b = device();
		await first.request("post", "/devices", a, undefined, "account-a");
		await first.request("post", "/devices", b, undefined, "account-b");
		const e = event({ deviceId: "source-a", deviceName: "开发机" });
		await first.service.handleEvent(e, "account-a");
		await first.service.handleEvent(e, "account-b");
		await first.service.dispose();
		const instanceId = (await disk()).instanceId;
		const restarted = harness(undefined, env, true);
		await restarted.service.handleEvent(e, "account-a");
		await restarted.service.handleEvent(e, "account-b");
		await vi.waitFor(() => expect(restarted.fetcher).toHaveBeenCalledTimes(2));
		await settledOutbox(0);
		expect((await disk()).instanceId).toBe(instanceId);
		await restarted.service.handleEvent(e, "account-a");
		await restarted.service.handleEvent(e, "account-b");
		await advance(1000);
		expect(restarted.fetcher).toHaveBeenCalledTimes(2);
		expect(
			(await restarted.request("get", "/status", undefined, a.deviceId as string, "account-b")).body.device,
		).toBeNull();
	});

	it("migrates unscoped persisted records to local without exposing them to Hub accounts", async () => {
		const first = harness();
		const d = device();
		await first.request("post", "/devices", d);
		const e = event();
		await first.service.handleEvent(e);
		await first.service.dispose();
		const legacy = await disk();
		for (const record of [...legacy.devices, ...legacy.seen, ...legacy.outbox]) delete record.scopeId;
		await writeFile(join(dataDir, "mobile-push.json"), JSON.stringify(legacy));
		const restarted = harness(undefined, env, true);
		const hub = await restarted.request("get", "/status", undefined, d.deviceId as string, "account-a");
		expect(hub.body.enabled).toBe(false);
		expect(hub.body.device).toBeNull();
		expect(
			(await restarted.request("get", "/status", undefined, d.deviceId as string, "local")).body.device.deviceId,
		).toBe(d.deviceId);
		expect((await disk()).devices[0].scopeId).toBe("local");
		await restarted.service.handleEvent(e);
		await vi.waitFor(() => expect(restarted.fetcher).toHaveBeenCalledTimes(1));
		await settledOutbox(0);
	});
});

describe("mobile-push durable per-device outbox", () => {
	it("honors Retry-After and retries only the failed device", async () => {
		const first = device();
		const second = device();
		let failed = false;
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
			const token = JSON.parse(init!.body as string).audience.registration_id[0];
			if (token === second.registrationId && !failed) {
				failed = true;
				return new Response(null, { status: 429, headers: { "Retry-After": "120" } });
			}
			return new Response(null, { status: 200 });
		});
		const h = harness(fetcher);
		await h.request("post", "/devices", first);
		await h.request("post", "/devices", second);
		await h.service.handleEvent(event());
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
		await settledOutbox(1);
		await vi.waitFor(async () => expect((await disk()).outbox[0].nextAttemptAt).toBe(clock + 120_000));
		await advance(119_000);
		expect(fetcher).toHaveBeenCalledTimes(2);
		await advance(1000);
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
		await settledOutbox(0);
		expect(fetcher.mock.calls.map(([, init]) => JSON.parse(init!.body as string).audience.registration_id[0])).toEqual([
			first.registrationId,
			second.registrationId,
			second.registrationId,
		]);
	});

	it("resumes persisted retries after restart with the same instanceId and deduplication", async () => {
		const fail = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
		const h = harness(fail);
		await h.request("post", "/devices", device());
		const e = event();
		await h.service.handleEvent(e);
		await vi.waitFor(() => expect(fail).toHaveBeenCalledTimes(1));
		await vi.waitFor(async () => expect((await disk()).outbox[0].nextAttemptAt).toBe(clock + 1000));
		const instanceId = (await disk()).instanceId;
		await h.service.dispose();
		const restarted = harness();
		await restarted.service.handleEvent(e);
		await advance(1000);
		await vi.waitFor(() => expect(restarted.fetcher).toHaveBeenCalledTimes(1));
		await settledOutbox(0);
		expect((await disk()).instanceId).toBe(instanceId);
		await restarted.service.handleEvent(e);
		await advance(1000);
		expect(restarted.fetcher).toHaveBeenCalledTimes(1);
	});

	it("uses the rotated registrationId for pending retries and keeps a single device record", async () => {
		const fail = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 500 }));
		const h = harness(fail);
		const d = device();
		await h.request("post", "/devices", d);
		await h.service.handleEvent(event());
		await vi.waitFor(() => expect(fail).toHaveBeenCalledTimes(1));
		await vi.waitFor(async () => expect((await disk()).outbox[0].nextAttemptAt).toBe(clock + 1000));
		fail.mockResolvedValue(new Response(null, { status: 200 }));
		await h.request("post", "/devices", { ...d, registrationId: "new_registration_12345" });
		await vi.waitFor(() => expect(fail).toHaveBeenCalledTimes(2));
		await settledOutbox(0);
		expect(JSON.parse(fail.mock.calls[1][1]!.body as string).audience).toEqual({
			registration_id: ["new_registration_12345"],
		});
		expect((await disk()).devices).toHaveLength(1);
	});

	it("keeps a rotated token pending when the old token succeeds during an in-flight request", async () => {
		let acceptOld!: (response: Response) => void;
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementationOnce(
				() =>
					new Promise<Response>((resolve) => {
						acceptOld = resolve;
					}),
			)
			.mockResolvedValue(new Response(null, { status: 200 }));
		const h = harness(fetcher);
		const d = device();
		await h.request("post", "/devices", d);
		await h.service.handleEvent(event());
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
		await h.request("post", "/devices", { ...d, registrationId: "new_inflight_token_123" });
		acceptOld(new Response(null, { status: 200 }));
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
		await settledOutbox(0);
		expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).audience.registration_id).toEqual([
			"new_inflight_token_123",
		]);
	});

	it("persists known provider acceptance when shutdown races with the response", async () => {
		let accept!: (response: Response) => void;
		const h = harness(
			vi.fn<typeof fetch>().mockImplementation(
				() =>
					new Promise<Response>((resolve) => {
						accept = resolve;
					}),
			),
		);
		await h.request("post", "/devices", device());
		await h.service.handleEvent(event());
		await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(1));
		const closing = h.service.dispose();
		accept(new Response(null, { status: 200 }));
		await closing;
		expect((await disk()).outbox).toHaveLength(0);
		const restarted = harness();
		await restarted.request("get", "/status");
		await advance(60_000);
		expect(restarted.fetcher).not.toHaveBeenCalled();
	});

	it.each([400, 401, 403, 404])("removes permanent HTTP %i failures without retry", async (status) => {
		const h = harness(vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })));
		await h.request("post", "/devices", device());
		await h.service.handleEvent(event());
		await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(1));
		await settledOutbox(0);
		await advance(HOUR_FOR_TEST);
		expect(h.fetcher).toHaveBeenCalledTimes(1);
	});

	it("bounds the durable outbox and dedupe history without losing already queued work", async () => {
		const h = harness();
		const d = device();
		await h.request("post", "/devices", d);
		await h.service.dispose();
		const saved = await disk();
		saved.seen = Array.from({ length: 4096 }, (_, i) => ({ eventId: `seen-${i}`, expiresAt: clock + DAY }));
		saved.outbox = Array.from({ length: 2000 }, () => ({
			id: randomUUID(),
			deviceId: d.deviceId,
			event: event(),
			test: false,
			attempts: 0,
			nextAttemptAt: clock + 60_000,
			expiresAt: clock + DAY,
		}));
		await writeFile(join(dataDir, "mobile-push.json"), JSON.stringify(saved));
		const restarted = harness();
		await expect(restarted.service.handleEvent(event())).rejects.toMatchObject({ status: 503 });
		expect((await restarted.request("post", "/devices/:deviceId/test", {}, d.deviceId as string)).status).toBe(503);
		expect((await disk()).outbox).toHaveLength(2000);
		await restarted.request("delete", "/devices/:deviceId", undefined, d.deviceId as string);
		await restarted.service.handleEvent(event({ eventId: "new-event" }));
		const bounded = await disk();
		expect(bounded.outbox).toHaveLength(0);
		expect(bounded.seen).toHaveLength(4096);
		expect(bounded.seen[0].eventId).toBe("seen-1");
		expect(bounded.seen.at(-1).eventId).toBe("new-event");
		expect(restarted.fetcher).not.toHaveBeenCalled();
	});

	it("bounds network retries and cleans terminal work", async () => {
		const h = harness(vi.fn<typeof fetch>().mockRejectedValue(new Error("provider error with private data")));
		await h.request("post", "/devices", device());
		await h.service.handleEvent(event());
		for (let attempt = 1; attempt <= 5; attempt++) {
			await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(attempt));
			if (attempt < 5) {
				await vi.waitFor(async () =>
					expect((await disk()).outbox[0].nextAttemptAt).toBe(clock + 1000 * 2 ** (attempt - 1)),
				);
				await advance(1000 * 2 ** (attempt - 1));
			}
		}
		await settledOutbox(0);
		await advance(HOUR_FOR_TEST);
		expect(h.fetcher).toHaveBeenCalledTimes(5);
		expect(await readFile(join(dataDir, "mobile-push.json"), "utf8")).not.toContain("private data");
	});

	it("aborts timed-out requests without blocking event callbacks", async () => {
		const h = harness(
			vi.fn<typeof fetch>().mockImplementation(
				(_url, init) =>
					new Promise((_resolve, reject) => {
						init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
							once: true,
						});
					}),
			),
		);
		await h.request("post", "/devices", device());
		await h.service.handleEvent(event());
		await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(1));
		await expect(h.service.handleEvent(event())).resolves.toBeUndefined();
		const signal = h.fetcher.mock.calls[0][1]!.signal!;
		await advance(10_000);
		expect(signal.aborted).toBe(true);
	});

	it("expires stale queued events, dedupe records and 30-day devices on restart", async () => {
		const h = harness();
		const d = device();
		await h.request("post", "/devices", d);
		await h.service.handleEvent(event());
		await h.service.dispose();
		clock += 31 * DAY;
		const restarted = harness();
		await restarted.request("get", "/status");
		await advance(1000);
		expect(restarted.fetcher).not.toHaveBeenCalled();
		expect(await disk()).toMatchObject({ devices: [], outbox: [], seen: [] });
	});

	it("expires events after 24 hours while keeping a recent device registration", async () => {
		const h = harness();
		await h.request("post", "/devices", device());
		await h.service.handleEvent(event());
		await h.service.dispose();
		clock += DAY + 1;
		const restarted = harness();
		await restarted.request("get", "/status");
		await advance(1000);
		expect(restarted.fetcher).not.toHaveBeenCalled();
		expect((await disk()).devices).toHaveLength(1);
		expect((await disk()).outbox).toEqual([]);
		expect((await disk()).seen).toEqual([]);
	});
});
const HOUR_FOR_TEST = 3_600_000;
