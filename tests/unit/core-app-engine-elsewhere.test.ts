import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Conversation } from "../../packages/keel/src/kernel/conversation/index.js";
import type { ClientRuntime } from "../../packages/keel/src/app/client-runtime.js";
import type { FrameSender } from "../../packages/keel/src/app/core-engine.js";
import {
	findSessionOwner as findElsewhereOwner,
	listExternalRunning,
} from "../../packages/keel/src/app/engine-elsewhere.js";
import { findSessionOwner as findPortOwner } from "../../packages/keel/src/app/engine-coordination.js";

const WORK = resolve("/fake/work");
const HELD = resolve("/fake/work/sessions/held.jsonl");

/** 只喂 `registry.list()`：占用查询与「别处」列表读的就是这一份事实。 */
function runtimeOf(convs: readonly Conversation[]): ClientRuntime {
	return { registry: { list: () => [...convs] } } as unknown as ClientRuntime;
}

function conv(init: { id?: string; title?: string; sessionFile?: string; running?: boolean } = {}): Conversation {
	const conversation = new Conversation({
		id: init.id ?? "c-1",
		clientId: "owner",
		cwd: WORK,
		kind: "user",
		createdAt: 1,
		title: init.title ?? "hi",
		...(init.sessionFile === undefined ? {} : { sessionFile: init.sessionFile }),
	});
	if (init.running) conversation.beginTurn(2);
	return conversation;
}

function socketSet(): Set<FrameSender> {
	return new Set<FrameSender>([(() => {}) as unknown as FrameSender]);
}

describe("findSessionOwner · 转录占用查询（单源 = app/engine-elsewhere.ts）", () => {
	it("对方在线但空闲：也报 connected（连接期据此落空白对话，不续别人的转录）", () => {
		const runtimes = new Map<string, ClientRuntime>([["A", runtimeOf([conv({ sessionFile: HELD })])]]);
		const sockets = new Map<string, Set<FrameSender>>([["A", socketSet()]]);

		expect(findPortOwner(runtimes, sockets, HELD, "B")).toEqual({
			title: "hi",
			isStreaming: false,
			connected: true,
			clientId: "A",
			conversationId: "c-1",
		});
	});

	it("对方断线但这一轮还在跑：持有方仍要报出来（isStreaming=true，connected=false）", () => {
		const runtimes = new Map<string, ClientRuntime>([
			["A", runtimeOf([conv({ title: "手机端发起的任务", sessionFile: HELD, running: true })])],
		]);
		const sockets = new Map<string, Set<FrameSender>>();

		const owner = findPortOwner(runtimes, sockets, HELD, "B");
		expect(owner?.clientId).toBe("A");
		expect(owner?.connected).toBe(false);
		expect(owner?.isStreaming).toBe(true);
	});

	it("对方断线且已空闲：残骸不挡路（connected / isStreaming 都为 false，调用方自己决定是否续）", () => {
		const runtimes = new Map<string, ClientRuntime>([["A", runtimeOf([conv({ sessionFile: HELD })])]]);
		const sockets = new Map<string, Set<FrameSender>>();

		const owner = findPortOwner(runtimes, sockets, HELD, "B");
		expect(owner).not.toBeNull();
		expect(owner?.connected).toBe(false);
		expect(owner?.isStreaming).toBe(false);
	});

	it("排除自己：excludeClientId 命中的持有方不算占用", () => {
		const runtimes = new Map<string, ClientRuntime>([["A", runtimeOf([conv({ sessionFile: HELD })])]]);
		const sockets = new Map<string, Set<FrameSender>>([["A", socketSet()]]);

		expect(findPortOwner(runtimes, sockets, HELD, "A")).toBeUndefined();
		expect(findElsewhereOwner(runtimes, sockets, HELD, "A")).toBeNull();
	});

	it("dispatch 端口只是命名适配：与 engine-elsewhere 的判定逐字段一致（不另写一套 if）", () => {
		const runtimes = new Map<string, ClientRuntime>([
			["A", runtimeOf([conv({ title: "被占用的", sessionFile: HELD, running: true })])],
		]);
		const sockets = new Map<string, Set<FrameSender>>([["A", socketSet()]]);

		const source = findElsewhereOwner(runtimes, sockets, HELD, "B");
		const port = findPortOwner(runtimes, sockets, HELD, "B");
		expect(port).toEqual({
			title: source?.title,
			isStreaming: source?.isStreaming,
			connected: source?.connected,
			clientId: source?.ownerId,
			conversationId: source?.conversationId,
		});
	});
});

describe("listExternalRunning · 空闲持有方的行不能因为自己续了同一份转录就消失", () => {
	const depsOf = (
		runtimes: Map<string, ClientRuntime>,
		sockets: ReadonlyMap<string, Set<FrameSender>>,
		offlineSince: ReadonlyMap<string, number> = new Map(),
	) => ({ runtimes, sockets, offlineSince });

	it("对方在线且空闲时行照样下发（isStreaming=false，带 owner/convId）", () => {
		const runtimes = new Map<string, ClientRuntime>([
			["A", runtimeOf([conv({ sessionFile: HELD })])],
			["B", runtimeOf([conv({ title: "新对话", sessionFile: resolve("/fake/work/sessions/blank.jsonl") })])],
		]);
		const sockets = new Map<string, Set<FrameSender>>([
			["A", socketSet()],
			["B", socketSet()],
		]);

		const rows = listExternalRunning(depsOf(runtimes, sockets), "B", 60_000);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ owner: "A", convId: "c-1", isStreaming: false, title: "hi" });
	});

	it("出帧那一侧持有的就是同一份转录时不下发（同一份转录不算「另一处」）", () => {
		const runtimes = new Map<string, ClientRuntime>([
			["A", runtimeOf([conv({ sessionFile: HELD })])],
			["B", runtimeOf([conv({ title: "新对话", sessionFile: HELD })])],
		]);
		const sockets = new Map<string, Set<FrameSender>>([
			["A", socketSet()],
			["B", socketSet()],
		]);

		expect(listExternalRunning(depsOf(runtimes, sockets), "B", 60_000)).toEqual([]);
	});

	it("离线持有方在宽限期内仍下发（标 ownerOffline），断线但还在跑的行也留着", () => {
		const runtimes = new Map<string, ClientRuntime>([
			["A", runtimeOf([conv({ title: "手机端发起的任务", sessionFile: HELD, running: true })])],
		]);
		const now = Date.now();
		const rows = listExternalRunning(depsOf(runtimes, new Map(), new Map([["A", now]])), "B", 60_000);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ owner: "A", ownerOffline: true, isStreaming: true });
	});
});
