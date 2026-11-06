import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ClientStateStore,
	DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS,
	effectiveToolWatchdogMs,
	normalizeToolWatchdogTimeoutMs,
	TOOL_WATCHDOG_EXPLICIT_GRACE_MS,
} from "../../server/client-state.js";

const roots: string[] = [];
function tempStore(): { store: ClientStateStore; file: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-tool-watchdog-"));
	roots.push(dir);
	const file = join(dir, "client-state.json");
	return { store: new ClientStateStore(file), file };
}

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("工具看门狗超时配置 (toolWatchdogTimeoutMs)", () => {
	it("normalizeToolWatchdogTimeoutMs 正常归一化", () => {
		expect(normalizeToolWatchdogTimeoutMs(0)).toBe(0);
		expect(normalizeToolWatchdogTimeoutMs("0")).toBe(0);

		expect(normalizeToolWatchdogTimeoutMs(60_000)).toBe(60_000);
		expect(normalizeToolWatchdogTimeoutMs("1200000")).toBe(1_200_000);

		expect(normalizeToolWatchdogTimeoutMs(60_000.7)).toBe(60_000);

		expect(normalizeToolWatchdogTimeoutMs(-1)).toBe(DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS);
		expect(normalizeToolWatchdogTimeoutMs("invalid")).toBe(DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS);
		expect(normalizeToolWatchdogTimeoutMs(null)).toBe(DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS);
		expect(normalizeToolWatchdogTimeoutMs(undefined)).toBe(DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS);
		expect(normalizeToolWatchdogTimeoutMs(NaN)).toBe(DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS);
	});

	it("默认值就是 20 分钟（旧行为不变）", () => {
		expect(DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS).toBe(20 * 60_000);
	});

	it("工具显式超时（bash timeout: 5400s）时看门狗自动顺延", () => {
		const base = 20 * 60_000;
		expect(effectiveToolWatchdogMs(base, "bash", { timeout: 5400 })).toBe(5_405_000);
		expect(effectiveToolWatchdogMs(base, "bash", { timeout: 60 })).toBe(base);
		expect(effectiveToolWatchdogMs(base, "bash", { timeout: "5400" })).toBe(5_405_000);
		expect(effectiveToolWatchdogMs(base, "read", { timeout: 5400 })).toBe(base);
		expect(effectiveToolWatchdogMs(base, "bash", undefined)).toBe(base);
		expect(effectiveToolWatchdogMs(base, "bash", { timeout: "abc" })).toBe(base);
		expect(effectiveToolWatchdogMs(base, "bash", { timeout: -5 })).toBe(base);
	});

	it("设置面板把基础值调大/禁用后生效", () => {
		expect(effectiveToolWatchdogMs(120 * 60_000, "bash", { timeout: 5400 })).toBe(120 * 60_000);
		expect(effectiveToolWatchdogMs(0, "bash", { timeout: 5400 })).toBe(0);
		expect(effectiveToolWatchdogMs(0, "read", undefined)).toBe(0);
		expect(effectiveToolWatchdogMs(-1, "bash", { timeout: 5400 })).toBe(0);
		expect(effectiveToolWatchdogMs(NaN, "bash", undefined)).toBe(0);
	});

	it("余量是非零正数（保证工具先于看门狗超时）", () => {
		expect(TOOL_WATCHDOG_EXPLICIT_GRACE_MS).toBeGreaterThan(0);
	});

	it("持久化往返：设置存盘后重读仍然是同一个值（含 0 = 禁用）", () => {
		const { store, file } = tempStore();
		expect(store.getSettings("c1").toolWatchdogTimeoutMs).toBe(DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS);

		store.saveSettings("c1", { toolWatchdogTimeoutMs: 90 * 60_000 });
		expect(store.getSettings("c1").toolWatchdogTimeoutMs).toBe(90 * 60_000);

		expect(new ClientStateStore(file).getSettings("c1").toolWatchdogTimeoutMs).toBe(90 * 60_000);

		store.saveSettings("c1", { toolWatchdogTimeoutMs: 0 });
		expect(new ClientStateStore(file).getSettings("c1").toolWatchdogTimeoutMs).toBe(0);
	});
});
