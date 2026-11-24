import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createSessionSurface, type SessionSurfaceOptions } from "../../packages/keel/src/app/session-surface.js";
import type { SessionRegistry } from "../../packages/keel/src/app/session-registry.js";
import type { TransportPort } from "../../packages/keel/src/contracts/ports.js";
import type { SettingsStorePort } from "../../packages/keel/src/contracts/settings-store.js";
import {
	ConversationPinIndex,
	createSessionPins,
	mergePinState,
} from "../../packages/keel/src/domains/sessions/index.js";
import { Conversation, ConversationRegistry } from "../../packages/keel/src/kernel/conversation/index.js";
import type { ConversationSummary, ServerMessage } from "../../server/protocol.js";

const CWD = "/p/demo";
// 钉子按  后的绝对路径记账，断言必须同一口径（Windows 的分隔符不同）。
const RESOLVED_SESSION_FILE = resolve(CWD, "sessions/a.jsonl");

function pinnedStore(): SettingsStorePort & { pinned: Map<string, boolean> } {
	const pinned = new Map<string, boolean>();
	const key = (cwd: string, file: string) => `${cwd}::${file}`;
	return {
		dataDir: "/data",
		pinned,
		setSessionPinned: (cwd: string, file: string, value: boolean) =>
			void (value ? pinned.set(key(cwd, file), true) : pinned.delete(key(cwd, file))),
		isSessionPinned: (cwd: string, file: string) => pinned.get(key(cwd, file)) === true,
	} as unknown as SettingsStorePort & { pinned: Map<string, boolean> };
}

function fakeTransport() {
	const sent: ServerMessage[] = [];
	const port: TransportPort = { send: (msg) => void sent.push(msg), isClosed: () => false };
	return { sent, port };
}

function conversationsOf(sent: ServerMessage[]): ConversationSummary[] {
	for (let i = sent.length - 1; i >= 0; i -= 1) {
		const msg = sent[i];
		if (msg.type === "conversations") return msg.conversations;
	}
	throw new Error("没有发出 conversations 帧");
}

describe("ConversationPinIndex · 运行列表内存态", () => {
	it("钉住一定带上 listed；取消钉住保留 listed（按常规规则处理）", () => {
		const index = new ConversationPinIndex();

		index.setPinned("c1", true);
		expect(index.stateOf("c1")).toEqual({ pinned: true, listed: true });

		index.setPinned("c1", false);
		expect(index.stateOf("c1")).toEqual({ pinned: false, listed: true });

		index.retain(new Set(["c1"]));
		expect(index.stateOf("c1")).toEqual({ pinned: false, listed: true });

		index.retain(new Set());
		expect(index.stateOf("c1")).toBeUndefined();
	});

	it("markListed 不改动钉子", () => {
		const index = new ConversationPinIndex();
		index.setPinned("c1", true);
		index.markListed("c2");

		expect(index.stateOf("c1")).toEqual({ pinned: true, listed: true });
		expect(index.stateOf("c2")).toEqual({ pinned: false, listed: true });
	});

	it("合流：内存记过就听内存，否则问磁盘钉子；钉住视为已列入", () => {
		expect(mergePinState(undefined, true)).toEqual({ pinned: true, listed: true });
		expect(mergePinState(undefined, false)).toEqual({ pinned: false, listed: false });
		expect(mergePinState({ pinned: false, listed: true }, true)).toEqual({ pinned: false, listed: true });
		expect(mergePinState({ pinned: true, listed: false }, false)).toEqual({ pinned: true, listed: true });
	});
});

describe("setConversationPinned · 磁盘钉子与内存态一起真", () => {
	function harness() {
		const store = pinnedStore();
		const transport = fakeTransport();
		const registry = new ConversationRegistry<Conversation>();
		const conv = new Conversation({
			id: "c1",
			clientId: "cl",
			cwd: CWD,
			kind: "user",
			createdAt: 1_000,
			sessionFile: RESOLVED_SESSION_FILE,
		});
		registry.add(conv);
		registry.activate(conv.id);
		const pins = new ConversationPinIndex();
		const handler = createSessionPins({
			registry,
			store: () => store,
			frames: { flush: () => {}, pushSessions: () => {} },
			cwd: () => CWD,
			notice: (level, text) => void transport.sent.push({ type: "notice", level, text } as ServerMessage),
			pins,
			pushConversations: () => {
				transport.sent.push({ type: "conversations", conversations: [], activeId: conv.id } as ServerMessage);
			},
		});
		return { store, transport, registry, conv, pins, handler };
	}

	it("钉住：写存储 + 内存态 pinned/listed + 推 conversations 帧", async () => {
		const h = harness();

		await h.handler.setConversationPinned("c1", true);

		expect(h.store.isSessionPinned(CWD, RESOLVED_SESSION_FILE)).toBe(true);
		expect(h.pins.stateOf("c1")).toEqual({ pinned: true, listed: true });
		expect(h.transport.sent.some((msg) => msg.type === "conversations")).toBe(true);
		expect(h.transport.sent.at(-1)).toMatchObject({ type: "notice", level: "info" });
	});

	it("取消钉住：磁盘钉子清掉、pinned 归零、listed 保留", async () => {
		const h = harness();
		await h.handler.setConversationPinned("c1", true);

		await h.handler.setConversationPinned("c1", false);

		expect(h.store.isSessionPinned(CWD, RESOLVED_SESSION_FILE)).toBe(false);
		expect(h.pins.stateOf("c1")).toEqual({ pinned: false, listed: true });
	});

	it("子代理对话：不参与钉住（也不写存储）", async () => {
		const h = harness();
		const sub = new Conversation({
			id: "c2",
			clientId: "cl",
			cwd: CWD,
			kind: "subagent",
			createdAt: 2_000,
			parentId: "c1",
			sessionFile: join(CWD, "sessions/sub.jsonl"),
		});
		h.registry.add(sub);

		await h.handler.setConversationPinned("c2", true);

		expect(h.store.isSessionPinned(CWD, join(CWD, "sessions/sub.jsonl"))).toBe(false);
		expect(h.pins.stateOf("c2")).toBeUndefined();
	});

	it("pinSession（按路径）：同一份转录开着的对话，内存态跟着变", async () => {
		const h = harness();

		await h.handler.pinSession(RESOLVED_SESSION_FILE, true);

		expect(h.pins.stateOf("c1")).toEqual({ pinned: true, listed: true });

		await h.handler.pinSession(RESOLVED_SESSION_FILE, false);

		expect(h.pins.stateOf("c1")).toEqual({ pinned: false, listed: true });
	});
});

describe("session-surface · conversations 帧真的带出 pinned", () => {
	function makeSurface(store: SettingsStorePort | undefined, withTransport = true) {
		const dir = mkdtempSync(join(tmpdir(), "keel-surface-"));
		const transport = fakeTransport();
		const registry = new ConversationRegistry<Conversation>();
		const conv = new Conversation({
			id: "c1",
			clientId: "cl",
			cwd: CWD,
			kind: "user",
			createdAt: 1_000,
			sessionFile: RESOLVED_SESSION_FILE,
		});
		registry.add(conv);
		registry.activate(conv.id);
		const options: SessionSurfaceOptions = {
			clientId: "cl",
			registry,
			// 只用到 `get()`：不真开会话（帧里 messageCount 归零、isStreaming 跟相位走）。
			sessions: { get: () => undefined } as unknown as SessionRegistry,
			...(store ? { store: () => store } : {}),
			...(withTransport ? { transport: () => transport.port } : {}),
			cwd: () => CWD,
			roots: () => [],
			setWorkspace: () => {},
			createConversation: (init) =>
				new Conversation({
					id: `c-${registry.size() + 1}`,
					clientId: "cl",
					cwd: init.cwd ?? CWD,
					kind: init.kind ?? "user",
					createdAt: 1_000,
					...(init.sessionFile ? { sessionFile: init.sessionFile } : {}),
				}),
			frames: { flush: () => {}, pushSessions: () => {}, refreshSessionsFor: async () => {} },
			onActivated: () => {},
			notice: () => {},
			isClosed: () => false,
		};
		const surface = createSessionSurface(options);
		return { dir, surface, transport, registry, conv };
	}

	it("钉住后帧里 pinned=true 且行归属 open；取消钉住后 pinned 消失但行还在", async () => {
		const store = pinnedStore();
		const { dir, surface, transport, registry } = makeSurface(store);
		try {
			await surface.pins().setConversationPinned("c1", true);
			expect(conversationsOf(transport.sent)).toEqual([
				expect.objectContaining({ id: "c1", pinned: true, rowKind: "open" }),
			]);

			await surface.pins().setConversationPinned("c1", false);
			const rows = conversationsOf(transport.sent);
			expect(rows.map((row) => row.id)).toEqual(["c1"]);
			expect(rows[0]?.pinned).toBeUndefined();
			expect(registry.get("c1")?.meta.sessionFile).toBe(RESOLVED_SESSION_FILE);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("磁盘上已有钉子（重开进程）：内存态没记过也照实出 pinned", () => {
		const store = pinnedStore();
		store.setSessionPinned(CWD, RESOLVED_SESSION_FILE, true);
		const { dir, surface, transport } = makeSurface(store);
		try {
			surface.conversations().push();

			expect(conversationsOf(transport.sent)).toEqual([
				expect.objectContaining({ id: "c1", pinned: true, rowKind: "open" }),
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("没有出帧通道：钉住照样成立（只算内存态），不谎报已发送", async () => {
		const store = pinnedStore();
		const { dir, surface, transport } = makeSurface(store, false);
		try {
			await surface.pins().setConversationPinned("c1", true);
			surface.conversations().push();

			expect(store.isSessionPinned(CWD, RESOLVED_SESSION_FILE)).toBe(true);
			expect(transport.sent).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
