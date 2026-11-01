import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeviceRuntime } from "../../server/device-center/runtime.js";
import { createLocalBotRegistry } from "../../server/device-center/bots.js";
import { createDeviceFileSync } from "../../server/device-center/file-sync.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllGlobals();
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "device-runtime-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const roots = [join(dir, "one"), join(dir, "two")];
	await Promise.all(roots.map((root) => mkdir(root)));
	const dataDir = join(dir, "data");
	const bots = await createLocalBotRegistry(dataDir);
	const registered = await Promise.all(
		roots.map((cwd, i) =>
			bots.upsert({
				name: `Bot ${i}`,
				description: "",
				systemPrompt: "Local instructions",
				cwd,
				tools: ["read"],
				skills: [],
				mcpServers: [],
				enabled: true,
			}),
		),
	);
	let held = 0;
	const acquire = bots.acquire.bind(bots);
	bots.acquire = async (id) => {
		const lease = await acquire(id);
		held++;
		let released = false;
		return {
			...lease,
			release() {
				if (!released) {
					released = true;
					held--;
					lease.release();
				}
			},
		};
	};
	const options = {
		config: { hubUrl: "http://127.0.0.1:8999", deviceId: "device", credential: "secret", allowExecution: true },
		localOrigin: "http://127.0.0.1:8989",
		dataDir,
		bots,
	};
	return {
		dir,
		roots,
		registered,
		options,
		held: () => held,
		task: (roomId: string, id = roomId) => ({
			roomId,
			id,
			botId: registered[Number(roomId.replace("room", ""))]?.id ?? "missing",
			deviceId: "device",
			botRevision: registered[Number(roomId.replace("room", ""))]?.revision ?? 1,
			attemptId: `attempt-${id}`,
			text: "test",
			leaseToken: "mock-hub-lease-token",
			leaseGeneration: 1,
		}),
		command: (roomId: string) => {
			const bot = bots.get(registered[Number(roomId.replace("room", ""))].id)!;
			return { roomId, targetBotId: bot.id, targetBotRevision: bot.revision };
		},
	};
}
const signal = () => new AbortController().signal;

describe("Bot-only device runtime", () => {
	it("runs disjoint Bots concurrently while preserving FIFO for the same Bot", async () => {
		const f = await fixture();
		const finishes = new Map<string, (value: string) => void>();
		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory: () => ({
				run(task) {
					return new Promise<string>((resolve) => finishes.set(task.id, resolve));
				},
				close() {},
			}),
		});
		cleanups.push(() => runtime.close());
		const first = runtime.onTask(f.task("room0", "first"));
		const second = runtime.onTask(f.task("room0", "second"));
		const independent = runtime.onTask(f.task("room1", "independent"));
		await vi.waitFor(() => expect([...finishes.keys()]).toEqual(["first", "independent"]));
		finishes.get("independent")!("parallel");
		expect(await independent).toBe("parallel");
		finishes.get("first")!("first");
		await first;
		await vi.waitFor(() => expect(finishes.has("second")).toBe(true));
		finishes.get("second")!("second");
		await second;
		expect(f.held()).toBe(0);
	});

	it("bounds disjoint workspace execution at four active tasks", async () => {
		const f = await fixture();
		const bots = [...f.registered];
		for (let i = 2; i < 5; i++) {
			const cwd = join(f.dir, `root-${i}`);
			await mkdir(cwd);
			bots.push(
				await f.options.bots.upsert({ ...f.registered[0], id: undefined, revision: undefined, cwd, name: `Bot ${i}` }),
			);
		}
		const finishes = new Map<string, (value: string) => void>();
		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory: () => ({
				run(task) {
					return new Promise<string>((resolve) => finishes.set(task.id, resolve));
				},
				close() {},
			}),
		});
		cleanups.push(() => runtime.close());
		const tasks = bots.map((bot, i) =>
			runtime.onTask({ ...f.task(`room${i}`), botId: bot.id, botRevision: bot.revision }),
		);
		await vi.waitFor(() => expect(finishes.size).toBe(4));
		expect(f.held()).toBe(4);
		finishes.get("room0")!("done");
		await tasks[0];
		await vi.waitFor(() => expect(finishes.size).toBe(5));
		for (let i = 1; i < 5; i++) finishes.get(`room${i}`)!("done");
		await Promise.all(tasks);
		expect(f.held()).toBe(0);
	});

	it("reschedules independent queued work when a conflicting predecessor is cancelled", async () => {
		const f = await fixture();
		const common = join(f.dir, "common");
		const left = join(common, "left");
		const right = join(common, "right");
		await mkdir(left, { recursive: true });
		await mkdir(right);
		const bots: typeof f.registered = [];
		for (const [index, cwd] of [left, common, right].entries()) {
			bots.push(
				await f.options.bots.upsert({
					...f.registered[0],
					id: undefined,
					revision: undefined,
					cwd,
					name: `Queue ${index}`,
				}),
			);
		}
		const finishes = new Map<string, (value: string) => void>();
		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory: () => ({
				run(task) {
					return new Promise<string>((resolve) => finishes.set(task.id, resolve));
				},
				close() {},
			}),
		});
		cleanups.push(() => runtime.close());
		const makeTask = (i: number) => ({ ...f.task(`room${i}`), botId: bots[i].id, botRevision: bots[i].revision });
		const first = runtime.onTask(makeTask(0));
		await vi.waitFor(() => expect(finishes.size).toBe(1));
		const controller = new AbortController();
		const blocked = runtime.onTask(makeTask(1), controller.signal);
		const rejected = expect(blocked).rejects.toThrow();
		const independent = runtime.onTask(makeTask(2));
		expect(finishes.size).toBe(1);
		controller.abort();
		await rejected;
		await vi.waitFor(() => expect(finishes.has("room2")).toBe(true));
		finishes.get("room2")!("done");
		await independent;
		finishes.get("room0")!("done");
		await first;
	});

	it("serializes distinct Bots whose roots overlap", async () => {
		const f = await fixture();
		const nested = join(f.roots[0], "nested");
		await mkdir(nested);
		const changed = await f.options.bots.upsert({ ...f.registered[1], cwd: nested });
		const finishes: ((value: string) => void)[] = [];
		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory: () => ({
				run() {
					return new Promise<string>((resolve) => finishes.push(resolve));
				},
				close() {},
			}),
		});
		cleanups.push(() => runtime.close());
		const first = runtime.onTask(f.task("room0"));
		const second = runtime.onTask({ ...f.task("room1"), botRevision: changed.revision });
		await vi.waitFor(() => expect(finishes.length).toBe(1));
		finishes[0]("done");
		await first;
		await vi.waitFor(() => expect(finishes.length).toBe(2));
		finishes[1]("done");
		await second;
	});
	it("allows ordinary sessions to list but requires an executor-bound owner for every write, even at the same cwd", async () => {
		const f = await fixture();
		await writeFile(join(f.roots[0], "payload.txt"), "Bot-owned payload");
		const request = vi.fn(
			async (_url: unknown, _init?: RequestInit) =>
				new Response(JSON.stringify({ bots: [], rooms: [], transferId: "staged" }), { status: 200 }),
		);
		vi.stubGlobal("fetch", request);
		const writes = [
			{ action: "create_room" as const, args: { name: "New room", targetBotId: "remote" } },
			{ action: "send_message" as const, args: { roomId: "room0", message: "Hello" } },
			{ action: "sync_files" as const, args: { roomId: "room0", targetBotId: "remote", paths: ["payload.txt"] } },
		];
		let runtime!: ReturnType<typeof createDeviceRuntime>;
		runtime = createDeviceRuntime({
			...f.options,
			executorFactory(options) {
				return {
					async run(task) {
						options.onSession?.(task.id, "bot-session");
						for (const { action, args } of writes) {
							await runtime.collabService.execute(action, { ...args, sourceBotId: task.botId }, undefined, {
								cwd: options.cwd,
								sessionId: "bot-session",
							});
							expect(f.held()).toBe(1);
						}
						return "done";
					},
					close() {},
				};
			},
		});
		cleanups.push(() => runtime.close());
		const human = { cwd: f.roots[0], sessionId: "human" };
		for (const action of ["list_bots", "list_rooms"] as const) {
			await runtime.collabService.execute(action, {}, undefined, human);
		}
		expect(request).toHaveBeenCalledTimes(2);
		request.mockClear();
		for (const context of [human, { cwd: f.roots[0] }]) {
			for (const { action, args } of writes) {
				await expect(
					runtime.collabService.execute(action, { ...args, sourceBotId: f.registered[0].id }, undefined, context),
				).rejects.toThrow("request failed");
				expect(f.held()).toBe(0);
			}
		}
		expect(request).not.toHaveBeenCalled();
		console.log("BEFORE ONTASK CALLS:", request.mock.calls.length);
		expect(await runtime.onTask(f.task("room0"))).toBe("done");
		expect(request.mock.calls.length).toBeGreaterThanOrEqual(3);
		const bodies = request.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
		expect(bodies.every((body) => body.sourceBotId === f.registered[0].id)).toBe(true);
		expect(bodies[0]).toMatchObject({ botIds: [f.registered[0].id, "remote"] });
		expect(bodies[1]).toMatchObject({ text: "Hello" });
		expect(bodies.some((b) => b.targetBotId === "remote" && (b.action === "stage" || b.action === "init"))).toBe(true);
		request.mockClear();
		for (const { action, args } of writes) {
			await expect(
				runtime.collabService.execute(action, { ...args, sourceBotId: f.registered[0].id }, undefined, {
					cwd: f.roots[0],
					sessionId: "bot-session",
				}),
			).rejects.toThrow("request failed");
		}
		expect(request).not.toHaveBeenCalled();
		expect(f.held()).toBe(0);
	});
	it("rejects legacy routes, wrong devices, stale revisions and disabled Bots before execution", async () => {
		const f = await fixture();
		let executions = 0;
		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory() {
				executions++;
				return {
					async run() {
						return "done";
					},
					close() {},
				};
			},
		});
		cleanups.push(() => runtime.close());
		for (const patch of [
			{ botId: "" },
			{ deviceId: "other" },
			{ botRevision: 0 },
			{ botRevision: undefined },
			{ roomId: "" },
		]) {
			await expect(
				runtime.onTask({ ...f.task("room0"), ...patch } as Parameters<typeof runtime.onTask>[0]),
			).rejects.toThrow();
			expect(f.held()).toBe(0);
		}
		const revised = await f.options.bots.upsert({ ...f.registered[0], systemPrompt: "Updated" });
		await expect(runtime.onTask(f.task("room0"))).rejects.toThrow();
		expect(f.held()).toBe(0);
		expect(executions).toBe(0);
		expect(await runtime.onTask({ ...f.task("room0"), botRevision: revised.revision })).toBe("done");
		await f.options.bots.upsert({ ...revised, enabled: false });
		await expect(runtime.onTask({ ...f.task("room0"), botRevision: revised.revision + 1 })).rejects.toThrow();
		expect(executions).toBe(1);
		expect(f.held()).toBe(0);
	});

	it("requires targetBotId for transfers and rejects cancelled or closed admission", async () => {
		const f = await fixture();
		const runtime = createDeviceRuntime(f.options);
		cleanups.push(() => runtime.close());
		for (const payload of [null, [], {}, { roomId: "room0" }, { roomId: "room0", botId: f.registered[0].id }]) {
			await expect(runtime.onCommand("transfer_preview", payload, signal())).rejects.toThrow();
		}
		const controller = new AbortController();
		controller.abort();
		await expect(runtime.onCommand("transfer_preview", f.command("room0"), controller.signal)).rejects.toThrow();
		await expect(runtime.onTask(f.task("room0"), controller.signal)).rejects.toThrow();
		expect(f.held()).toBe(0);
		await runtime.close();
		await expect(runtime.onTask(f.task("room0"))).rejects.toThrow("closed");
		await expect(runtime.onCommand("transfer_preview", f.command("room0"), signal())).rejects.toThrow("closed");
	});
	it("creates each task executor in its explicit room root without restarting", async () => {
		const f = await fixture();
		const cwds: string[] = [];
		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory(options) {
				cwds.push(options.cwd);
				return {
					async run() {
						return options.cwd;
					},
					close() {},
				};
			},
		});
		cleanups.push(() => runtime.close());
		await expect(runtime.onTask(f.task("missing"))).rejects.toThrow("Target Bot unavailable");
		expect(await runtime.onTask(f.task("room0"))).toBe(f.roots[0]);
		expect(await runtime.onTask(f.task("room1"))).toBe(f.roots[1]);
		expect(cwds).toEqual(f.roots);
		expect(f.held()).toBe(0);
	});

	it("routes identical paths to separate roots, rejects cross-room IDs and invalidates changed bindings", async () => {
		const f = await fixture();
		const sourceRoot = join(f.dir, "source");
		await mkdir(sourceRoot);
		await writeFile(join(sourceRoot, "same.txt"), "payload");
		const source = createDeviceFileSync({ root: sourceRoot, dataDir: f.options.dataDir, allowReceive: true });
		cleanups.push(() => source.close());
		const runtime = createDeviceRuntime(f.options);
		cleanups.push(() => runtime.close());
		const bundle = await source.prepare({ paths: ["same.txt"] });
		const stage = async (roomId: string) =>
			runtime.onCommand("transfer_stage", { ...f.command(roomId), bundle }, signal()) as Promise<{
				id: string;
				revision: string;
			}>;
		for (const targetBotRevision of [undefined, 0, 2]) {
			await expect(
				runtime.onCommand("transfer_stage", { ...f.command("room0"), targetBotRevision, bundle }, signal()),
			).rejects.toThrow("revision mismatch");
			expect(f.held()).toBe(0);
		}
		const first = await stage("room0");
		expect(first.id).toBeTruthy();
		expect(f.held()).toBe(0);
		await expect(
			runtime.onCommand("transfer_preview", { ...f.command("room1"), roomId: "room0", transferId: first.id }, signal()),
		).rejects.toThrow("unavailable");
		await expect(
			runtime.onCommand(
				"transfer_apply",
				{ ...f.command("room0"), transferId: first.id, revision: "stale", overwritePaths: [] },
				signal(),
			),
		).rejects.toThrow();
		expect(f.held()).toBe(0);
		await expect(
			runtime.onCommand("transfer_preview", { ...f.command("room1"), transferId: first.id }, signal()),
		).rejects.toThrow("unavailable");
		await expect(runtime.onCommand("transfer_preview", { transferId: first.id }, signal())).rejects.toThrow(
			"Room required",
		);
		for (const roomId of ["room0", "room1"]) {
			const staged = roomId === "room0" ? first : await stage(roomId);
			await runtime.onCommand(
				"transfer_apply",
				{ ...f.command(roomId), transferId: staged.id, revision: staged.revision, overwritePaths: [] },
				signal(),
			);
		}
		expect(await Promise.all(f.roots.map((root) => readFile(join(root, "same.txt"), "utf8")))).toEqual([
			"payload",
			"payload",
		]);
		const stale = await stage("room0");
		await f.options.bots.upsert({ ...f.registered[0], cwd: f.roots[1] });
		await expect(
			runtime.onCommand(
				"transfer_apply",
				{ ...f.command("room0"), transferId: stale.id, revision: stale.revision, overwritePaths: ["same.txt"] },
				signal(),
			),
		).rejects.toThrow("unavailable");
	});

	it("keeps the device busy and its lease until cancelled execution actually settles", async () => {
		const f = await fixture();
		let settle!: (value: string) => void;
		let started!: () => void;
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		let closes = 0;
		let runs = 0;
		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory() {
				return {
					run() {
						if (++runs > 1) return Promise.resolve("new task");
						started();
						return new Promise((resolve) => {
							settle = resolve;
						});
					},
					close() {
						closes++;
					},
				};
			},
		});
		cleanups.push(() => runtime.close());
		const first = runtime.onTask(f.task("room0"));
		const rejected = expect(first).rejects.toThrow();
		await running;
		const disconnected = runtime.onDisconnect({ abortTasks: true });
		await Promise.resolve();
		expect(closes).toBe(1);
		expect(f.held()).toBe(1);
		await expect(f.options.bots.upsert({ ...f.registered[0], enabled: false })).rejects.toMatchObject({
			code: "BOT_BUSY",
		});
		await expect(f.options.bots.remove(f.registered[0].id, 1)).rejects.toMatchObject({ code: "BOT_BUSY" });
		const queued = runtime.onTask(f.task("room0", "queued"));
		expect(runs).toBe(1);
		settle("old completion");
		await rejected;
		await disconnected;
		expect(f.held()).toBe(0);
		expect(await queued).toBe("new task");
	});

	it("persists a Hub address across runtime restart and refuses missing or changed ownership", async () => {
		const f = await fixture();
		const conversationId = "12345678-1234-4234-8234-123456789abc";
		const path = join(f.options.dataDir, "session.jsonl");
		const seen: (string | undefined)[] = [];
		const executorFactory: NonNullable<Parameters<typeof createDeviceRuntime>[0]["executorFactory"]> = (options) => ({
			async run(task) {
				seen.push(options.resumePath);
				options.onSession?.(task.id, "sdk-session");
				options.onSessionPath?.(task.id, path);
				// The SDK creates a fresh transcript only after the initial snapshot.
				if (!options.resumePath) await writeFile(path, "transcript");
				return options.resumePath ? "continued" : "created";
			},
			close() {},
		});
		const first = createDeviceRuntime({ ...f.options, executorFactory });
		expect(await first.onTask({ ...f.task("room0"), conversationId })).toBe("created");
		await first.close();
		const second = createDeviceRuntime({
			...f.options,
			config: { ...f.options.config, credential: "rotated-credential" },
			executorFactory,
		});
		cleanups.push(() => second.close());
		expect(await second.onTask({ ...f.task("room0"), conversationId, resume: true })).toBe("continued");
		expect(seen).toEqual([undefined, path]);
		await expect(second.onTask({ ...f.task("room0"), conversationId })).rejects.toThrow("explicit resume");
		await expect(second.onTask({ ...f.task("room1"), conversationId, resume: true })).rejects.toThrow(
			"configuration changed",
		);
		await expect(
			second.onTask({ ...f.task("room0"), conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", resume: true }),
		).rejects.toThrow("unavailable");
		expect(seen).toHaveLength(2);
		const changed = createDeviceRuntime({
			...f.options,
			config: { ...f.options.config, hubUrl: "http://different-hub" },
			executorFactory,
		});
		cleanups.push(() => changed.close());
		await expect(changed.onTask({ ...f.task("room0"), conversationId, resume: true })).rejects.toThrow(
			"configuration changed",
		);
	});

	it("retains the captured transcript after a failed first turn for recovery after restart", async () => {
		const f = await fixture();
		const conversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		const path = join(f.options.dataDir, "failed-session.jsonl");
		const failed = createDeviceRuntime({
			...f.options,
			executorFactory: (options) => ({
				async run(task) {
					options.onSession?.(task.id, "retained-sdk");
					options.onSessionPath?.(task.id, path);
					await writeFile(path, "retained transcript");
					throw new Error("local approval required");
				},
				close() {},
			}),
		});
		await expect(failed.onTask({ ...f.task("room0"), conversationId })).rejects.toThrow("approval required");
		await failed.close();
		const recovered = createDeviceRuntime({
			...f.options,
			executorFactory: (options) => ({
				async run(task) {
					expect(options.resumePath).toBe(path);
					options.onSession?.(task.id, "retained-sdk");
					options.onSessionPath?.(task.id, path);
					return "recovered";
				},
				close() {},
			}),
		});
		cleanups.push(() => recovered.close());
		expect(await recovered.onTask({ ...f.task("room0"), conversationId, resume: true })).toBe("recovered");
	});

	it("rejects completion and resume when a newly bound transcript never materializes", async () => {
		const f = await fixture();
		const conversationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
		let runs = 0;
		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory: (options) => ({
				async run(task) {
					runs++;
					options.onSession?.(task.id, "empty-sdk");
					options.onSessionPath?.(task.id, join(f.options.dataDir, "missing.jsonl"));
					return "no transcript";
				},
				close() {},
			}),
		});
		cleanups.push(() => runtime.close());
		await expect(runtime.onTask({ ...f.task("room0"), conversationId })).rejects.toThrow(
			"transcript unavailable after execution",
		);
		await expect(runtime.onTask({ ...f.task("room0"), conversationId, resume: true })).rejects.toThrow(
			"Conversation transcript unavailable",
		);
		expect(runs).toBe(1);
	});

	it("cancels queued tasks without starting them and bounds waiting admission", async () => {
		const f = await fixture();
		let finish!: (value: string) => void;
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		let runs = 0;
		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory: () => ({
				run() {
					runs++;
					started();
					return new Promise<string>((resolve) => {
						finish = resolve;
					});
				},
				close() {},
			}),
		});
		cleanups.push(() => runtime.close());
		const first = runtime.onTask(f.task("room0"));
		await ready;
		const controller = new AbortController();
		const waiting = Array.from({ length: 32 }, () => runtime.onTask(f.task("room0"), controller.signal));
		const results = Promise.allSettled(waiting);
		await expect(runtime.onTask(f.task("room0"))).rejects.toThrow("queue full");
		controller.abort();
		expect((await results).every((result) => result.status === "rejected")).toBe(true);
		expect(runs).toBe(1);
		finish("done");
		expect(await first).toBe("done");
		expect(f.held()).toBe(0);
	});

	it("retains uncertain workspace isolation while independent Bots remain available", async () => {
		const f = await fixture();
		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory(options) {
				return {
					async run() {
						return "done";
					},
					async close() {
						if (options.cwd === f.roots[0]) throw new Error("stop uncertain");
					},
				};
			},
		});
		await expect(runtime.onTask(f.task("room0"))).rejects.toMatchObject({
			message: "stop uncertain",
			stopUnconfirmed: true,
		});
		expect(f.held()).toBe(1);
		await expect(f.options.bots.remove(f.registered[0].id, 1)).rejects.toMatchObject({ code: "BOT_BUSY" });
		await expect(runtime.onTask(f.task("room0", "blocked"))).rejects.toThrow("blocked");
		expect(await runtime.onTask(f.task("room1"))).toBe("done");
		expect(f.held()).toBe(1);
		await expect(runtime.onDisconnect()).rejects.toMatchObject({ stopUnconfirmed: true });
		await expect(runtime.close()).rejects.toThrow("stop uncertain");
	});

	it("rejects cross-room, cross-Bot and wrong-cwd relay attempts from a bound task session", async () => {
		const f = await fixture();
		let runtime!: ReturnType<typeof createDeviceRuntime>;
		runtime = createDeviceRuntime({
			...f.options,
			executorFactory(options) {
				return {
					async run(task) {
						options.onSession?.(task.id, "bound-session");
						for (const input of [
							{ roomId: "room1", sourceBotId: f.registered[0].id, cwd: f.roots[0] },
							{ roomId: "room0", sourceBotId: f.registered[1].id, cwd: f.roots[1] },
							{ roomId: "room0", sourceBotId: f.registered[0].id, cwd: f.roots[1] },
						]) {
							await expect(
								runtime.collabService.execute(
									"send_task",
									{ roomId: input.roomId, sourceBotId: input.sourceBotId, targetBotId: "other", prompt: "run" },
									undefined,
									{ cwd: input.cwd, sessionId: "bound-session" },
								),
							).rejects.toThrow();
							expect(f.held()).toBe(1);
						}
						return "done";
					},
					close() {},
				};
			},
		});
		cleanups.push(() => runtime.close());
		expect(await runtime.onTask(f.task("room0"))).toBe("done");
		expect(f.held()).toBe(0);
		await expect(
			runtime.collabService.execute(
				"send_task",
				{ roomId: "room0", sourceBotId: f.registered[0].id, targetBotId: "other", prompt: "run" },
				undefined,
				{ cwd: f.roots[0], sessionId: "bound-session" },
			),
		).rejects.toThrow("not bound");
	});

	it("requires a matching task session for send_task and explicit execution permission for commands", async () => {
		const f = await fixture();
		const runtime = createDeviceRuntime(f.options);
		cleanups.push(() => runtime.close());
		await expect(
			runtime.collabService.execute(
				"send_task",
				{ roomId: "room0", sourceBotId: f.registered[0].id, targetBotId: "other", prompt: "run" },
				undefined,
				{ cwd: f.roots[0], sessionId: "human" },
			),
		).rejects.toThrow("not bound");
		await expect(
			runtime.collabService.execute(
				"sync_files",
				{ roomId: "room1", sourceBotId: f.registered[1].id, targetBotId: "other", paths: ["file"] },
				undefined,
				{ cwd: f.roots[0], sessionId: "human" },
			),
		).rejects.toThrow("request failed");
		const denied = createDeviceRuntime({ ...f.options, config: { ...f.options.config, allowExecution: false } });
		cleanups.push(() => denied.close());
		await expect(
			denied.onCommand("transfer_preview", { ...f.command("room0"), transferId: "any" }, signal()),
		).rejects.toThrow("disabled");
	});
});
