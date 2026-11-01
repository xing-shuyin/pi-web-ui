import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDeviceHub } from "../../server/device-center/hub.js";
import { createDeviceRelay, safePath } from "../../server/device-center/relay.js";
import { createDeviceConnector } from "../../server/device-center/connector.js";
import { createHumanInteractionBridge } from "../../server/device-center/human-interaction.js";
import type { ClientMessage, DeviceTaskInteraction } from "../../server/protocol.js";

describe("native interaction transport", () => {
	it("carries bounded questionnaires and once approvals through authenticated user proxy and current connector", async () => {
		const temp = await mkdtemp(join(tmpdir(), "human-interaction-"));
		const server = createServer();
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("port");
		await new Promise<void>((r) => server.close(() => r()));
		const origin = `http://127.0.0.1:${address.port}`;
		const hub = await createDeviceHub({ dataDir: temp, publicUrl: origin, isOnline: (id) => relay.isOnline(id) });
		const relay = createDeviceRelay({
			server: hub.server,
			publicUrl: origin,
			authenticateDevice: (id, c) => hub.store.authenticateDevice(id, c),
			getAccount: hub.getRelayAccount,
			ownsDevice: (a, id) => hub.store.getDeviceOwner(id) === a,
			onTaskEvent: (id, e) => hub.acceptTaskEvent(id, e).then(() => {}),
			onTaskInteractions: (id, e) => hub.acceptInteractions(id, e),
		});
		hub.setRelay({ ...relay, onTask: relay.sendTask });
		let connector: ReturnType<typeof createDeviceConnector> | undefined;
		let bridge: ReturnType<typeof createHumanInteractionBridge> | undefined;
		const frames: ClientMessage[] = [];
		try {
			await new Promise<void>((r) => hub.server.listen(address.port, "127.0.0.1", r));
			let cookie = "";
			async function request(path: string, body?: object, headers: Record<string, string> = {}) {
				return fetch(origin + path, {
					method: body ? "POST" : "GET",
					headers: {
						Origin: origin,
						...(cookie ? { Cookie: cookie } : {}),
						...(body ? { "Content-Type": "application/json" } : {}),
						...headers,
					},
					...(body ? { body: JSON.stringify(body) } : {}),
				});
			}
			const registration = await request("/api/auth/register", {
				username: "human-test",
				["pass" + "word"]: "a-long-test-passphrase",
			});
			expect(registration.status).toBe(201);
			cookie = registration.headers.get("set-cookie")!.split(";")[0];
			const start = await request("/api/pair/start", { deviceId: "executor", name: "executor" });
			const challenge = await start.json();
			expect((await request("/api/pair/approve", { code: challenge.code })).status).toBe(200);
			const paired = await (await request("/api/pair/poll", { pollToken: challenge.pollToken })).json();
			const agentHeaders = { Authorization: `Bearer ${paired.credential}`, "X-Device-Id": paired.deviceId };
			const sync = await fetch(origin + "/api/agent/bots", {
				method: "PUT",
				headers: { ...agentHeaders, "Content-Type": "application/json" },
				body: JSON.stringify({ bots: [{ id: "bot", name: "Bot", description: "", enabled: true, revision: 1 }] }),
			});
			expect(sync.status).toBe(200);
			const room = await (await request("/api/rooms", { name: "Human", botIds: ["bot"] })).json();
			const roomId = room.room.id;
			connector = createDeviceConnector({
				hubUrl: origin,
				deviceId: paired.deviceId,
				credential: paired.credential,
				localOrigin: "http://127.0.0.1:1",
				onInteractionAnswer: (a) => bridge?.answer(a) ?? false,
				onTask: async (task, signal, callbacks) => {
					bridge = createHumanInteractionBridge(
						{ taskId: task.id, attemptId: task.attemptId, roomId, botId: "bot", deviceId: paired.deviceId },
						{
							conversationId: "native",
							isCurrent: () => !signal?.aborted,
							send: (f) => frames.push(f),
							publish: (items) => callbacks?.onInteractions?.(items),
						},
					);
					bridge.observe({
						type: "question_pending",
						id: "native-question",
						conversationId: "native",
						questions: [{ id: "q", question: "Which?", options: [{ label: "Yes" }] }],
					});
					await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
					return "stopped";
				},
			});
			async function waitFor<T>(read: () => Promise<T>, test: (value: T) => boolean) {
				const end = Date.now() + 5000;
				while (true) {
					const value = await read();
					if (test(value)) return value;
					if (Date.now() > end) throw new Error("timeout");
					await delay(10);
				}
			}
			await waitFor(
				async () => connector!.isOnline(),
				(v) => v,
			);
			const dispatch = await request(`/api/rooms/${roomId}/messages`, {
				text: "ask",
				targetBotIds: ["bot"],
				idempotencyKey: "ask-once",
			});
			expect(dispatch.status).toBe(200);
			const proxyHeaders = { Authorization: `Bearer ${paired.uiCredential}`, "X-Device-Id": paired.deviceId };
			const path = `/api/device-user/rooms/${roomId}/interactions`;
			const pending = await waitFor(
				async () => {
					const res = await request(path, undefined, proxyHeaders);
					expect(res.status).toBe(200);
					return (await res.json()).interactions as DeviceTaskInteraction[];
				},
				(v) => v.length > 0,
			);
			const item = pending[0];
			expect(JSON.stringify(pending)).not.toContain("native-question");
			const answer = {
				taskId: item.taskId,
				attemptId: item.attemptId,
				interactionId: item.id,
				answers: [{ id: "q", selected: ["Yes"] }],
			};
			expect((await request(path, { ...answer, attemptId: "stale" }, proxyHeaders)).status).toBe(409);
			expect((await request(path, { ...answer, scope: "all" }, proxyHeaders)).status).toBe(400);
			expect((await request(path, answer, agentHeaders)).status).toBe(401);
			expect((await request(path, { ...answer, answers: [] }, proxyHeaders)).status).toBe(409);
			expect((await (await request(path, undefined, proxyHeaders)).json()).interactions).toHaveLength(1);
			expect((await request(path, answer, proxyHeaders)).status).toBe(200);
			await waitFor(
				async () => frames.length,
				(v) => v === 1,
			);
			expect(frames[0]).toEqual({ type: "question_answer", id: "native-question", answers: answer.answers });
			expect((await request(path, answer, proxyHeaders)).status).toBe(409);
			bridge!.observe({
				type: "tool_approval_pending",
				id: "native-approval",
				conversationId: "native",
				toolCallId: "tool",
				toolName: "bash",
				params: { command: "echo ok", token: "secret" },
			});
			const approvals = await waitFor(
				async () =>
					(await (await request(path, undefined, proxyHeaders)).json()).interactions as DeviceTaskInteraction[],
				(v) => v.length === 1 && v[0].kind === "approval",
			);
			expect(approvals[0].paramsPreview).not.toContain('"secret"');
			const approval = approvals[0];
			expect(
				(
					await request(
						path,
						{ taskId: approval.taskId, attemptId: approval.attemptId, interactionId: approval.id, decision: "approve" },
						proxyHeaders,
					)
				).status,
			).toBe(200);
			await waitFor(
				async () => frames.length,
				(v) => v === 2,
			);
			expect(frames[1]).toEqual({
				type: "tool_approval_response",
				id: "native-approval",
				decision: "approve",
				scope: "once",
			});
			expect(safePath(`/api/device-center/rooms/${roomId}/interactions`, "GET")).toBe(true);
			expect(safePath(`/api/device-center/rooms/${roomId}/interactions`, "POST")).toBe(true);
		} finally {
			connector?.close();
			relay.close();
			await hub.close();
			await rm(temp, { recursive: true, force: true });
		}
	}, 15000);
});
