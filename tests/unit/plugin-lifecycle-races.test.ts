import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginEffectStack, PluginManager } from "../../server/plugins.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("plugin lifecycle generations", () => {
	let root: string;
	let manager: PluginManager;
	let key: string;
	let state: {
		started: ReturnType<typeof deferred>;
		resume: ReturnType<typeof deferred>;
		activations: number;
		cleaned: number;
		lateCleaned: number;
		deactivated: number;
		cleanupHostOk: number;
		cleanupHostBlocked: number;
		staleRejected: number;
		fail: boolean;
		cleanupFails: boolean;
	};
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-plugin-generation-"));
		manager = new PluginManager(root, root);
		key = `plugin-race:${root}`;
		state = {
			started: deferred(),
			resume: deferred(),
			activations: 0,
			cleaned: 0,
			lateCleaned: 0,
			deactivated: 0,
			cleanupHostOk: 0,
			cleanupHostBlocked: 0,
			staleRejected: 0,
			fail: false,
			cleanupFails: false,
		};
		(globalThis as any)[key] = state;
		const dir = join(root, "plugins", "race");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify({ id: "race", name: "Race", version: "1.0.0", apiVersion: 2, permissions: ["tools", "http"] }),
		);
		writeFileSync(
			join(dir, "index.mjs"),
			`
export default async function(host) {
	const state = globalThis[${JSON.stringify(key)}];
	const run = ++state.activations;
	host.registerCommand({ name: "racecmd", run: () => String(run) });
	host.registerAgentTool({ name: "race_tool", description: "race", execute: async () => String(run) });
	host.events.on("race:topic", () => {});
	host.effect("external", () => { state.cleaned++; });
	if (run === 1) {
		state.started.resolve();
		await state.resume.promise;
		host.effect("late-external", () => { state.lateCleaned++; });
		for (const register of [
			() => host.registerCommand({ name: "latecmd", run: () => "late" }),
			() => host.events.on("race:late", () => {}),
			() => host.registerAgentTool({ name: "late_tool", description: "late", execute: async () => "late" }),
		]) {
			try { register(); } catch { state.staleRejected++; }
		}
		if (state.fail) throw new Error("old activation failed");
	}
	return async () => {
		state.deactivated++;
		// 清理期必须还能碰宿主能力：dispose() 已推进 generation，若不豁免，
		// 第一句 host.* 就会抛 "activation has been disposed"，后面的清理全部夭折。
		try {
			host.log("cleanup ping");
			state.cleanupHostOk++;
		} catch {
			state.cleanupHostBlocked++;
		}
		if (state.cleanupFails) throw new Error("cleanup failed");
	};
}
`,
		);
	});
	afterEach(() => {
		manager.dispose();
		vi.useRealTimers();
		state.resume.resolve();
		delete (globalThis as any)[key];
		rmSync(root, { recursive: true, force: true });
	});

	it("coalesces concurrent ensureLoaded calls until activation finishes", async () => {
		const first = manager.ensureLoaded();
		await state.started.promise;
		const second = manager.ensureLoaded();
		expect(second).toBe(first);
		state.resume.resolve();
		const [a, b] = await Promise.all([first, second]);
		expect(a).toEqual(b);
		expect(a[0]).toMatchObject({ id: "race", active: true });
		expect(state.activations).toBe(1);
	});

	it("dispose immediately releases in-flight effects and rejects stale registrations", async () => {
		const loading = manager.ensureLoaded();
		await state.started.promise;
		manager.dispose();
		expect(state.cleaned).toBe(1);
		expect(manager.getAgentTools()).toEqual([]);
		expect(manager.listCommands()).toEqual([]);
		expect(manager.busHandlers.size).toBe(0);
		expect(manager["activatingGates"].size).toBe(0);
		state.resume.resolve();
		expect(await loading).toEqual([]);
		expect(state.lateCleaned).toBe(1);
		expect(state.staleRejected).toBe(3);
		expect(state.deactivated).toBe(1);
		expect(manager["loaded"].size).toBe(0);
		expect(manager["activatingEffects"].size).toBe(0);
		await manager.ensureLoaded();
		expect(state.activations).toBe(2);
	});

	it.each([false, true])("old activation settlement cannot replace a reload (reject=%s)", async (fail) => {
		state.fail = fail;
		const loading = manager.ensureLoaded();
		await state.started.promise;
		const reload = manager.reload();
		expect(manager.reload()).toBe(reload);
		const current = await reload;
		expect(current[0]).toMatchObject({ id: "race", active: true });
		expect(state.activations).toBe(2);
		const entry = manager["loaded"].get("race");
		state.resume.resolve();
		expect(await loading).toEqual([]);
		expect(manager["loaded"].get("race")).toBe(entry);
		expect(entry?.info.error).toBeUndefined();
		expect(manager.getAgentTools().map((t) => t.name)).toEqual(["race_tool"]);
		expect(manager.listCommands().map((c) => c.name)).toEqual(["racecmd"]);
		expect(manager.busHandlers.get("race:topic")?.size).toBe(1);
		expect(state.cleaned).toBe(1);
		expect(state.deactivated).toBe(fail ? 0 : 1);
		expect(manager["activatingGates"].size).toBe(0);
	});

	it("deactivate 期间的宿主调用被放行，清理不会在第一句断掉", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const loading = manager.ensureLoaded();
			await state.started.promise;
			state.resume.resolve();
			expect((await loading)[0]).toMatchObject({ id: "race", active: true });
			manager.dispose();
			expect(state.deactivated).toBe(1);
			expect(state.cleanupHostBlocked).toBe(0);
			expect(state.cleanupHostOk).toBe(1);
			expect(log).not.toHaveBeenCalledWith("[plugin:race] deactivate failed:", expect.anything());
		} finally {
			log.mockRestore();
		}
	});

	it("observes rejected async cleanup returned by a stale activation", async () => {
		state.cleanupFails = true;
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const loading = manager.ensureLoaded();
			await state.started.promise;
			manager.dispose();
			state.resume.resolve();
			await loading;
			expect(log).toHaveBeenCalledWith("[plugin:race] deactivate failed:", expect.any(Error));
		} finally {
			log.mockRestore();
		}
	});

	it("does not emit heartbeat failures after its activation was disposed", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const started = deferred();
		const resume = deferred();
		const onDead = vi.fn();
		Object.assign(state, {
			check: async () => {
				started.resolve();
				await resume.promise;
				return false;
			},
			onDead,
		});
		writeFileSync(
			join(root, "plugins", "race", "index.mjs"),
			`
export default (host) => {
	const state = globalThis[${JSON.stringify(key)}];
	host.registerBackgroundTask({ id: "heartbeat", label: "heartbeat", intervalMs: 50, maxFailures: 1, check: state.check, onDead: state.onDead });
};
`,
		);
		await manager.ensureLoaded();
		await vi.advanceTimersByTimeAsync(50);
		await started.promise;
		manager.dispose();
		resume.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(onDead).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("dispose invalidates a pending scan without repopulating manifest state", async () => {
		const loading = manager.ensureLoaded();
		manager.dispose();
		expect(await loading).toEqual([]);
		expect(state.activations).toBe(0);
		expect(manager["manifestDiags"].size).toBe(0);
		expect(manager["loaded"].size).toBe(0);
	});
});

describe("closed plugin effect stacks", () => {
	it("immediately disposes late and recursively added effects exactly once", () => {
		const stack = new PluginEffectStack("late");
		const late = vi.fn();
		stack.add("outer", () => {
			stack.add("recursive", late);
		});
		stack.release();
		expect(late).toHaveBeenCalledTimes(1);
		const unregister = stack.add("late", late);
		unregister();
		stack.release();
		expect(late).toHaveBeenCalledTimes(2);
		expect(stack.size).toBe(0);
	});
});
