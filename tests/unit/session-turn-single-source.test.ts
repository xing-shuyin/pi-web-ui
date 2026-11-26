import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	guardSession,
	isRetiredSession,
	promptSession,
	retireSession,
	runTurn,
	SessionRetiredError,
	steerSession,
} from "../../server/session-turns.js";
import { codeFiles, isShim, sourceOf } from "../helpers/guard-roots.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const SERVER = join(root, "server");

/** 唯一允许直接调 SDK 喂轮回的模块（#958）：搬家前后由 sourceOf 解析。 */
const SINGLE_SOURCE = sourceOf("session-turns");

/**
 * 直连 SDK 喂轮的写法。故意只收「几乎不可能是别的东西」的形式：
 * - `sendUserMessage(`：SDK 独有；
 * - `.session.prompt(` / `.session.steer(`：宿主别名写法；
 * - `s.prompt(` / `s.steer(`：agent-service 里 `const s = conv.session` 的别名。
 */
const RAW_TURN_CALLS = [
	/\bsendUserMessage\(/,
	/\.session\.prompt\(/,
	/\.session\.steer\(/,
	/\bs\.prompt\(/,
	/\bs\.steer\(/,
];

/** 直接给会话字段赋值：换会话只能换 `conv.runtime`（`session` 是只读投影）。 */
const SESSION_ASSIGNMENT = /\b(?:conv|conversation)\.session\s*=[^=]/;

describe("session-turns 是唯一喂轮出口（#958）", () => {
	it("除 session-turns.ts 外没有地方直接调 SDK 的 sendUserMessage / steer / prompt", () => {
		const offenders: string[] = [];
		for (const file of codeFiles()) {
			if (file === SINGLE_SOURCE) continue;
			const text = readFileSync(file, "utf8");
			// 老位置只剩 `export *` 的 shim：本身不含调用，跳过以防 shim 日后变异成误报源。
			if (isShim(text)) continue;
			for (const pattern of RAW_TURN_CALLS) {
				if (pattern.test(text)) offenders.push(`${relative(root, file)} (${pattern})`);
			}
		}
		expect(
			offenders,
			`请改走 packages/keel/src/session-turns.ts 的 promptSession / steerSession / runTurn：\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("两个源码根下都没有任何地方给 conv.session 赋值", () => {
		const offenders: string[] = [];
		for (const file of codeFiles()) {
			const text = readFileSync(file, "utf8");
			if (isShim(text)) continue;
			text.split("\n").forEach((line, index) => {
				if (SESSION_ASSIGNMENT.test(line)) offenders.push(`${relative(root, file)}:${index + 1}`);
			});
		}
		expect(offenders, `换会话请赋值 conv.runtime（session 是只读投影）：\n${offenders.join("\n")}`).toEqual([]);
	});
});

describe("退役会话不再接受一轮输入", () => {
	const makeSession = () =>
		({
			sendUserMessage: vi.fn(async () => {}),
			steer: vi.fn(async () => ({}) as never),
			prompt: vi.fn(async () => {}),
			dispose: vi.fn(),
		}) as any;

	it("guardSession 幂等，dispose 一次即退役", () => {
		const session = makeSession();
		const originalDispose = session.dispose;
		const guarded = guardSession(guardSession(session));
		expect(guarded).toBe(session);
		expect(isRetiredSession(session)).toBe(false);
		session.dispose();
		expect(isRetiredSession(session)).toBe(true);
		// 原 dispose 必须真的跑（不能因为加钩子把清理吞掉），且只包一层。
		expect(originalDispose).toHaveBeenCalledTimes(1);
		expect(guardSession(session)).toBe(session);
		session.dispose();
		expect(isRetiredSession(session)).toBe(true);
	});

	it("dispose 时顺手清掉 SDK 的 extensionRunnerRef（兜住没被补丁命中的 SDK 副本）", () => {
		const ref: { current?: unknown } = { current: { staleMessage: "stale" } };
		const session = Object.assign(makeSession(), { _extensionRunnerRef: ref });
		guardSession(session);
		session.dispose();
		expect(ref.current).toBeUndefined();
	});

	it("三种喂轮方式都在闸门前抛 SessionRetiredError，且不触达 SDK", async () => {
		const session = makeSession();
		guardSession(session);
		retireSession(session);
		await expect(promptSession(session, "hi")).rejects.toBeInstanceOf(SessionRetiredError);
		await expect(promptSession(session, "hi", { deliverAs: "steer" })).rejects.toBeInstanceOf(SessionRetiredError);
		await expect(steerSession(session, "hi")).rejects.toBeInstanceOf(SessionRetiredError);
		await expect(runTurn(session, "hi")).rejects.toBeInstanceOf(SessionRetiredError);
		expect(session.sendUserMessage).not.toHaveBeenCalled();
		expect(session.steer).not.toHaveBeenCalled();
		expect(session.prompt).not.toHaveBeenCalled();
	});

	it("活着的会话原样委托，参数不被改写", async () => {
		const session = makeSession();
		guardSession(session);
		await promptSession(session, "hi", { deliverAs: "followUp" });
		expect(session.sendUserMessage).toHaveBeenCalledWith("hi", { deliverAs: "followUp" });
		await steerSession(session, "steer me", [{ type: "image" }] as never);
		expect(session.steer).toHaveBeenCalledWith("steer me", [{ type: "image" }]);
		await runTurn(session, "run", { expandPromptTemplates: false });
		expect(session.prompt).toHaveBeenCalledWith("run", { expandPromptTemplates: false });
	});

	it("会话整个没了也是同一个 fail-closed 错误（不抛 TypeError）", async () => {
		await expect(promptSession(undefined, "hi")).rejects.toBeInstanceOf(SessionRetiredError);
		await expect(steerSession(undefined, "hi")).rejects.toBeInstanceOf(SessionRetiredError);
		await expect(runTurn(undefined, "hi")).rejects.toBeInstanceOf(SessionRetiredError);
	});

	it("错误自带稳定 code，调用方可据此留队重投", async () => {
		const error = await promptSession(undefined, "hi").catch((err: unknown) => err);
		expect(error).toBeInstanceOf(SessionRetiredError);
		expect((error as SessionRetiredError).code).toBe("session_retired");
	});
});
