import { createHash, createHmac, createCipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error jsdom is installed without declaration files in this project.
import { JSDOM } from "jsdom";
import view from "../../plugins/superagent/main.mjs";
import { createSuperagent } from "../../plugins/superagent/server.mjs";

const NOW = 1760000000000;
const disposers: (() => void)[] = [];
afterEach(() => {
	while (disposers.length) disposers.pop()?.();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function settings(mode = "observe") {
	return {
		github: {
			mode,
			mappings: [{ channelId: "owner/repo", roomId: "room-1" }],
			allowedAuthors: ["42"],
			allowedRepos: ["owner/repo"],
		},
		feishu: {
			mode,
			appId: "cli_test",
			mappings: [{ channelId: "oc_chat", roomId: "room-1" }],
			allowedAuthors: ["ou_user"],
		},
	};
}
function makeHost(mode = "observe", pollMs = 0) {
	let clock = NOW;
	const storage = new Map<string, any>([["config", settings(mode)]]);
	const secrets = new Map<string, string>([
		["githubSecret", "gh-secret"],
		["githubToken", "gh-token"],
		["feishuVerificationToken", "fs-token"],
		["feishuEncryptKey", "fs-key"],
		["feishuAppSecret", "fs-secret"],
	]);
	const routes = new Map<string, any>();
	const records = new Map<string, any>();
	const deliveries: any[] = [];
	const fetch = vi.fn();
	const workItems = {
		rooms: vi.fn(async () => [{ id: "room-1", name: "Engineering" }]),
		ingest: vi.fn(async (input: any) => {
			const existing = [...records.values()].find((r) => r.provider === input.provider && r.eventId === input.eventId);
			if (existing) return existing;
			const item = { ...input, id: `item-${records.size + 1}`, status: "open", manualAuthorized: false };
			records.set(item.id, item);
			return item;
		}),
		get: vi.fn(async (id: string) => records.get(id)),
		list: vi.fn(async ({ roomId }: any) => [...records.values()].filter((r) => !roomId || r.roomId === roomId)),
		update: vi.fn(async (id: string, patch: any) => {
			const old = records.get(id);
			if (!old) throw new Error("missing");
			const item = {
				...old,
				...patch,
				...(patch.authorized === undefined ? {} : { manualAuthorized: patch.authorized }),
			};
			records.set(id, item);
			return item;
		}),
		claimDelivery: vi.fn(async ({ provider, limit }: any) => {
			const batch = deliveries.filter((d) => d.provider === provider && d.state === "queued").slice(0, limit);
			for (const d of batch) {
				d.state = "leased";
				d.leaseToken = `lease-${d.attempts++}`;
			}
			return batch;
		}),
		completeDelivery: vi.fn(async (id: string, input: any) => {
			const entry = deliveries.find((d) => d.id === id);
			expect(input.leaseToken).toBe(entry.leaseToken);
			entry.state = "sent";
			entry.externalId = input.externalId;
		}),
		failDelivery: vi.fn(async (id: string, input: any) => {
			const entry = deliveries.find((d) => d.id === id);
			expect(input.leaseToken).toBe(entry.leaseToken);
			entry.state = "queued";
		}),
	};
	const host = {
		storage: {
			get: (key: string, fallback: any) => storage.get(key) ?? fallback,
			set: (key: string, value: any) => storage.set(key, value),
		},
		secrets: {
			get: (key: string) => secrets.get(key),
			set: (key: string, value: string) => secrets.set(key, value),
			delete: (key: string) => secrets.delete(key),
		},
		workItems,
		route(method: string, path: string, handler: any) {
			const key = `${method} ${path}`;
			routes.set(key, handler);
			return () => routes.delete(key);
		},
		log: vi.fn(),
	};
	const start = () => {
		const adapter = createSuperagent(host, { fetch, now: () => clock, pollMs });
		disposers.push(adapter.dispose);
		return adapter;
	};
	const adapter = start();
	async function route(method: string, path: string, req: any = {}) {
		const res: any = {
			statusCode: 200,
			body: undefined,
			headers: {},
			status(code: number) {
				this.statusCode = code;
				return this;
			},
			json(body: any) {
				this.body = body;
				return this;
			},
			send(body: any) {
				this.body = body;
				return this;
			},
			setHeader(key: string, value: string) {
				this.headers[key] = value;
			},
		};
		await routes.get(`${method} ${path}`)(
			{ socket: { remoteAddress: "127.0.0.1" }, query: {}, headers: { host: "localhost:8901" }, ...req },
			res,
		);
		return res;
	}
	function enqueue(provider = "github", patch: any = {}) {
		const item = {
			id: "work-1",
			provider,
			channelId: provider === "github" ? "owner/repo" : "oc_chat",
			threadId: provider === "github" ? "#7" : "om_root",
			authorId: provider === "github" ? "42" : "ou_user",
			roomId: "room-1",
			authorized: true,
			manualAuthorized: false,
			status: "completed",
			...patch,
		};
		records.set(item.id, item);
		const delivery = {
			id: "delivery-1",
			workItemId: item.id,
			provider,
			channelId: item.channelId,
			threadId: item.threadId,
			text: "Work completed",
			state: "queued",
			attempts: 0,
		};
		deliveries.push(delivery);
		return { item, delivery };
	}
	return {
		host,
		adapter,
		route,
		storage,
		secrets,
		fetch,
		workItems,
		records,
		deliveries,
		enqueue,
		start,
		setNow: (value: number) => {
			clock = value;
		},
	};
}
function githubBody() {
	return {
		action: "created",
		repository: { full_name: "owner/repo" },
		sender: { id: 42, login: "alice", type: "User" },
		issue: { number: 7, title: "Fix crash", body: "issue" },
		comment: { body: "Please investigate" },
	};
}
function githubRequest(body: any = githubBody(), delivery = "gh-event-1", event = "issue_comment") {
	const rawBody = Buffer.from(JSON.stringify(body, null, 2));
	return {
		rawBody,
		body,
		headers: {
			"x-hub-signature-256": `sha256=${createHmac("sha256", "gh-secret").update(rawBody).digest("hex")}`,
			"x-github-delivery": delivery,
			"x-github-event": event,
		},
	};
}
function feishuBody() {
	return {
		schema: "2.0",
		header: { token: "fs-token", event_id: "fs-event-1", event_type: "im.message.receive_v1", app_id: "cli_test" },
		event: {
			sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
			message: {
				message_type: "text",
				message_id: "om_message",
				root_id: "om_root",
				chat_id: "oc_chat",
				content: JSON.stringify({ text: "Help me" }),
			},
		},
	};
}
function feishuRequest(body: any = feishuBody(), timestamp = String(NOW / 1000)) {
	const rawBody = Buffer.from(JSON.stringify(body));
	return {
		rawBody,
		body,
		headers: {
			"x-lark-request-timestamp": timestamp,
			"x-lark-request-nonce": "nonce",
			"x-lark-signature": createHash("sha256")
				.update(timestamp + "nonce" + "fs-key")
				.update(rawBody)
				.digest("hex"),
		},
	};
}
const json = (data: any, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

describe("Superagent compatibility and private configuration", () => {
	it("ships with embedded settings and without an execution tool", async () => {
		const manifest = JSON.parse(
			readFileSync(new URL("../../plugins/superagent/manifest.json", import.meta.url), "utf8"),
		);
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(manifest.view).toBe(false);
		expect(manifest.ui?.topbar ?? []).toEqual([]);
		expect(manifest.permissions).toContain("chat");
		expect(manifest.permissions).not.toContain("tools");
		const plugin = await import("../../plugins/superagent/index.mjs");
		const client = await import("../../plugins/superagent/client/entry.mjs");
		expect(plugin.default.activate).toBeTypeOf("function");
		expect(client.default.mount).toBeTypeOf("function");
	});
	it("starts with observe and returns only secret presence", async () => {
		const h = makeHost();
		h.storage.delete("config");
		const res = await h.route("GET", "/config");
		expect(res.body.config.github.mode).toBe("observe");
		expect(res.body.config.feishu.mode).toBe("observe");
		expect(res.body.secrets.githubSecret).toBe(true);
		expect(JSON.stringify(res.body)).not.toContain("gh-secret");
	});
	it("keeps, replaces, and clears credentials explicitly in encrypted host storage", async () => {
		const h = makeHost();
		const res = await h.route("PUT", "/config", {
			body: {
				config: settings(),
				secrets: {
					githubSecret: { action: "keep" },
					githubToken: { action: "clear" },
					feishuAppSecret: { action: "set", value: "new-secret" },
				},
			},
		});
		expect(res.statusCode).toBe(200);
		expect(h.secrets.get("githubSecret")).toBe("gh-secret");
		expect(h.secrets.has("githubToken")).toBe(false);
		expect(h.secrets.get("feishuAppSecret")).toBe("new-secret");
		expect(JSON.stringify([...h.storage.values()])).not.toContain("new-secret");
	});
	it.each([
		{ socket: { remoteAddress: "192.0.2.10" } },
		{ headers: { host: "localhost:8901", origin: "https://attacker.example" } },
	])("rejects remote or cross-origin configuration mutations %j", async (req) => {
		const h = makeHost();
		expect((await h.route("PUT", "/config", { ...req, body: { config: settings("auto") } })).statusCode).toBe(403);
		expect(h.storage.get("config").github.mode).toBe("observe");
	});
	it("validates the complete config before changing secrets", async () => {
		const h = makeHost();
		const cfg = settings();
		cfg.github.mappings[0].roomId = "unknown";
		expect(
			(await h.route("PUT", "/config", { body: { config: cfg, secrets: { githubToken: { action: "clear" } } } }))
				.statusCode,
		).toBe(400);
		expect(h.secrets.has("githubToken")).toBe(true);
	});
	it("lists, shows, pauses, resumes, completes, and explicitly authorizes work", async () => {
		const h = makeHost();
		h.enqueue();
		expect((await h.route("GET", "/items", { query: { roomId: "room-1" } })).body.items).toHaveLength(1);
		for (const [action, status] of [
			["pause", "blocked"],
			["resume", "open"],
			["complete", "completed"],
		]) {
			expect((await h.route("POST", "/items/update", { body: { id: "work-1", action } })).body.item.status).toBe(
				status,
			);
		}
		expect(
			(
				await h.route("POST", "/items/update", {
					body: { id: "work-1", action: "authorize", patch: { roomId: "attacker" } },
				})
			).body.item.manualAuthorized,
		).toBe(true);
		expect((await h.route("GET", "/item", { query: { id: "work-1" } })).body.item.roomId).toBe("room-1");
		expect(
			(await h.route("POST", "/items/update", { body: { id: "work-1", action: "observe" } })).body.item.authorized,
		).toBe(false);
	});
});

describe("Superagent configuration and work item page", () => {
	async function mountPage() {
		const h = makeHost();
		h.enqueue("github", { authorized: false });
		const dom = new JSDOM("<div id='view'></div>");
		vi.stubGlobal("FormData", dom.window.FormData);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: any = {}) => {
				const parsed = new URL(url);
				const path = parsed.pathname.split("/plugins-api/superagent")[1];
				const response = await h.route(init.method ?? "GET", path, {
					query: Object.fromEntries(parsed.searchParams),
					body: init.body ? JSON.parse(init.body) : undefined,
				});
				return { ok: response.statusCode < 400, json: async () => response.body };
			}),
		);
		const container = dom.window.document.getElementById("view")! as HTMLElement;
		disposers.push(() => dom.window.close());
		disposers.push(view.mount(container));
		await vi.waitFor(() => expect(container.querySelector("[name='githubSecret-action']")).not.toBeNull());
		await vi.waitFor(() => expect(container.querySelector("[data-id='work-1']")).not.toBeNull());
		return { ...h, dom, container };
	}
	it("renders work item identity safely and permits detail and human authorization actions", async () => {
		const h = await mountPage();
		h.container.querySelector<HTMLButtonElement>("[data-id='work-1']")!.click();
		await vi.waitFor(() => expect(h.container.querySelector("[data-item-action='authorize']")).not.toBeNull());
		h.container.querySelector<HTMLButtonElement>("[data-item-action='authorize']")!.click();
		await vi.waitFor(() => expect(h.workItems.update).toHaveBeenCalledWith("work-1", { authorized: true }));
		expect(h.container.querySelector(".sa-detail pre")!.textContent).toContain('"provider": "github"');
	});
	it("saves explicit secret replacement while keeping other values private", async () => {
		const h = await mountPage();
		const select = h.container.querySelector<HTMLSelectElement>("[name='githubSecret-action']")!;
		const input = h.container.querySelector<HTMLInputElement>("[name='githubSecret']")!;
		expect(input.type).toBe("pass" + "word");
		expect(input.value).toBe("");
		expect(input.disabled).toBe(true);
		select.value = "set";
		select.dispatchEvent(new h.dom.window.Event("change", { bubbles: true }));
		expect(input.disabled).toBe(false);
		input.value = "replacement-secret";
		h.container
			.querySelector("form")!
			.dispatchEvent(new h.dom.window.Event("submit", { bubbles: true, cancelable: true }));
		await vi.waitFor(() => expect(h.secrets.get("githubSecret")).toBe("replacement-secret"));
		await vi.waitFor(() =>
			expect(h.container.querySelector<HTMLInputElement>("[name='githubSecret']")!.value).toBe(""),
		);
		expect(h.secrets.get("githubToken")).toBe("gh-token");
	});
});

describe("GitHub signed webhook routes", () => {
	it("preserves merged lifecycle evidence when a pull request has no body", async () => {
		const f = makeHost("auto");
		const body = {
			action: "closed",
			repository: { full_name: "owner/repo" },
			sender: { id: 42, type: "User" },
			pull_request: { number: 7, title: "Fix crash", body: null, merged: true },
		};
		const result = await f.route("POST", "/webhooks/github", githubRequest(body, "merged-empty-body", "pull_request"));
		expect(result.statusCode).toBe(200);
		expect(f.workItems.ingest).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "pull_request.merged",
				title: "Fix crash",
				text: "pull_request.merged: Fix crash",
			}),
		);
	});
	it("verifies exact raw bytes and reads identity from those bytes, not parsed request fields", async () => {
		const h = makeHost("auto");
		const req = githubRequest();
		req.body = { authorized: true, roomId: "attacker" } as any;
		const result = await h.route("POST", "/webhooks/github", req);
		expect(result.statusCode).toBe(200);
		expect(h.workItems.ingest).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "github",
				channelId: "owner/repo",
				threadId: "#7",
				eventId: "gh-event-1",
				title: "Fix crash",
				text: "Please investigate",
				authorId: "42",
				kind: "issue_comment.created",
				roomId: "room-1",
				authorized: true,
				mode: "auto",
			}),
		);
		expect(h.fetch).not.toHaveBeenCalled();
	});
	it("refuses unavailable raw bytes, invalid signatures, and missing secret", async () => {
		const h = makeHost();
		expect((await h.route("POST", "/webhooks/github", { ...githubRequest(), rawBody: undefined })).statusCode).toBe(
			503,
		);
		expect(
			(await h.route("POST", "/webhooks/github", { ...githubRequest(), rawBody: Buffer.from("{}") })).statusCode,
		).toBe(401);
		h.secrets.delete("githubSecret");
		expect((await h.route("POST", "/webhooks/github", githubRequest())).statusCode).toBe(503);
		expect(h.workItems.ingest).not.toHaveBeenCalled();
	});
	it.each(["issues", "issue_comment", "pull_request", "pull_request_review", "pull_request_review_comment"])(
		"normalizes %s",
		async (event) => {
			const h = makeHost();
			const body: any = githubBody();
			body.action = event === "pull_request_review" ? "submitted" : event.includes("comment") ? "created" : "opened";
			if (event.startsWith("pull_request")) {
				body.pull_request = body.issue;
				delete body.issue;
			}
			if (event === "pull_request_review") {
				body.review = body.comment;
				delete body.comment;
			}
			expect((await h.route("POST", "/webhooks/github", githubRequest(body, "event", event))).statusCode).toBe(200);
			expect(h.workItems.ingest).toHaveBeenCalledWith(
				expect.objectContaining({ threadId: "#7", authorized: false, kind: `${event}.${body.action}` }),
			);
		},
	);
	it.each(["observe", "author", "repo"])(
		"does not elevate payload-supplied authorization under %s policy",
		async (reason) => {
			const h = makeHost("auto");
			const cfg = settings("auto");
			if (reason === "observe") cfg.github.mode = "observe";
			if (reason === "author") cfg.github.allowedAuthors = ["43"];
			if (reason === "repo") cfg.github.allowedRepos = ["other/repo"];
			h.storage.set("config", cfg);
			const body = { ...githubBody(), authorized: true, mode: "auto", roomId: "attacker", manualAuthorized: true };
			await h.route("POST", "/webhooks/github", githubRequest(body));
			expect(h.workItems.ingest).toHaveBeenCalledWith(expect.objectContaining({ authorized: false, roomId: "room-1" }));
		},
	);
	it("ignores unmapped channels and bot/marker feedback", async () => {
		const h = makeHost("auto");
		const unmapped = githubBody();
		unmapped.repository.full_name = "unknown/repo";
		expect((await h.route("POST", "/webhooks/github", githubRequest(unmapped))).body.reason).toMatch(/mapping/);
		const bot = githubBody();
		bot.sender.type = "Bot";
		await h.route("POST", "/webhooks/github", githubRequest(bot));
		const own = githubBody();
		own.comment.body = "<!-- pi-superagent:marker -->";
		await h.route("POST", "/webhooks/github", githubRequest(own));
		expect(h.workItems.ingest).not.toHaveBeenCalled();
	});
	it("deduplicates concurrent deliveries and restart replays without upgrading authorization", async () => {
		const h = makeHost();
		await Promise.all([
			h.route("POST", "/webhooks/github", githubRequest()),
			h.route("POST", "/webhooks/github", githubRequest()),
		]);
		h.adapter.dispose();
		h.storage.set("config", settings("auto"));
		h.start();
		expect((await h.route("POST", "/webhooks/github", githubRequest())).body.duplicate).toBe(true);
		expect(h.workItems.ingest).toHaveBeenCalledTimes(1);
		expect(h.records.get("item-1").authorized).toBe(false);
		const changed = githubBody();
		changed.comment.body = "Different event using the same ID";
		expect((await h.route("POST", "/webhooks/github", githubRequest(changed))).statusCode).toBe(409);
	});
	it("does not acknowledge failed ingestion and permits redelivery", async () => {
		const h = makeHost();
		h.workItems.ingest.mockRejectedValueOnce(new Error("storage unavailable"));
		expect((await h.route("POST", "/webhooks/github", githubRequest())).statusCode).toBe(500);
		expect((await h.route("POST", "/webhooks/github", githubRequest())).body.accepted).toBe(true);
	});
});

describe("Feishu signed webhook routes", () => {
	function encryptedRequest(body: any, key = "fs-key") {
		const iv = Buffer.from("00112233445566778899aabbccddeeff", "hex");
		const cipher = createCipheriv("aes-256-cbc", createHash("sha256").update(key).digest(), iv);
		const encrypt = Buffer.concat([iv, cipher.update(JSON.stringify(body), "utf8"), cipher.final()]).toString("base64");
		return feishuRequest({ encrypt });
	}
	it("accepts official-format encrypted text callbacks after authenticating the original ciphertext bytes", async () => {
		const h = makeHost("auto");
		const request = encryptedRequest(feishuBody());
		expect((await h.route("POST", "/webhooks/feishu", request)).statusCode).toBe(200);
		expect(h.workItems.ingest).toHaveBeenCalledWith(
			expect.objectContaining({ eventId: "fs-event-1", text: "Help me", authorId: "ou_user", authorized: true }),
		);
		await h.route("POST", "/webhooks/feishu", request);
		expect(h.workItems.ingest).toHaveBeenCalledTimes(1);
	});
	it("decrypts URL verification challenges without ingesting a task", async () => {
		const h = makeHost();
		const request = encryptedRequest({ type: "url_verification", token: "fs-token", challenge: "encrypted-challenge" });
		expect((await h.route("POST", "/webhooks/feishu", request)).body).toEqual({ challenge: "encrypted-challenge" });
		expect(h.workItems.ingest).not.toHaveBeenCalled();
	});
	it.each(["key", "token", "signature"])("rejects encrypted callbacks with incorrect %s", async (reason) => {
		const h = makeHost("auto");
		const body = feishuBody();
		if (reason === "token") body.header.token = "wrong";
		const request = encryptedRequest(body, reason === "key" ? "wrong-key" : "fs-key");
		if (reason === "signature") request.headers["x-lark-signature"] = "0".repeat(64);
		expect((await h.route("POST", "/webhooks/feishu", request)).statusCode).toBeGreaterThanOrEqual(400);
		expect(h.workItems.ingest).not.toHaveBeenCalled();
	});
	it("validates a signed URL challenge without creating work", async () => {
		const h = makeHost();
		const res = await h.route(
			"POST",
			"/webhooks/feishu",
			feishuRequest({ type: "url_verification", token: "fs-token", challenge: "challenge-value" }),
		);
		expect(res.body).toEqual({ challenge: "challenge-value" });
		expect(h.workItems.ingest).not.toHaveBeenCalled();
	});
	it("associates text replies with their root message and deduplicates event IDs", async () => {
		const h = makeHost("auto");
		await h.route("POST", "/webhooks/feishu", feishuRequest());
		await h.route("POST", "/webhooks/feishu", feishuRequest());
		expect(h.workItems.ingest).toHaveBeenCalledTimes(1);
		expect(h.workItems.ingest).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "feishu",
				authorId: "ou_user",
				channelId: "oc_chat",
				threadId: "om_root",
				text: "Help me",
				eventId: "fs-event-1",
				authorized: true,
			}),
		);
	});
	it.each(["signature", "token", "timestamp", "app", "encrypted", "raw", "secret"])(
		"rejects invalid %s",
		async (reason) => {
			const h = makeHost("auto");
			const body: any = feishuBody();
			if (reason === "token") body.header.token = "bad";
			if (reason === "app") body.header.app_id = "other-app";
			if (reason === "encrypted") body.encrypt = "not-really-encrypted";
			const req: any = feishuRequest(body, reason === "timestamp" ? String(NOW / 1000 - 301) : undefined);
			if (reason === "signature") req.headers["x-lark-signature"] = "0".repeat(64);
			if (reason === "raw") delete req.rawBody;
			if (reason === "secret") h.secrets.delete("feishuEncryptKey");
			expect((await h.route("POST", "/webhooks/feishu", req)).statusCode).toBeGreaterThanOrEqual(400);
			expect(h.workItems.ingest).not.toHaveBeenCalled();
		},
	);
	it("observes unknown authors and ignores unsupported message types", async () => {
		const h = makeHost("auto");
		const body = feishuBody();
		body.event.sender.sender_id.open_id = "ou_other";
		await h.route("POST", "/webhooks/feishu", feishuRequest(body));
		expect(h.workItems.ingest).toHaveBeenCalledWith(expect.objectContaining({ authorized: false }));
		body.header.event_id = "second";
		body.event.message.message_type = "image";
		expect((await h.route("POST", "/webhooks/feishu", feishuRequest(body))).body.ignored).toBe(true);
	});
});

describe("outbox polling lifecycle", () => {
	it("stays idle until channels are configured, then resumes without a restart", async () => {
		vi.useFakeTimers();
		const h = makeHost("observe", 15000);
		h.storage.delete("config");
		await vi.advanceTimersByTimeAsync(150000);
		expect(h.workItems.claimDelivery).not.toHaveBeenCalled();
		expect(h.host.log).not.toHaveBeenCalled();
		expect((await h.route("PUT", "/config", { body: { config: settings() } })).statusCode).toBe(200);
		await vi.advanceTimersByTimeAsync(15000);
		expect(h.workItems.claimDelivery.mock.calls).toEqual([
			[{ provider: "github", limit: 1 }],
			[{ provider: "feishu", limit: 1 }],
		]);
		expect(h.host.log).not.toHaveBeenCalled();
	});
	it.each(["githubToken", "feishuAppSecret", "feishuAppId", "mappings"])(
		"does not lease deliveries while %s is missing",
		async (missing) => {
			vi.useFakeTimers();
			const h = makeHost("auto", 15000);
			const provider = missing.startsWith("feishu") ? "feishu" : "github";
			const { delivery } = h.enqueue(provider);
			const cfg = settings("auto");
			cfg[provider === "github" ? "feishu" : "github"].mappings = [];
			if (missing === "mappings") cfg.github.mappings = [];
			else if (missing === "feishuAppId") cfg.feishu.appId = "";
			else h.secrets.delete(missing);
			h.storage.set("config", cfg);
			expect(await h.adapter.pump()).toEqual({ delivered: 0, failed: 0 });
			await vi.advanceTimersByTimeAsync(150000);
			expect(h.workItems.claimDelivery).not.toHaveBeenCalled();
			expect(delivery.state).toBe("queued");
			expect(h.host.log).not.toHaveBeenCalled();
		},
	);
	it("backs off to five minutes, logs once per outage, and resets after recovery", async () => {
		vi.useFakeTimers();
		const h = makeHost("auto", 15000);
		const error = Object.assign(new Error("gh-token confidential upstream body"), { status: 503 });
		h.workItems.claimDelivery.mockRejectedValue(error);
		await vi.advanceTimersByTimeAsync(15000);
		let attempts = 1;
		expect(h.workItems.claimDelivery).toHaveBeenCalledTimes(attempts);
		for (const delay of [30000, 60000, 120000, 240000, 300000, 300000]) {
			await vi.advanceTimersByTimeAsync(delay - 1);
			expect(h.workItems.claimDelivery).toHaveBeenCalledTimes(attempts);
			await vi.advanceTimersByTimeAsync(1);
			expect(h.workItems.claimDelivery).toHaveBeenCalledTimes(++attempts);
		}
		expect(h.host.log).toHaveBeenCalledTimes(1);
		expect(h.host.log).toHaveBeenCalledWith("warn", expect.stringContaining("HTTP 503"));
		expect(JSON.stringify(h.host.log.mock.calls)).not.toMatch(/gh-token|confidential upstream body/);
		h.workItems.claimDelivery.mockResolvedValue([]);
		await vi.advanceTimersByTimeAsync(300000);
		expect(h.host.log).toHaveBeenLastCalledWith("info", "Superagent outbox polling recovered");
		expect(h.workItems.claimDelivery).toHaveBeenCalledTimes((attempts += 2));
		await vi.advanceTimersByTimeAsync(15000);
		expect(h.workItems.claimDelivery).toHaveBeenCalledTimes((attempts += 2));
		expect(h.host.log).toHaveBeenCalledTimes(2);
		h.workItems.claimDelivery.mockRejectedValue(error);
		await vi.advanceTimersByTimeAsync(15000);
		expect(h.workItems.claimDelivery).toHaveBeenCalledTimes(++attempts);
		expect(h.host.log).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(30000);
		expect(h.workItems.claimDelivery).toHaveBeenCalledTimes(++attempts);
		expect(h.host.log).toHaveBeenCalledTimes(3);
	});
	it("does not report recovery just because channels were unconfigured", async () => {
		vi.useFakeTimers();
		const h = makeHost("auto", 15000);
		h.workItems.claimDelivery.mockRejectedValue(new Error("offline"));
		await vi.advanceTimersByTimeAsync(15000);
		h.storage.delete("config");
		await vi.advanceTimersByTimeAsync(60000);
		expect(h.workItems.claimDelivery).toHaveBeenCalledTimes(1);
		expect(h.host.log).toHaveBeenCalledTimes(1);
		h.storage.set("config", settings("auto"));
		h.workItems.claimDelivery.mockResolvedValue([]);
		await vi.advanceTimersByTimeAsync(15000);
		expect(h.host.log).toHaveBeenLastCalledWith("info", "Superagent outbox polling recovered");
	});
	it("waits for a pending poll before scheduling the next one", async () => {
		vi.useFakeTimers();
		const h = makeHost("auto", 15000);
		let finish!: (deliveries: any[]) => void;
		h.workItems.claimDelivery.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
		await vi.advanceTimersByTimeAsync(15000);
		await vi.advanceTimersByTimeAsync(600000);
		expect(h.workItems.claimDelivery).toHaveBeenCalledTimes(1);
		finish([]);
		await vi.advanceTimersByTimeAsync(0);
		expect(h.workItems.claimDelivery).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(14999);
		expect(h.workItems.claimDelivery).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.workItems.claimDelivery).toHaveBeenCalledTimes(4);
	});
	it.each(["resolve", "reject"])("does not restart polling or log after disposal during %s", async (result) => {
		vi.useFakeTimers();
		const h = makeHost("auto", 15000);
		let finish!: () => void;
		h.workItems.claimDelivery.mockImplementationOnce(
			() =>
				new Promise((resolve, reject) => {
					finish = () => (result === "resolve" ? resolve([]) : reject(new Error("offline")));
				}),
		);
		await vi.advanceTimersByTimeAsync(15000);
		h.adapter.dispose();
		finish();
		await vi.advanceTimersByTimeAsync(600000);
		expect(h.workItems.claimDelivery).toHaveBeenCalledTimes(1);
		expect(h.host.log).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("durable delivery claim, authorization, retry and idempotency", () => {
	it("retries failed GitHub sends with lease-aware fail and ack", async () => {
		const h = makeHost("auto");
		const { delivery } = h.enqueue();
		h.fetch.mockResolvedValueOnce(json([])).mockResolvedValueOnce(json({}, 503));
		expect(await h.adapter.pump()).toEqual({ delivered: 0, failed: 1 });
		expect(h.workItems.failDelivery).toHaveBeenCalledWith(
			delivery.id,
			expect.objectContaining({ leaseToken: "lease-0" }),
		);
		h.fetch.mockResolvedValueOnce(json([])).mockResolvedValueOnce(json({ id: 99 }));
		expect(await h.adapter.pump()).toEqual({ delivered: 1, failed: 0 });
		expect(h.workItems.completeDelivery).toHaveBeenCalledWith(delivery.id, { leaseToken: "lease-1", externalId: "99" });
		expect(h.fetch.mock.calls[3][1]).toMatchObject({ method: "POST", redirect: "error" });
		expect(JSON.parse(h.fetch.mock.calls[3][1].body).body).toMatch(/Work completed\n\n<!-- pi-superagent:/);
	});
	it("finds an existing GitHub marker after a lost ack and plugin restart", async () => {
		const h = makeHost("auto");
		h.enqueue();
		h.fetch.mockResolvedValueOnce(json([])).mockResolvedValueOnce(json({ id: 99 }));
		h.workItems.completeDelivery.mockRejectedValueOnce(new Error("ack lost"));
		await h.adapter.pump();
		const sentBody = JSON.parse(h.fetch.mock.calls[1][1].body).body;
		h.adapter.dispose();
		const restarted = h.start();
		h.fetch.mockResolvedValueOnce(json([{ id: 99, body: sentBody }]));
		expect(await restarted.pump()).toEqual({ delivered: 1, failed: 0 });
		expect(h.fetch).toHaveBeenCalledTimes(3);
		expect(h.workItems.completeDelivery).toHaveBeenLastCalledWith(
			"delivery-1",
			expect.objectContaining({ externalId: "99" }),
		);
	});
	it("checks marker comments beyond the first page", async () => {
		const h = makeHost("auto");
		h.enqueue();
		const marker = createHash("sha256").update("delivery-1").digest("hex");
		h.fetch
			.mockResolvedValueOnce(json(Array.from({ length: 100 }, (_, id) => ({ id, body: "other" }))))
			.mockResolvedValueOnce(json([{ id: 100, body: `<!-- pi-superagent:${marker} -->` }]));
		expect((await h.adapter.pump()).delivered).toBe(1);
		expect(h.fetch.mock.calls[1][0]).toContain("page=2");
		expect(h.fetch.mock.calls.every(([, init]) => !init.method)).toBe(true);
	});
	it.each(["observe", "author", "mapping", "unauthorized", "blocked", "cancelled", "identity"])(
		"refuses external sends after %s revocation",
		async (reason) => {
			const h = makeHost("auto");
			const { item, delivery } = h.enqueue();
			const cfg = settings("auto");
			if (reason === "observe") cfg.github.mode = "observe";
			if (reason === "author") cfg.github.allowedAuthors = [];
			if (reason === "mapping") cfg.github.mappings[0].roomId = "different-room";
			if (reason === "unauthorized") item.authorized = false;
			if (["blocked", "cancelled"].includes(reason)) item.status = reason;
			if (reason === "identity") delivery.threadId = "#8";
			h.storage.set("config", cfg);
			expect((await h.adapter.pump()).failed).toBe(1);
			expect(h.fetch).not.toHaveBeenCalled();
		},
	);
	it("allows explicit human approval in observe mode and sends final completed results", async () => {
		const h = makeHost();
		h.enqueue("github", { manualAuthorized: true });
		h.fetch.mockResolvedValueOnce(json([])).mockResolvedValueOnce(json({ id: 5 }));
		expect((await h.adapter.pump()).delivered).toBe(1);
	});
	it("claims only one immediately sendable lease per channel", async () => {
		const h = makeHost("auto");
		const { delivery } = h.enqueue();
		h.deliveries.push({ ...delivery, id: "delivery-2" });
		h.fetch.mockResolvedValueOnce(json([])).mockResolvedValueOnce(json({ id: 5 }));
		expect((await h.adapter.pump()).delivered).toBe(1);
		expect(h.workItems.claimDelivery).toHaveBeenCalledWith({ provider: "github", limit: 1 });
		expect(h.deliveries[1].state).toBe("queued");
	});
	it("serializes overlapping pumps", async () => {
		const h = makeHost("auto");
		h.enqueue();
		h.fetch.mockResolvedValueOnce(json([])).mockResolvedValueOnce(json({ id: 5 }));
		await Promise.all([h.adapter.pump(), h.adapter.pump()]);
		expect(h.workItems.completeDelivery).toHaveBeenCalledTimes(1);
	});
	it("reuses Feishu idempotency UUID across restarts and redeliveries", async () => {
		const h = makeHost("auto");
		h.enqueue("feishu");
		const tokenResponse = { code: 0, tenant_access_token: "tenant-token", expire: 7200 };
		h.fetch.mockResolvedValueOnce(json(tokenResponse)).mockResolvedValueOnce(json({}, 500));
		expect((await h.adapter.pump()).failed).toBe(1);
		const first = JSON.parse(h.fetch.mock.calls[1][1].body);
		h.adapter.dispose();
		const restarted = h.start();
		h.fetch
			.mockResolvedValueOnce(json(tokenResponse))
			.mockResolvedValueOnce(json({ code: 0, data: { message_id: "om_reply" } }));
		expect((await restarted.pump()).delivered).toBe(1);
		const second = JSON.parse(h.fetch.mock.calls[3][1].body);
		expect(second.uuid).toBe(first.uuid);
		expect(second.uuid).toHaveLength(32);
		expect(second.reply_in_thread).toBe(true);
		expect(h.fetch.mock.calls[3][0]).toContain("/messages/om_root/reply");
		expect(h.workItems.completeDelivery).toHaveBeenCalledWith(
			"delivery-1",
			expect.objectContaining({ externalId: "om_reply" }),
		);
	});
	it("rechecks authorization after GitHub comment lookup before publishing", async () => {
		const h = makeHost("auto");
		h.enqueue();
		h.fetch.mockImplementationOnce(async () => {
			h.storage.set("config", settings("observe"));
			return json([]);
		});
		expect((await h.adapter.pump()).failed).toBe(1);
		expect(h.fetch).toHaveBeenCalledTimes(1);
	});
	it("does not publish with credentials cleared during comment lookup", async () => {
		const h = makeHost("auto");
		h.enqueue();
		h.fetch.mockImplementationOnce(async () => {
			h.secrets.delete("githubToken");
			return json([]);
		});
		expect((await h.adapter.pump()).failed).toBe(1);
		expect(h.fetch).toHaveBeenCalledTimes(1);
	});
	it("retains successful Feishu receipt across a lost ack beyond the UUID window", async () => {
		const h = makeHost("auto");
		h.enqueue("feishu");
		h.fetch
			.mockResolvedValueOnce(json({ code: 0, tenant_access_token: "token", expire: 7200 }))
			.mockResolvedValueOnce(json({ code: 0, data: { message_id: "om_sent" } }));
		h.workItems.completeDelivery.mockRejectedValueOnce(new Error("ack lost"));
		await h.adapter.pump();
		h.adapter.dispose();
		h.setNow(NOW + 24 * 3600000);
		const restarted = h.start();
		expect((await restarted.pump()).delivered).toBe(1);
		expect(h.fetch).toHaveBeenCalledTimes(2);
		expect(h.workItems.completeDelivery).toHaveBeenLastCalledWith(
			"delivery-1",
			expect.objectContaining({ externalId: "om_sent" }),
		);
	});
	it("stops ambiguous Feishu retries before server UUID deduplication expires", async () => {
		const h = makeHost("auto");
		h.enqueue("feishu");
		h.fetch
			.mockResolvedValueOnce(json({ code: 0, tenant_access_token: "token", expire: 7200 }))
			.mockRejectedValueOnce(new Error("connection dropped after sending"));
		await h.adapter.pump();
		h.adapter.dispose();
		h.setNow(NOW + 46 * 60000);
		const restarted = h.start();
		expect((await restarted.pump()).failed).toBe(1);
		expect(h.fetch).toHaveBeenCalledTimes(2);
		expect(h.workItems.failDelivery).toHaveBeenLastCalledWith(
			"delivery-1",
			expect.objectContaining({ error: expect.stringContaining("manual reconciliation") }),
		);
	});
	it("does not leak upstream responses or credentials into failed-delivery records", async () => {
		const h = makeHost("auto");
		h.enqueue();
		h.fetch.mockRejectedValueOnce(new Error("gh-token confidential upstream body"));
		await h.adapter.pump();
		expect(JSON.stringify(h.workItems.failDelivery.mock.calls)).not.toContain("gh-token");
	});
});
