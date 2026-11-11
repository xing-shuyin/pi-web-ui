import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ClientSession } from "../../server/agent-service.js";
import { normalizePathKey } from "../../server/client-state.js";
import { fakeClientSession, protoMethod } from "../helpers/fake-session.js";

type Loose = Record<string, unknown>;
type AnySession = Record<string, any>;

const schedule = protoMethod(ClientSession.prototype, "scheduleSessionsPush") as unknown as (cwd: string) => void;
const cache = (ClientSession as unknown as { sessionInfosCache: Map<string, any> }).sessionInfosCache;

function fake(overrides: Loose = {}) {
	const pushSessionsForCwd = vi.fn<(cwd: string) => Promise<void>>(async () => {});
	const cs = fakeClientSession({
		cwd: "E:\\work\\project-a",
		disposed: false,
		sessionsRequested: true,
		sessionsPushTimers: new Map<string, ReturnType<typeof setTimeout>>(),
		pushSessionsForCwd,
		...overrides,
	});
	return { cs, pushSessionsForCwd };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("turn 结束后补推会话列表", () => {
	// 现象：会话跑完从「运行中」分组移走，历史列表里也没它；推迟推送就是「闪一下才出来」。
	it("首轮立刻推一次（不等节流窗口），推的是会话自己的 cwd", async () => {
		vi.useFakeTimers();
		const { cs, pushSessionsForCwd } = fake();

		schedule.call(cs, "E:\\work\\project-b");
		expect(pushSessionsForCwd).toHaveBeenCalledTimes(1);
		expect(pushSessionsForCwd.mock.calls[0][0]).toBe("E:\\work\\project-b");

		await vi.advanceTimersByTimeAsync(700);
		expect(pushSessionsForCwd).toHaveBeenCalledTimes(2); // 首推 + 尾部合并推
	});

	it("600ms 内的后续触发合并成一次尾部推送（大小写 / 分隔符归一）", async () => {
		vi.useFakeTimers();
		const { cs, pushSessionsForCwd } = fake();

		schedule.call(cs, "E:\\work\\project-b");
		schedule.call(cs, "e:/WORK/project-b");
		schedule.call(cs, "E:\\work\\PROJECT-B");
		expect(pushSessionsForCwd).toHaveBeenCalledTimes(1); // 只有首轮那一次

		await vi.advanceTimersByTimeAsync(700);
		expect(pushSessionsForCwd).toHaveBeenCalledTimes(2); // 尾部只补一次
	});

	it("推送前让该项目的列表缓存失效，避免推出去还是旧列表", async () => {
		vi.useFakeTimers();
		const { cs } = fake();
		const key = normalizePathKey("E:\\work\\project-b");
		cache.set(key, { infos: [], at: Date.now(), complete: true });

		schedule.call(cs, "E:\\work\\project-b");
		expect(cache.has(key)).toBe(false);
		await vi.advanceTimersByTimeAsync(700);
	});

	it("不同 cwd 各自立刻推", async () => {
		vi.useFakeTimers();
		const { cs, pushSessionsForCwd } = fake();

		schedule.call(cs, "E:\\work\\a");
		schedule.call(cs, "E:\\work\\b");
		expect(pushSessionsForCwd).toHaveBeenCalledTimes(2);
	});

	it("客户端没请求过会话列表就不推", async () => {
		vi.useFakeTimers();
		const { cs, pushSessionsForCwd } = fake({ sessionsRequested: false });

		schedule.call(cs, "E:\\work\\project-b");
		await vi.advanceTimersByTimeAsync(700);
		expect(pushSessionsForCwd).not.toHaveBeenCalled();
	});

	it("会话已销毁就不推", async () => {
		vi.useFakeTimers();
		const { cs, pushSessionsForCwd } = fake();

		schedule.call(cs, "E:\\work\\project-b");
		(cs as unknown as AnySession).disposed = true;
		await vi.advanceTimersByTimeAsync(700);
		expect(pushSessionsForCwd).toHaveBeenCalledTimes(1); // 首推已完成，尾部那次被 disposed 拦住
	});

	it("turn_end 分支确实调了补推（防回归）", () => {
		const src = readFileSync(new URL("../../server/agent-service.ts", import.meta.url), "utf8");
		const start = src.indexOf('case "turn_end": {');
		expect(start).toBeGreaterThan(-1);
		const block = src.slice(start, src.indexOf("break;", start));
		expect(block).toContain("scheduleSessionsPush(conv.cwd)");
	});
});
