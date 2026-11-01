import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createDeviceHub } from "../../server/device-center/hub.js";
import { createDeviceRelay } from "../../server/device-center/relay.js";
import { createDeviceConnector } from "../../server/device-center/connector.js";
import { createDeviceFileSync } from "../../server/device-center/file-sync.js";
import { installDeviceTransfers } from "../../server/device-center/transfers.js";

describe("device collaboration full wiring", () => {
	it("transfers code, reports completed tasks and interrupts disconnected tasks over the real Hub and relay", async () => {
		const temp = await mkdtemp(join(tmpdir(), "device-e2e-"));
		const sourceRoot = join(temp, "source");
		const targetRoot = join(temp, "target");
		await mkdir(sourceRoot);
		await mkdir(targetRoot);
		// Reserve a loopback ephemeral port before constructing the origin-bound Hub.
		const probe = createServer();
		await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
		const address = probe.address();
		if (!address || typeof address === "string") throw new Error("Missing port");
		await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
		const origin = `http://127.0.0.1:${address.port}`;
		const domain = "devices.localhost";
		const hub = await createDeviceHub({
			dataDir: join(temp, "hub"),
			publicUrl: origin,
			deviceDomain: domain,
			isOnline: (id) => relay.isOnline(id),
			onTask: (id, task) => {
				if (!relay.sendTask(id, task)) throw new Error("Task delivery failed");
			},
		});
		const relay = createDeviceRelay({
			server: hub.server,
			publicUrl: origin,
			deviceDomain: domain,
			authenticateDevice: (id, credential) => hub.store.authenticateDevice(id, credential),
			getAccount: hub.getAccount,
			ownsDevice: (account, id) => hub.store.getDevice(id)?.accountId === account,
			onTaskEvent: (id, event) => hub.acceptTaskEvent(id, event).then(() => {}),
		});
		const source = createDeviceFileSync({
			root: sourceRoot,
			dataDir: join(temp, "source-stage"),
			allowReceive: true,
		});
		const target = createDeviceFileSync({
			root: targetRoot,
			dataDir: join(temp, "target-stage"),
			allowReceive: true,
		});
		let connector: ReturnType<typeof createDeviceConnector> | undefined;
		try {
			hub.setRelay(relay);
			await installDeviceTransfers({ app: hub.app, hub, dataDir: join(temp, "hub"), relay });
			await new Promise<void>((resolve) => hub.server.listen(address.port, "127.0.0.1", resolve));
			let cookie = "";
			async function browser(path: string, body: object) {
				return fetch(origin + path, {
					method: "POST",
					headers: { "Content-Type": "application/json", Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
					body: JSON.stringify(body),
				});
			}
			const registration = await browser("/api/auth/register", {
				username: "transfer-test",
				["pass" + "word"]: "test-device-transfer-passphrase",
			});
			expect(registration.status).toBe(201);
			cookie = registration.headers.get("set-cookie")!.split(";")[0];
			async function pair(deviceId: string) {
				const start = await browser("/api/pair/start", { deviceId, name: deviceId });
				expect(start.status).toBe(200);
				const challenge = await start.json();
				expect((await browser("/api/pair/approve", { code: challenge.code })).status).toBe(200);
				const poll = await browser("/api/pair/poll", { pollToken: challenge.pollToken });
				expect(poll.status).toBe(200);
				return (await poll.json()) as { deviceId: string; credential: string };
			}
			const sourceDevice = await pair("source");
			const targetDevice = await pair("target");
			async function syncBot(device: { deviceId: string; credential: string }, id: string) {
				const response = await fetch(origin + "/api/agent/bots", {
					method: "PUT",
					headers: {
						"Content-Type": "application/json",
						Authorization: "Bearer " + device.credential,
						"X-Device-Id": device.deviceId,
					},
					body: JSON.stringify({ bots: [{ id, name: id, description: "", enabled: true, revision: 1 }] }),
				});
				expect(response.status).toBe(200);
			}
			await syncBot(sourceDevice, "source-bot");
			await syncBot(targetDevice, "target-bot");
			const botsResponse = await fetch(origin + "/api/bots", { headers: { Cookie: cookie } });
			expect(botsResponse.status).toBe(200);
			const botListing = await botsResponse.json();
			expect(botListing.bots.map((bot: { id: string }) => bot.id).sort()).toEqual(["source-bot", "target-bot"]);
			expect(JSON.stringify(botListing)).not.toContain(sourceDevice.credential);
			expect(JSON.stringify(botListing)).not.toContain(targetDevice.credential);
			const sourceCredential = sourceDevice.credential;
			const targetCredential = targetDevice.credential;
			const roomResponse = await browser("/api/rooms", {
				name: "Transfer",
				botIds: ["source-bot", "target-bot"],
			});
			expect(roomResponse.status).toBe(201);
			const roomId = (await roomResponse.json()).room.id;
			const actions: string[] = [];
			const receivedTasks: string[] = [];
			let interruptedSignal: AbortSignal | undefined;
			const report = "Mock executor verified answer.ts and completed the requested review.";
			connector = createDeviceConnector({
				hubUrl: origin,
				deviceId: targetDevice.deviceId,
				credential: targetCredential,
				localOrigin: "http://127.0.0.1:1",
				onTask: async (task, signal) => {
					expect(task).toMatchObject({ botId: "target-bot", deviceId: targetDevice.deviceId, botRevision: 1 });
					receivedTasks.push(task.id);
					if (task.text === "Continue the same review") {
						expect(task).toMatchObject({ resume: true, kind: "message" });
						return "Continued the original conversation.";
					}
					if (task.text === "Review transferred code") {
						expect(await readFile(join(targetRoot, "answer.ts"), "utf8")).toContain("export const answer = 42;");
						return report;
					}
					interruptedSignal = signal;
					await new Promise<void>((_resolve, reject) => {
						if (signal?.aborted) reject(new Error("Cancelled"));
						else signal?.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
					});
					return "Unreachable late report";
				},
				onCommand: async (action, payload, signal) => {
					actions.push(action);
					expect(payload).toMatchObject({ roomId, sourceBotId: "source-bot", targetBotId: "target-bot" });
					const command = payload as {
						bundle?: unknown;
						transferId: string;
						revision: string;
						overwritePaths: string[];
					};
					if (action === "transfer_stage") return target.stage(command.bundle, { signal });
					if (action === "transfer_preview") return target.preview(command.transferId, { signal });
					if (action === "transfer_apply")
						return target.apply({
							id: command.transferId,
							revision: command.revision,
							decisions: Object.fromEntries(command.overwritePaths.map((p) => [p, "overwrite" as const])),
							signal,
						});
					throw new Error("Unsupported command");
				},
			});
			const deadline = Date.now() + 5000;
			while (!connector.isOnline()) {
				if (Date.now() > deadline) throw new Error("Connector did not authenticate");
				await delay(10);
			}
			// Exercise both the Hub's 32 KiB parser bypass and the RPC chunk boundary.
			const code = "// transfer fixture\n".repeat(1800) + "export const answer = 42;\n";
			await writeFile(join(sourceRoot, "answer.ts"), code);
			await writeFile(join(targetRoot, "answer.ts"), "old content\n");
			const bundle = await source.prepare({ paths: ["answer.ts"] });
			async function transfer(body: object, credential = sourceCredential) {
				return fetch(`${origin}/api/agent/transfers`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${credential}`,
						"X-Device-Id": sourceDevice.deviceId,
					},
					body: JSON.stringify({ roomId, sourceBotId: "source-bot", targetBotId: "target-bot", ...body }),
				});
			}
			expect((await transfer({ action: "stage", bundle }, "invalid")).status).toBe(401);
			const stagedResponse = await transfer({ action: "stage", bundle });
			expect(stagedResponse.status).toBe(200);
			const staged = await stagedResponse.json();
			expect(staged.transferId).toEqual(expect.any(String));
			expect(staged.files[0]).toMatchObject({
				path: "answer.ts",
				status: "conflict",
				sha256: bundle.manifest.files[0].sha256,
			});
			expect(JSON.stringify(staged)).not.toContain("base64");
			expect(Buffer.byteLength(JSON.stringify(bundle))).toBeGreaterThan(32 * 1024);
			expect(await readFile(join(targetRoot, "answer.ts"), "utf8")).toBe("old content\n");
			const previewResponse = await transfer({ action: "preview", transferId: staged.transferId });
			expect(previewResponse.status).toBe(200);
			const preview = await previewResponse.json();
			expect(preview.files[0].status).toBe("conflict");
			const appliedResponse = await transfer({
				action: "apply",
				transferId: staged.transferId,
				revision: preview.revision,
				overwritePaths: ["answer.ts"],
			});
			expect(appliedResponse.status).toBe(200);
			expect((await appliedResponse.json()).applied).toEqual(["answer.ts"]);
			expect(await readFile(join(targetRoot, "answer.ts"), "utf8")).toBe(code);
			expect(actions).toEqual(["transfer_stage", "transfer_preview", "transfer_apply"]);
			expect(
				(
					await transfer({
						action: "apply",
						transferId: staged.transferId,
						revision: preview.revision,
						overwritePaths: ["answer.ts"],
					})
				).status,
			).toBe(409);
			expect(actions).toHaveLength(3);
			async function dispatch(text: string, key: string) {
				const response = await browser(`/api/rooms/${roomId}/messages`, {
					text,
					targetBotIds: ["target-bot"],
					idempotencyKey: key,
				});
				expect(response.status).toBe(200);
				const result = await response.json();
				expect(result.message.sender.type).toBe("human");
				expect(result.tasks).toHaveLength(1);
				return result.tasks[0].id as string;
			}
			async function waitForTask(id: string, status: string) {
				const deadline = Date.now() + 5000;
				while (Date.now() < deadline) {
					const response = await fetch(`${origin}/api/rooms/${roomId}`, { headers: { Cookie: cookie } });
					expect(response.status).toBe(200);
					const state = await response.json();
					if (state.tasks.some((task: { id: string; status: string }) => task.id === id && task.status === status))
						return state;
					await delay(10);
				}
				throw new Error(`Task did not reach ${status}`);
			}
			const completedId = await dispatch("Review transferred code", "review-once");
			const completed = await waitForTask(completedId, "completed");
			expect(completed.tasks.find((task: { id: string }) => task.id === completedId)).toMatchObject({
				report,
				botId: "target-bot",
				deviceId: targetDevice.deviceId,
			});
			expect(completed.messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						text: report,
						sender: expect.objectContaining({ type: "bot", id: "target-bot" }),
						taskIds: [completedId],
					}),
				]),
			);
			const original = completed.tasks.find((task: { id: string }) => task.id === completedId);
			expect(original.conversationId).toBeTruthy();
			expect(original.resume).toBe(false);
			const continuedResponse = await browser(
				`/api/rooms/${roomId}/conversations/${original.conversationId}/messages`,
				{
					text: "Continue the same review",
					kind: "message",
					idempotencyKey: "continue-once",
				},
			);
			expect(continuedResponse.status).toBe(200);
			const continued = await continuedResponse.json();
			expect(continued.task).toMatchObject({ conversationId: original.conversationId, resume: true });
			await waitForTask(continued.task.id, "completed");
			const duplicateResponse = await browser(
				`/api/rooms/${roomId}/conversations/${original.conversationId}/messages`,
				{
					text: "Continue the same review",
					kind: "message",
					idempotencyKey: "continue-once",
				},
			);
			expect(duplicateResponse.status).toBe(200);
			expect((await duplicateResponse.json()).task.id).toBe(continued.task.id);
			const interruptedId = await dispatch("Wait until disconnected", "interrupt-once");
			await waitForTask(interruptedId, "running");
			expect(interruptedSignal?.aborted).toBe(false);
			relay.revoke(targetDevice.deviceId);
			connector.close();
			const interrupted = await waitForTask(interruptedId, "interrupted");
			expect(interruptedSignal?.aborted).toBe(true);
			expect(receivedTasks).toEqual([completedId, continued.task.id, interruptedId]);
			expect(interrupted.tasks.find((task: { id: string }) => task.id === interruptedId)).toMatchObject({
				status: "interrupted",
			});
			expect(interrupted.tasks.find((task: { id: string }) => task.id === completedId).status).toBe("completed");
			expect(interrupted.messages).toEqual(
				expect.arrayContaining([expect.objectContaining({ taskIds: [interruptedId] })]),
			);
			expect(JSON.stringify(interrupted.messages)).not.toContain("Unreachable late report");
		} finally {
			connector?.close();
			relay.close();
			await hub.close();
			await source.close();
			await target.close();
			await rm(temp, { recursive: true, force: true });
		}
	}, 15000);
});
