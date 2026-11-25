import type { ClockPort, TransportPort } from "../../packages/keel/src/contracts/ports.js";
import type {
	UiBridgePort,
	UiCliInstallResult,
	UiCliProbe,
	UiDialogSurface,
	UiOverlaySurface,
} from "../../packages/keel/src/contracts/ui-bridge.js";
import { UiDialogTable } from "../../packages/keel/src/domains/ui-bridge/dialogs.js";
import { createUiBridgeHandlers, type UiBridgeHandlers } from "../../packages/keel/src/domains/ui-bridge/handlers.js";
import { UiOverlayTable } from "../../packages/keel/src/domains/ui-bridge/overlays.js";
import type { ServerMessage } from "../../packages/keel/src/protocol.js";

export interface FakeClock extends ClockPort {
	advance(ms: number): void;
	/** 还挂着的定时器数：超时清理没做好时它会一直涨。 */
	pendingTimers(): number;
}

/** 可控时钟：`advance` 到点就触发（与 `core-app-turn-edits-wiring` 同款）。 */
export function fakeClock(start = 1_000): FakeClock {
	let now = start;
	const timers: Array<{ at: number; fn: () => void }> = [];
	return {
		now: () => now,
		after: (ms, fn) => {
			const entry = { at: now + ms, fn };
			timers.push(entry);
			return () => {
				const idx = timers.indexOf(entry);
				if (idx >= 0) timers.splice(idx, 1);
			};
		},
		advance(ms: number) {
			now += ms;
			const due = timers.filter((timer) => timer.at <= now);
			for (const timer of due) {
				const idx = timers.indexOf(timer);
				if (idx >= 0) timers.splice(idx, 1);
				timer.fn();
			}
		},
		pendingTimers: () => timers.length,
	};
}

export interface FakeTransport extends TransportPort {
	readonly sent: ServerMessage[];
	close(): void;
	reopen(): void;
}

export function fakeTransport(): FakeTransport {
	const sent: ServerMessage[] = [];
	let closed = false;
	return {
		sent,
		send: (msg) => void sent.push(msg),
		isClosed: () => closed,
		close: () => {
			closed = true;
		},
		reopen: () => {
			closed = false;
		},
	};
}

export interface FakeUiBridgePort extends UiBridgePort {
	readonly installs: number;
	/** 探针口径：测 `env` 真值读取与 `install` 之后的重探。 */
	setProbe(probe: UiCliProbe): void;
	setInstallResult(result: UiCliInstallResult): void;
}

/**
 * 宿主端口的桩：`dialogs` / `overlays` 传**真表**（宿主 `WebUIContext` 里就是内核这两份实例），
 * 安装与探针用可编程的结果，好断言内核出的帧。
 */
export function fakeUiBridgePort(tables: { dialogs: UiDialogSurface; overlays: UiOverlaySurface }): FakeUiBridgePort {
	let installResult: UiCliInstallResult = { ok: true, code: 0, output: "" };
	let probe: UiCliProbe = { piConfigured: false, piAgentInstalled: false };
	let installs = 0;
	return {
		dialogs: tables.dialogs,
		overlays: tables.overlays,
		// 假体默认「这个宿主没有会话级 UI」：扩展不绑（不伪造一个能弹 dialog 的上下文）。
		uiContextFor: () => undefined,
		installCli: async () => {
			installs += 1;
			return installResult;
		},
		probe: () => probe,
		get installs() {
			return installs;
		},
		setProbe: (next) => {
			probe = next;
		},
		setInstallResult: (result) => {
			installResult = result;
		},
	};
}

export interface BridgeHarness {
	handlers: UiBridgeHandlers;
	transport: FakeTransport;
	clock: FakeClock;
	dialogs: UiDialogTable;
	overlays: UiOverlayTable;
	port: FakeUiBridgePort | undefined;
	/** 对话存活表：`alive.delete(id)` = 那条对话已关闭。 */
	alive: Set<string>;
	active: { id: string | undefined };
	flushCount(): number;
}

/** `withPort: false` 模拟宿主没注入 UI 桥：5 个 dialog/overlay/install 成员都应同步抛。 */
export function bridgeHarness(options: { withPort?: boolean; activeConversation?: string } = {}): BridgeHarness {
	const transport = fakeTransport();
	const clock = fakeClock();
	const alive = new Set<string>(options.activeConversation ? [options.activeConversation] : []);
	const active = { id: options.activeConversation as string | undefined };
	const dialogs = new UiDialogTable({ emit: (msg) => void transport.send(msg) });
	const overlays = new UiOverlayTable();
	const port = options.withPort === false ? undefined : fakeUiBridgePort({ dialogs, overlays });
	let flushes = 0;
	const handlers = createUiBridgeHandlers({
		...(port ? { uiBridge: () => port } : {}),
		emit: (msg) => transport.send(msg),
		isClosed: () => transport.isClosed(),
		clock,
		isConversationAlive: (conversationId) => alive.has(conversationId),
		activeConversationId: () => active.id,
		flushSnapshot: () => {
			flushes += 1;
		},
	});
	return { handlers, transport, clock, dialogs, overlays, port, alive, active, flushCount: () => flushes };
}

/** 帧过滤：只看某一类帧，断言时不用手写 type guard。 */
export function frames<T extends ServerMessage["type"]>(
	sent: ServerMessage[],
	type: T,
): Extract<ServerMessage, { type: T }>[] {
	return sent.filter((msg): msg is Extract<ServerMessage, { type: T }> => msg.type === type);
}
