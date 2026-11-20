import type { Express, Request, Response } from "express";
import { scrubHubMessage, type LocalDeviceConfig } from "./local.js";

type SharedCtx = {
	getPaired: () => LocalDeviceConfig | undefined;
	ensureReady: () => Promise<void>;
	isClosed: () => boolean;
};

const CREATE_FIELDS = ["name", "botIds", "primaryBotId"];
const RENAME_FIELDS = ["name"];
const MEMBERS_FIELDS = ["botIds", "primaryBotId"];
const EMPTY_FIELDS: string[] = [];

function pairedOr409(ctx: SharedCtx): LocalDeviceConfig {
	const paired = ctx.getPaired();
	if (!paired) throw Object.assign(new Error("Pair this computer first"), { status: 409, code: "NOT_PAIRED" });
	if (!paired.uiCredential)
		throw Object.assign(new Error("Pair this computer again"), { status: 409, code: "REPAIR_REQUIRED" });
	return paired;
}

function checkBody(body: unknown, fields: string[]): { ok: boolean; error?: string } {
	if (fields.length === 0) {
		if (body !== undefined && body !== null && (typeof body !== "object" || Object.keys(body).length > 0))
			return { ok: false, error: "Invalid group request" };
		if (body && typeof body === "object" && Object.keys(body).length > 0)
			return { ok: false, error: "Invalid group request" };
		return { ok: true };
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Invalid group request" };
	const keys = Object.keys(body);
	if (keys.some((k) => !fields.includes(k))) return { ok: false, error: "Invalid group request" };
	try {
		if (Buffer.byteLength(JSON.stringify(body)) > 32 * 1024) return { ok: false, error: "Invalid group request" };
	} catch {
		return { ok: false, error: "Invalid group request" };
	}
	return { ok: true };
}

function tagScope(data: unknown): unknown {
	if (!data || typeof data !== "object") return data;
	const record = data as Record<string, unknown>;
	if (Array.isArray(record.rooms)) {
		return { ...record, rooms: record.rooms.map((r) => (r && typeof r === "object" ? { ...r, scope: "shared" } : r)) };
	}
	if (record.room && typeof record.room === "object") {
		return { ...record, room: { ...(record.room as object), scope: "shared" } };
	}
	return data;
}

async function proxyShared(
	ctx: SharedCtx,
	req: Request,
	res: Response,
	suffix: string,
	method: string,
	body: unknown,
	maxResponseBytes = 2 * 1024 * 1024,
) {
	try {
		await ctx.ensureReady();
	} catch {
		res.status(503).json({ code: "SHARED_UNAVAILABLE", error: "Shared collaboration could not start" });
		return;
	}
	if (ctx.isClosed()) {
		res.status(503).json({ code: "CLOSED", error: "Device center is shutting down" });
		return;
	}
	let paired: LocalDeviceConfig;
	try {
		paired = pairedOr409(ctx);
	} catch (err) {
		const status = (err as { status?: number }).status ?? 409;
		const code = (err as { code?: string }).code ?? "NOT_PAIRED";
		res.status(status).json({ code, error: (err as Error).message });
		return;
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	const cleanup = () => {
		clearTimeout(timeout);
		controller.abort();
	};
	req.once("aborted", cleanup);
	res.once("close", cleanup);
	try {
		const queryIndex = req.url.indexOf("?");
		const queryStr = queryIndex >= 0 ? req.url.slice(queryIndex) : "";
		const response = await fetch(`${paired.hubUrl}/api/device-user/${suffix}${queryStr}`, {
			method,
			redirect: "error",
			signal: controller.signal,
			headers: {
				"Content-Type": "application/json",
				"X-Device-Id": paired.deviceId,
				Authorization: `Bearer ${paired.uiCredential}`,
			},
			...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
		});
		if (!response.body) throw new Error("Empty Hub response");
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				bytes += chunk.value.byteLength;
				if (bytes > maxResponseBytes) throw new Error("Response exceeds limit");
				chunks.push(chunk.value);
			}
		} finally {
			await reader.cancel();
		}
		if (!response.ok) {
			let failure: { code?: unknown; error?: unknown } | null = null;
			try {
				const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				if (parsed && typeof parsed === "object") failure = parsed;
			} catch {
				failure = null;
			}
			const hubCode =
				typeof failure?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(failure.code) ? failure.code : undefined;
			const hubMessage =
				typeof failure?.error === "string" && failure.error.trim()
					? scrubHubMessage(failure.error, [paired.uiCredential, paired.credential]) || undefined
					: undefined;
			if (response.status === 409 && (hubCode === "ACTIVE_TASKS" || hubMessage === "ACTIVE_TASKS"))
				return res.status(409).json({
					code: "ACTIVE_TASKS",
					error: "Stop active tasks before removing members, clearing messages or deleting this group",
				});
			const status = [400, 401, 403, 404, 409, 429].includes(response.status) ? response.status : 502;
			return res.status(status === 401 ? 409 : status).json({
				code: status === 401 ? "REPAIR_REQUIRED" : status === 403 ? "HUB_FORBIDDEN" : "HUB_REJECTED",
				error: status === 401 ? "Pair this computer again" : (hubMessage ?? "Hub rejected group request"),
				hubStatus: response.status,
				...(hubCode ? { hubCode } : {}),
			});
		}
		const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		res.json(tagScope(data));
	} catch (err) {
		if (!res.headersSent && !res.destroyed) {
			const status = (err as { status?: number }).status;
			if (typeof status === "number" && [400, 403, 404, 409, 429].includes(status)) {
				res
					.status(status)
					.json({ code: (err as { code?: string }).code ?? "HUB_REJECTED", error: (err as Error).message });
			} else {
				res.status(502).json({ code: "SHARED_UNREACHABLE", error: "Paired Hub is unreachable" });
			}
		}
	} finally {
		clearTimeout(timeout);
		req.off("aborted", cleanup);
		res.off("close", cleanup);
	}
}

/**
 * 显式共享群组接口：成员含其他设备时走配对远端 Hub，全本机继续走既有本地 `rooms`。
 * 新增而不改旧链路，`local-first` 系列守卫不受影响。
 */
export function installSharedRoomRoutes(app: Express, ctx: SharedCtx) {
	app.get("/api/device-center/shared-bots", (req, res) => void proxyShared(ctx, req, res, "bots", "GET", undefined));
	app.get("/api/device-center/shared-rooms", (req, res) => void proxyShared(ctx, req, res, "rooms", "GET", undefined));
	app.post("/api/device-center/shared-rooms", (req, res) => {
		const check = checkBody(req.body, CREATE_FIELDS);
		if (!check.ok) return res.status(400).json({ code: "INVALID_BODY", error: check.error });
		void proxyShared(ctx, req, res, "rooms", "POST", req.body);
	});
	app.get(
		"/api/device-center/shared-rooms/:id",
		(req, res) =>
			void proxyShared(ctx, req, res, `rooms/${encodeURIComponent(String(req.params.id))}`, "GET", undefined),
	);
	for (const operation of ["rename", "members", "clear", "delete"] as const) {
		const fields = operation === "rename" ? RENAME_FIELDS : operation === "members" ? MEMBERS_FIELDS : EMPTY_FIELDS;
		app.post(`/api/device-center/shared-rooms/:id/${operation}`, (req, res) => {
			const check = checkBody(req.body, fields);
			if (!check.ok) return res.status(400).json({ code: "INVALID_BODY", error: check.error });
			void proxyShared(
				ctx,
				req,
				res,
				`rooms/${encodeURIComponent(String(req.params.id))}/${operation}`,
				"POST",
				req.body,
			);
		});
	}
	// 共享群聊的消息/任务/事件等子路径：原样透传到远端同名房间接口。
	app.all("/api/device-center/shared-rooms/:id/*splat", (req, res) => {
		const splat = String((req.params as unknown as Record<string, string | string[] | undefined>).splat ?? "");
		if (splat.includes("..") || splat.includes("//"))
			return res.status(400).json({ code: "INVALID_BODY", error: "Invalid path" });
		const suffix = `rooms/${encodeURIComponent(String(req.params.id))}/${splat}`;
		const body = req.method === "GET" ? undefined : (req.body ?? {});
		if (body !== undefined) {
			try {
				if (Buffer.byteLength(JSON.stringify(body)) > 512 * 1024)
					return res.status(400).json({ code: "INVALID_BODY", error: "Request too large" });
			} catch {
				return res.status(400).json({ code: "INVALID_BODY", error: "Invalid group request" });
			}
		}
		void proxyShared(ctx, req, res, suffix, req.method, body);
	});
	// 共享房间事件流（SSE）：透传远端文本流，与本地 rooms/:id/events 语义一致。
	app.get("/api/device-center/shared-rooms/:id/events", async (req, res) => {
		try {
			await ctx.ensureReady();
		} catch {
			res.sendStatus(503);
			return;
		}
		if (ctx.isClosed()) {
			res.sendStatus(503);
			return;
		}
		let paired: LocalDeviceConfig;
		try {
			paired = pairedOr409(ctx);
		} catch {
			res.sendStatus(409);
			return;
		}
		const controller = new AbortController();
		const cancel = () => controller.abort();
		res.once("close", cancel);
		req.once("aborted", cancel);
		try {
			const upstream = await fetch(
				`${paired.hubUrl}/api/device-user/rooms/${encodeURIComponent(String(req.params.id))}/events`,
				{
					redirect: "error",
					signal: controller.signal,
					headers: { "X-Device-Id": paired.deviceId, Authorization: `Bearer ${paired.uiCredential}` },
				},
			);
			if (!upstream.ok || !upstream.body || !upstream.headers.get("content-type")?.startsWith("text/event-stream")) {
				await upstream.body?.cancel();
				res.sendStatus(upstream.status === 404 ? 404 : 502);
				return;
			}
			res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
			res.flushHeaders();
			const reader = upstream.body.getReader();
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					if (controller.signal.aborted || chunk.value.byteLength > 65536 || !res.write(chunk.value)) break;
				}
			} finally {
				await reader.cancel();
			}
		} catch {
			if (!res.headersSent && !res.destroyed) res.sendStatus(502);
		} finally {
			controller.abort();
			res.off("close", cancel);
			req.off("aborted", cancel);
			res.end();
		}
	});
}
