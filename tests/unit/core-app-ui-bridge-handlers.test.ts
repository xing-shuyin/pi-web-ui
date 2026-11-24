import { describe, expect, it } from "vitest";
import { ClientRuntime } from "../../packages/keel/src/app/client-runtime.js";
import { createUiBridgeHandlersFor, type UiBridgeRuntime } from "../../packages/keel/src/app/ui-bridge-handlers.js";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import type { UiBridgePort } from "../../packages/keel/src/contracts/ui-bridge.js";
import { UiDialogTable } from "../../packages/keel/src/domains/ui-bridge/dialogs.js";
import { UiOverlayTable } from "../../packages/keel/src/domains/ui-bridge/overlays.js";
import { Conversation, ConversationRegistry } from "../../packages/keel/src/kernel/conversation/index.js";
import { fakeClock, fakeTransport, fakeUiBridgePort, frames } from "../helpers/ui-bridge.js";

/**
 * 编译期断言：接线（client-runtime 的 `options` 补一个 `uiBridge?` thunk）之后，
 * `ClientRuntime` 本身就能直接喂给 `createUiBridgeHandlersFor`，不需要中间包装。
 */
const _structurallyCompatible = (runtime: ClientRuntime): UiBridgeRuntime => runtime;
void _structurallyCompatible;

function fakeRuntime(options: { withPort?: boolean; conversations?: string[] } = {}) {
	const transport = fakeTransport();
	const clock = fakeClock();
	const registry = new ConversationRegistry<Conversation>();
	for (const id of options.conversations ?? []) {
		registry.add(new Conversation({ id, clientId: "client-1", cwd: "/work", kind: "user", createdAt: 1 }));
	}
	const dialogs = new UiDialogTable({ emit: (msg) => void transport.send(msg) });
	const overlays = new UiOverlayTable();
	const port = options.withPort === false ? undefined : fakeUiBridgePort({ dialogs, overlays });
	let flushes = 0;
	const runtime: UiBridgeRuntime = {
		options: {
			transport,
			clock,
			...(port ? { uiBridge: () => port as UiBridgePort } : {}),
		},
		registry,
		publisher: {
			request: () => {
				flushes += 1;
			},
		},
		activeConversationId: () => registry.activeId() || undefined,
	};
	return { runtime, transport, clock, registry, dialogs, overlays, port, flushCount: () => flushes };
}

describe("UI 桥的 app 装配（createUiBridgeHandlersFor）", () => {
	it("对话存活判定走注册表：对话移除后晚到的回包不再兑现成功", async () => {
		const { runtime, transport, registry } = fakeRuntime({ conversations: ["c-1"] });
		const handlers = createUiBridgeHandlersFor(runtime);

		const promise = handlers.pageCall({ op: "read" }, {}, "c-1");
		const [request] = frames(transport.sent, "page_request");
		expect(request.id).toBe("p-1");

		registry.remove("c-1");
		handlers.resolvePageCall(request.id, true, "late");
		await expect(promise).resolves.toMatchObject({ ok: false });
	});

	it("帧出口就是这条连接的 transport（不出到别的客户端）", async () => {
		const a = fakeRuntime({ conversations: ["c-1"] });
		const b = fakeRuntime({ conversations: ["c-1"] });
		createUiBridgeHandlersFor(a.runtime).pageCall({ op: "read" }, {}, "c-1");
		expect(frames(a.transport.sent, "page_request")).toHaveLength(1);
		expect(frames(b.transport.sent, "page_request")).toHaveLength(0);
	});

	it("没注入端口：dialog/overlay 同步抛；页面/手机照常（它们不需要宿主端口）", async () => {
		const { runtime, transport } = fakeRuntime({ withPort: false, conversations: ["c-1"] });
		const handlers = createUiBridgeHandlersFor(runtime);
		expect(() => handlers.resolveDialog(1, null)).toThrow(CoreEngineNotReadyError);
		expect(() => handlers.handleTuiOverlayCancel(1)).toThrow(CoreEngineNotReadyError);

		const promise = handlers.pageCall({ op: "read" }, {}, "c-1");
		const [request] = frames(transport.sent, "page_request");
		handlers.resolvePageCall(request.id, true, "ok");
		await expect(promise).resolves.toEqual({ ok: true, result: "ok" });
	});

	it("注入端口：内核 handler 与宿主 UI 上下文打在同一份 dialog/overlay 表上", async () => {
		const { runtime, dialogs, overlays, transport } = fakeRuntime({ conversations: ["c-1"] });
		const handlers = createUiBridgeHandlersFor(runtime);

		const opened = dialogs.open("confirm", "继续？", ["确认"]);
		const [dialog] = frames(transport.sent, "dialog");
		handlers.resolveDialog(dialog.id, true);
		await expect(opened).resolves.toBe(true);

		const fed: string[] = [];
		const id = overlays.register({
			feedInput: (data) => void fed.push(data),
			resize: () => {},
			cancel: () => void fed.push("cancel"),
		});
		handlers.handleTuiOverlayInput(id, "k");
		handlers.handleTuiOverlayCancel(id);
		expect(fed).toEqual(["k", "cancel"]);
	});

	it("dispose：挂起表全清 + overlay 全取消（断开时不留 Promise）", async () => {
		const { runtime, transport, overlays } = fakeRuntime({ conversations: ["c-1", "c-2"] });
		const handlers = createUiBridgeHandlersFor(runtime);
		const a = handlers.pageCall({ op: "read" }, {}, "c-1");
		const b = handlers.phoneCall({ op: "tap" }, {}, "c-2");
		const cancelled: string[] = [];
		overlays.register({ feedInput: () => {}, resize: () => {}, cancel: () => void cancelled.push("x") });

		handlers.dispose();
		await expect(a).resolves.toMatchObject({ ok: false });
		await expect(b).resolves.toMatchObject({ ok: false });
		expect(cancelled).toEqual(["x"]);
		expect(frames(transport.sent, "page_request")).toHaveLength(1);
	});
});
