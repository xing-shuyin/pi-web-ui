import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs";
import { writeAtomicSync } from "../../server/atomic-file.js";
import { ClientStateStore } from "../../server/client-state.js";
import { ComposerDraftsStore } from "../../server/composer-drafts.js";
import { SettingsService, type SettingsHost } from "../../server/settings-service.js";
import type { SubagentTemplatesStore } from "../../server/subagent-templates.js";

vi.mock("node:fs", async (original) => {
	const actual = await original<typeof import("node:fs")>();
	return { ...actual, renameSync: vi.fn(actual.renameSync), writeFileSync: vi.fn(actual.writeFileSync) };
});

const dirs: string[] = [];
function file(name = "state.json") {
	const dir = mkdtempSync(join(tmpdir(), "shared-state-"));
	dirs.push(dir);
	return join(dir, name);
}
function service(store: ClientStateStore, clientId: string) {
	const host: SettingsHost = {
		clientId,
		stateStore: store,
		emit: vi.fn(),
		flushSnapshot: vi.fn(),
		isDisposed: () => false,
		getSession: () => {
			throw new Error("not ready");
		},
		cwd: () => store.dataDir,
		agentDir: () => store.dataDir,
		isStreaming: () => false,
		reloadSession: vi.fn(async () => {}),
		applyRetryOverrides: vi.fn(),
		applyCompactionOverrides: vi.fn(),
		applyToolGating: vi.fn(),
		applyCodemodeOverrides: vi.fn(),
		onSessionsFilterChanged: vi.fn(),
		onGoalModeDisabled: vi.fn(),
		promptSnapshot: () => ({ full: "", texts: {}, toolsSchema: "" }),
	};
	return { host, svc: new SettingsService(host, { list: () => [] } as unknown as SubagentTemplatesStore) };
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(fs.renameSync).mockReset();
	vi.mocked(fs.writeFileSync).mockReset();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
	vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync);
});

const diskFull = Object.assign(new Error("disk full"), { code: "ENOSPC" });

describe("atomic replacement failures", () => {
	it("never truncates the old file when rename remains locked", () => {
		const path = file();
		writeAtomicSync(path, '{"old":true}');
		const locked = Object.assign(new Error("locked"), { code: "EPERM" });
		vi.mocked(fs.renameSync).mockImplementation(() => {
			throw locked;
		});
		vi.mocked(fs.writeFileSync).mockClear();
		expect(() => writeAtomicSync(path, '{"new":true}')).toThrow(locked);
		expect(readFileSync(path, "utf8")).toBe('{"old":true}');
		expect(vi.mocked(fs.writeFileSync).mock.calls.every(([target]) => target !== path)).toBe(true);
		expect(fs.renameSync).toHaveBeenCalledTimes(4);
		expect(readdirSync(dirs[0])).toEqual(["state.json"]);
	});
	it("recovers from a transient rename failure", () => {
		const path = file();
		vi.mocked(fs.renameSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("busy"), { code: "EBUSY" });
		});
		writeAtomicSync(path, "ok");
		expect(readFileSync(path, "utf8")).toBe("ok");
	});
});

describe("authoritative shared settings", () => {
	it("merges interleaved clients and only persists the fields supplied", async () => {
		const path = file();
		const store = new ClientStateStore(path);
		const a = service(store, "a");
		const b = service(store, "b");
		await a.svc.set({ thinkingWrap: true });
		const save = vi.spyOn(store, "saveSettings");
		await b.svc.set({ toolsWrap: false });
		expect(save).toHaveBeenLastCalledWith("b", { toolsWrap: false });
		expect(a.svc.current).toMatchObject({ thinkingWrap: true, toolsWrap: false });
		expect(new ClientStateStore(path).getSettings("restart")).toMatchObject({ thinkingWrap: true, toolsWrap: false });
		await a.svc.set({ promptOverrides: { soul: "a" } });
		await b.svc.set({ promptOverrides: { append: "b" } });
		expect(a.svc.current.promptOverrides).toEqual({ soul: "a", append: "b" });
		await a.svc.set({ promptOverrides: { soul: "" } });
		expect(b.svc.current.promptOverrides).toEqual({ append: "b" });
	});
	it("partial presets keep other clients' latest settings", async () => {
		const store = new ClientStateStore(file());
		const a = service(store, "a");
		const b = service(store, "b");
		store.savePresets("a", [{ name: "partial", thinkingWrap: true } as any]);
		await a.svc.set({ toolsWrap: false });
		await b.svc.applyPreset("partial");
		expect(a.svc.current).toMatchObject({ thinkingWrap: true, toolsWrap: false });
	});
	it("does not lend mutable settings references", () => {
		const store = new ClientStateStore(file());
		const input = { disabledSkills: ["one"] };
		store.saveSettings("a", input);
		input.disabledSkills.push("bad");
		store.getSettings("b").disabledSkills.push("also bad");
		expect(store.getSettings("a").disabledSkills).toEqual(["one"]);
	});
	it("rejects failed saves, keeps disk/cache unchanged and skips runtime effects", async () => {
		const path = file();
		const store = new ClientStateStore(path);
		store.saveSettings("a", { thinkingWrap: false });
		const { svc, host } = service(store, "a");
		const original = readFileSync(path, "utf8");
		vi.mocked(fs.writeFileSync).mockImplementation(() => {
			throw diskFull;
		});
		await expect(svc.set({ thinkingWrap: true, retryMaxAttempts: 9, goalModeEnabled: false })).rejects.toThrow(
			diskFull,
		);
		expect(svc.current).toMatchObject({ thinkingWrap: false, goalModeEnabled: true });
		expect(readFileSync(path, "utf8")).toBe(original);
		expect(host.applyRetryOverrides).not.toHaveBeenCalled();
		expect(host.onGoalModeDisabled).not.toHaveBeenCalled();
		expect(host.emit).toHaveBeenCalledWith(
			expect.objectContaining({ type: "notice", level: "error", textEn: expect.stringContaining("not saved") }),
		);
	});
});

describe("shared settings subscriptions", () => {
	it("reuses frozen detached snapshots until a successful commit", () => {
		const store = new ClientStateStore(file());
		const { svc } = service(store, "a");
		const first = svc.current;
		expect(svc.current).toBe(first);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.disabledSkills)).toBe(true);
		expect(() => first.disabledSkills.push("mutate")).toThrow();
		store.saveSettings("b", { thinkingWrap: true });
		expect(svc.current).not.toBe(first);
		expect(first.thinkingWrap).toBe(false);
		expect(svc.current.thinkingWrap).toBe(true);
	});

	it("broadcasts once, applies peer effects, and never saves on receive", async () => {
		const store = new ClientStateStore(file());
		const a = service(store, "a");
		const b = service(store, "b");
		a.svc.subscribeSharedSettings();
		b.svc.subscribeSharedSettings();
		b.svc.subscribeSharedSettings();
		const save = vi.spyOn(store, "saveSettings");
		const notices = vi.fn();
		store.subscribeSettings(notices);
		await a.svc.set({
			retryMaxAttempts: 9,
			softCapTokens: 100_000,
			codemodeInlineBudget: 5000,
			disabledAgentTools: ["bash"],
			showForkedParentSessions: true,
			goalModeEnabled: false,
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(save).toHaveBeenCalledTimes(1);
		expect(notices).toHaveBeenCalledTimes(1);
		for (const host of [a.host, b.host]) {
			expect(host.applyRetryOverrides).toHaveBeenCalledTimes(1);
			expect(host.applyCompactionOverrides).toHaveBeenCalledTimes(1);
			expect(host.applyCodemodeOverrides).toHaveBeenCalledTimes(1);
			expect(host.applyToolGating).toHaveBeenCalledTimes(1);
			expect(host.onSessionsFilterChanged).toHaveBeenCalledTimes(1);
			expect(host.onGoalModeDisabled).toHaveBeenCalledTimes(1);
		}
		expect(b.host.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "settings_state" }));
		await b.svc.receiveSharedSettings(notices.mock.calls[0][0]);
		expect(b.host.applyToolGating).toHaveBeenCalledTimes(1);
		a.svc.dispose();
		b.svc.dispose();
	});

	it("defers peer reload during streaming and unsubscribes on disposal", async () => {
		const store = new ClientStateStore(file());
		const { svc, host } = service(store, "peer");
		host.isStreaming = () => true;
		svc.subscribeSharedSettings();
		store.saveSettings("external", { promptTemplate: "{{soul}}" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(svc.hasPendingReload()).toBe(true);
		expect(host.reloadSession).not.toHaveBeenCalled();
		host.isStreaming = () => false;
		expect(svc.consumePendingReload()).toBe(true);
		await svc.applyRuntime();
		expect(host.reloadSession).toHaveBeenCalledTimes(1);
		svc.dispose();
		store.saveSettings("external", { retryMaxAttempts: 10 });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(host.applyRetryOverrides).not.toHaveBeenCalled();
	});

	it("does not notify failed commits and isolates subscriber errors", async () => {
		const store = new ClientStateStore(file());
		store.saveSettings("a", {});
		const listener = vi.fn();
		store.subscribeSettings(() => {
			throw new Error("observer");
		});
		store.subscribeSettings(listener);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => store.saveSettings("a", { thinkingWrap: true })).not.toThrow();
		expect(listener).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalled();
		const snapshot = store.getSettingsSnapshot("a");
		vi.mocked(fs.writeFileSync).mockImplementation(() => {
			throw diskFull;
		});
		expect(() => store.saveSettings("a", { thinkingWrap: false })).toThrow(diskFull);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(store.getSettingsSnapshot("a")).toBe(snapshot);
	});

	it("serializes peer reloads and does not re-persist after reload", async () => {
		const store = new ClientStateStore(file());
		const { svc, host } = service(store, "peer");
		let release!: () => void;
		vi.mocked(host.reloadSession).mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		svc.subscribeSharedSettings();
		const save = vi.spyOn(store, "saveSettings");
		store.saveSettings("a", { promptTemplate: "one" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		store.saveSettings("b", { promptTemplate: "two" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(host.reloadSession).toHaveBeenCalledTimes(1);
		release();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(host.reloadSession).toHaveBeenCalledTimes(2);
		expect(save).toHaveBeenCalledTimes(2);
		svc.dispose();
	});
});

describe("shared drafts by file", () => {
	it("preserves interleaved entries and never resurrects cleared drafts", () => {
		const path = file();
		const a = new ComposerDraftsStore(path);
		const b = new ComposerDraftsStore(path);
		a.get("a");
		b.get("b");
		a.save("a", "one", 1);
		b.save("b", "two", 2);
		expect(a.get("b")?.text).toBe("two");
		b.clear("a");
		a.save("c", "three", 3);
		expect(Object.keys(JSON.parse(readFileSync(path, "utf8"))).sort()).toEqual(["b", "c"]);
	});
	it("isolates watermarks between files and rejects stale empty updates", () => {
		const a = new ComposerDraftsStore(file());
		const b = new ComposerDraftsStore(file());
		a.clear("same");
		b.save("same", "keep", 200);
		b.save("same", "", 100);
		expect(b.get("same")?.text).toBe("keep");
		b.save("same", "", 201);
		b.save("same", "stale", 200);
		expect(b.get("same")).toBeUndefined();
	});
	it("failed saves and clears retain data and do not advance clear watermarks", async () => {
		const path = file();
		const a = new ComposerDraftsStore(path);
		const b = new ComposerDraftsStore(path);
		a.save("s", "old", 100);
		vi.mocked(fs.writeFileSync).mockImplementation(() => {
			throw diskFull;
		});
		expect(() => b.save("s", "new", 101)).toThrow(diskFull);
		expect(() => b.clear("s")).toThrow(diskFull);
		expect(a.get("s")).toEqual({ text: "old", ts: 100 });
		const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
		vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync);
		b.save("s", "retry", 101);
		expect(a.get("s")).toEqual({ text: "retry", ts: 101 });
	});
});
