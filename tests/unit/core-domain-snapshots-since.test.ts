import { describe, expect, it } from "vitest";
import { SnapshotPublisher, type SnapshotBuilders } from "../../packages/keel/src/domains/snapshots/publisher.js";
import { snapshotFrameContent, snapshotFrameKey } from "../../packages/keel/src/domains/snapshots/content-key.js";
import type { ServerMessage, UiMessage, UiState } from "../../packages/keel/src/protocol.js";
import type { ClockPort, TransportPort } from "../../packages/keel/src/contracts/ports.js";

class FakeClock implements ClockPort {
	at = 1_000;
	now(): number {
		return this.at;
	}
	after(ms: number, fn: () => void): () => void {
		const timer = setTimeout(fn, ms);
		return () => clearTimeout(timer);
	}
	advance(ms: number): void {
		this.at += ms;
	}
}

class RecordingTransport implements TransportPort {
	readonly frames: ServerMessage[] = [];
	closed = false;
	send(msg: ServerMessage): void {
		this.frames.push(msg);
	}
	isClosed(): boolean {
		return this.closed;
	}
}

function message(id: string, text: string): UiMessage {
	return { id, role: "user", content: [{ type: "text", text }] };
}

/** 真形状的 `snapshot` 帧（`snapshotFrameKey` 只认这个），内容由 `state()` 给。 */
function harness() {
	const clock = new FakeClock();
	const transport = new RecordingTransport();
	let messages: UiMessage[] = [];
	let cwd = "/work";
	let version = 1;
	const builders: SnapshotBuilders = {
		full: (frame) => ({
			type: "snapshot",
			state: {
				clientId: "c1",
				cwd,
				conversationId: frame.conversationId,
				sessionId: "s1",
				rev: frame.rev,
				version,
				messages: [...messages],
				streamingMessage: null,
				isStreaming: false,
				model: null,
				thinkingLevel: "off",
				availableThinkingLevels: [],
				queue: { steering: [], followUp: [] },
				tools: [],
				piConfigured: true,
				piAgentInstalled: true,
				stats: {
					totalMessages: messages.length,
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					cost: 0,
					contextUsage: { tokens: null, contextWindow: 0, percent: null },
				},
			} as UiState,
		}),
		delta: (frame) => builders.full({ ...frame, reason: frame.reason }),
	};
	const publisher = new SnapshotPublisher({ clock, transport, build: builders });
	return {
		publisher,
		transport,
		clock,
		setMessages(next: UiMessage[]): void {
			messages = next;
		},
		setCwd(next: string): void {
			cwd = next;
		},
		bumpVersion(): void {
			version += 1;
		},
	};
}

describe("domains/snapshots · 内容指纹", () => {
	it("同内容同键：rev / version 不算内容", () => {
		const key = (rev: number, version: number): string | undefined =>
			snapshotFrameKey({
				type: "snapshot",
				state: { rev, version, conversationId: "c1", messages: [message("m1", "hi")] } as unknown as UiState,
			});
		expect(key(1, 1)).toBe(key(9, 7));
	});

	it("消息身份变了 → 键变", () => {
		const key = (ids: string[]): string | undefined =>
			snapshotFrameKey({
				type: "snapshot",
				state: { rev: 1, conversationId: "c1", messages: ids.map((id) => message(id, "x")) } as unknown as UiState,
			});
		expect(key(["m1"])).not.toBe(key(["m1", "m2"]));
	});

	it("非 snapshot 帧给不出指纹（调用方退回「按变化出帧」）", () => {
		expect(snapshotFrameKey({ type: "notice", level: "info", text: "x" })).toBeUndefined();
	});

	it("增量帧的身份序列 = 基线 + appended", () => {
		const content = snapshotFrameContent(
			{
				type: "snapshot_delta",
				conversationId: "c1",
				rev: 3,
				baseRev: 2,
				appended: [message("m2", "b")],
				state: { conversationId: "c1", rev: 3, version: 1, streamingMessage: null } as never,
			},
			["m1"],
		);
		expect(content?.ids).toEqual(["m1", "m2"]);
	});
});

describe("domains/snapshots · SnapshotPublisher 的 since（get_state{rev}）", () => {
	it("since 命中本 sink 基线且内容未变 → 一帧都不发", () => {
		const h = harness();
		h.publisher.switchConversation("c1");
		const first = h.publisher.flush();
		const baselineRev = first?.rev ?? 0;
		expect(h.transport.frames).toHaveLength(1);
		h.clock.advance(1_000);
		expect(h.publisher.flush({ since: baselineRev })).toEqual({
			kind: "skip",
			rev: expect.any(Number),
			reason: "unchanged",
		});
		expect(h.transport.frames).toHaveLength(1);
	});

	it("since 对不上（客户端落后 / 丢了状态）→ 补一帧全量", () => {
		const h = harness();
		h.publisher.switchConversation("c1");
		h.publisher.flush();
		h.clock.advance(1_000);
		expect(h.publisher.flush({ since: 1 })?.kind).toBe("full");
		expect(h.transport.frames).toHaveLength(2);
		expect(h.transport.frames[1]?.type).toBe("snapshot");
	});

	it("since 命中但内容变了 → 照发", () => {
		const h = harness();
		h.publisher.switchConversation("c1");
		const baselineRev = h.publisher.flush()?.rev ?? 0;
		h.setMessages([message("m1", "new")]);
		h.clock.advance(1_000);
		expect(h.publisher.flush({ since: baselineRev })?.kind).toBe("delta");
		expect(h.transport.frames).toHaveLength(2);
	});

	it("内容没变就不发：主动 flush 也不重发（issue #965）", () => {
		const h = harness();
		h.publisher.switchConversation("c1");
		h.publisher.flush();
		h.clock.advance(1_000);
		expect(h.publisher.flush()?.kind).toBe("skip");
		expect(h.transport.frames).toHaveLength(1);
		// 只换「版本号 / cwd」以外什么都没变 → 仍然不发。
		h.bumpVersion();
		h.clock.advance(1_000);
		expect(h.publisher.flush()?.kind).toBe("skip");
		expect(h.transport.frames).toHaveLength(1);
	});

	it("工作区变了 → 照发（cwd 属于内容）", () => {
		const h = harness();
		h.publisher.switchConversation("c1");
		h.publisher.flush();
		h.setCwd("/other");
		h.clock.advance(1_000);
		expect(h.publisher.flush()?.kind).toBe("delta");
		expect(h.transport.frames).toHaveLength(2);
	});

	it("换对话消耗一个版本号：新对话的第一帧 rev 不是 1，旧 rev 从此对不上", () => {
		const h = harness();
		h.publisher.switchConversation("c1");
		const first = h.publisher.flush();
		h.clock.advance(1_000);
		h.publisher.switchConversation("c2");
		const second = h.publisher.flush();
		expect(second?.kind).toBe("full");
		expect(second?.rev).toBeGreaterThan(first?.rev ?? 0);
		// 客户端拿着 c1 的 rev 来要 c2 的状态：必须补全量，绝不能当成「命中」。
		h.clock.advance(1_000);
		expect(h.publisher.flush({ since: first?.rev })?.kind).toBe("full");
	});
});
