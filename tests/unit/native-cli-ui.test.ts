// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeCliPanel, type NativeCliPanelProps } from "../../web/src/components/NativeCliPanel";
import {
	composeToComposer,
	getComposerTarget,
	insertTextAtCursor,
	resetComposerSinks,
} from "../../web/src/composer-bridge";
import { nativeCliArgumentLines } from "../../web/src/native-cli";
import { resolveNativeCliControlResult } from "../../web/src/native-cli-events";
import type { ClientMessage, NativeCliStatus } from "../../web/src/types";

const display = vi.hoisted(() => ({ focus: vi.fn(), mounted: [] as string[], unmounted: [] as string[] }));
vi.mock("../../web/src/components/TermXterm", () => ({
	TermXterm: ({
		terminalId,
		onReady,
		running,
	}: {
		terminalId: string;
		onReady: (handle: unknown) => void;
		running?: boolean;
	}) => {
		useEffect(() => {
			display.mounted.push(terminalId);
			onReady({ focus: display.focus });
			return () => {
				display.unmounted.push(terminalId);
				onReady(null);
			};
		}, [terminalId, onReady]);
		return createElement("div", { "data-terminal": terminalId, "data-running": running });
	},
}));
vi.mock("../../web/src/i18n", () => ({ useT: () => (key: string) => key }));
let root: Root;
let container: HTMLDivElement;
let props: NativeCliPanelProps;
const render = (updates: Partial<NativeCliPanelProps> = {}) => {
	props = { ...props, ...updates };
	act(() => root.render(createElement(NativeCliPanel, { ...props, key: props.conversationId })));
};
const pasteMessages = () =>
	vi
		.mocked(props.send)
		.mock.calls.map(([message]) => message)
		.filter((message) => message.type === "terminal_cli_paste");

beforeEach(() => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	resetComposerSinks();
	display.focus.mockClear();
	display.mounted.length = 0;
	display.unmounted.length = 0;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	props = {
		chat: {
			ready: true,
			terminals: [
				{ id: "cli-a", conversationId: "conv-a", ownerKind: "conversation", running: true, cols: 80, rows: 24 },
			],
		} as any,
		terminal: { register: vi.fn(() => () => {}) },
		send: vi.fn(() => true),
		conversationId: "conv-a",
		nativeCli: { terminalId: "cli-a", config: { preset: "claude" } },
		cwd: "/project",
		active: true,
		onAddFiles: vi.fn(async () => {}),
		pushNotice: vi.fn(),
	};
	render();
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	resetComposerSinks();
});

describe("native CLI conversation display", () => {
	it("embeds only the conversation's terminal, without view tabs or a second composer", () => {
		expect(container.querySelector('[data-terminal="cli-a"]')).not.toBeNull();
		expect(container.querySelector("textarea, select, [role=tab], .native-cli-composer")).toBeNull();
		expect(display.mounted).toEqual(["cli-a"]);
	});
	it("routes file, directory and selected-line references to the exact conversation without Enter", () => {
		const attachments = [
			{ path: "src/app.ts", name: "app.ts", mode: "reference" as const },
			{ path: "src", name: "src", mode: "reference" as const, isDir: true },
			{ path: "src/app.ts", name: "selection", mode: "lines" as const, lines: { start: 7, end: 12 } },
		];
		expect(composeToComposer({ text: "Please inspect", attachments })).toBe(true);
		expect(pasteMessages()).toEqual([
			expect.objectContaining({
				terminalId: "cli-a",
				conversationId: "conv-a",
				ownerKind: "conversation",
				data: "Please inspect",
				attachments,
			}),
		]);
		expect(vi.mocked(props.send).mock.calls.some(([message]) => message.type === "terminal_input")).toBe(false);
	});
	it("accepts quoted text and non-file references through the shared bridge", () => {
		expect(
			composeToComposer({
				attachments: [
					{ path: "", name: "quote", mode: "quote", quote: { text: "selected code" } as any },
					{ path: "https://example.com", name: "Docs", mode: "page" },
					{ path: "", name: "Other conversation", mode: "conversation", conversationId: "other" },
					{ path: "graph-1", name: "Flow", mode: "canvas" },
				],
			}),
		).toBe(true);
		const message = pasteMessages()[0] as any;
		for (const expected of ["https://example.com", "other", "graph-1"]) expect(message.data).toContain(expected);
		expect(message.attachments[0].quote.text).toBe("selected code");
	});
	it("captures the old destination for an upload completed after switching conversations", () => {
		const captured = getComposerTarget()!;
		render({ conversationId: "conv-b", nativeCli: { terminalId: "cli-b", config: { preset: "codex" } } });
		expect(captured.compose({ attachments: [{ path: "", name: "late.png", fileData: "YQ==" }] })).toBe(true);
		expect((pasteMessages().at(-1) as any).conversationId).toBe("conv-a");
		expect(composeToComposer({ text: "new destination" })).toBe(true);
		expect((pasteMessages().at(-1) as any).conversationId).toBe("conv-b");
	});
	it("uses native paste for inserted text and template-fill events", () => {
		expect(insertTextAtCursor("@src/app.ts ")).toBe(true);
		act(() => window.dispatchEvent(new CustomEvent("pi-web:fill", { detail: "inspect carefully" })));
		expect(pasteMessages().map((message) => (message as any).data)).toEqual(["@src/app.ts ", "inspect carefully"]);
	});
	it("unregisters the native composer when hidden and does not intercept other views", () => {
		render({ active: false });
		expect(getComposerTarget()).toBeNull();
		expect(composeToComposer({ text: "other view" })).toBe(false);
	});
	it("forwards original clipboard files while leaving ordinary text paste native", () => {
		const file = new File(["image"], "paste.png", { type: "image/png" });
		const event = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clipboardData", {
			value: { items: [{ kind: "file", getAsFile: () => file }], files: [file] },
		});
		act(() => container.querySelector("[data-terminal]")!.dispatchEvent(event));
		expect(event.defaultPrevented).toBe(true);
		expect(props.onAddFiles).toHaveBeenCalledWith([file]);
		const textEvent = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(textEvent, "clipboardData", { value: { items: [], files: [] } });
		act(() => container.querySelector("[data-terminal]")!.dispatchEvent(textEvent));
		expect(textEvent.defaultPrevented).toBe(false);
	});
	it("restarts an exited CLI only on an explicit action with its original identity", () => {
		render({
			chat: {
				...props.chat,
				terminals: [
					{ id: "cli-a", conversationId: "conv-a", ownerKind: "conversation", running: false, cols: 100, rows: 40 },
				],
			} as any,
		});
		expect(composeToComposer({ text: "unsent" })).toBe(false);
		act(() => container.querySelector("button")!.click());
		expect(props.send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "terminal_create",
				terminalId: "cli-a",
				conversationId: "conv-a",
				ownerKind: "conversation",
				nativeCli: { preset: "claude" },
			}),
		);
	});
});

describe("native CLI session state and control", () => {
	const remote = "ssh://alice@build.example:22/project";
	const showStatus = (status: Partial<NativeCliStatus>) =>
		render({
			cwd: remote,
			nativeCli: { ...props.nativeCli, status: { phase: "running", updatedAt: 1, persistent: true, ...status } },
		});
	const button = (key: string) =>
		Array.from(container.querySelectorAll("button")).find((item) => item.textContent === key)!;
	const controls = () =>
		vi
			.mocked(props.send)
			.mock.calls.map(([message]) => message)
			.filter(
				(message): message is Extract<ClientMessage, { type: "terminal_cli_control" }> =>
					message.type === "terminal_cli_control",
			);
	const reply = (ok = true) => {
		const request = controls().at(-1)!;
		return {
			type: "terminal_cli_control_result" as const,
			requestId: request.requestId,
			terminalId: request.terminalId,
			conversationId: request.conversationId,
			ok,
			error: ok ? undefined : "tmux rejected control",
		};
	};
	it("only shows semantic activity for instrumented CLIs", () => {
		showStatus({ phase: "waiting_input", nativeEvents: false });
		expect(container.querySelector("strong")?.textContent).toBe("nativeCliSession.running");
		expect(container.textContent).toContain("nativeCliSession.processOnly");
		showStatus({ phase: "waiting_approval", nativeEvents: true });
		expect(container.querySelector("strong")?.textContent).toBe("nativeCliSession.waitingApproval");
		expect(container.textContent).not.toContain("nativeCliSession.processOnly");
	});
	it("shows activity, resumability and copies only the native CLI identity", async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		showStatus({ lastActivityAt: 1_700_000_000_000, sessionId: "native-id-not-web-id", resumable: true });
		expect(container.querySelector("time")?.dateTime).toBe("2023-11-14T22:13:20.000Z");
		expect(container.textContent).toContain("nativeCliSession.resumable");
		await act(async () =>
			container.querySelector<HTMLButtonElement>('[aria-label="nativeCliSession.copyId"]')!.click(),
		);
		expect(writeText).toHaveBeenCalledExactlyOnceWith("native-id-not-web-id");
	});
	it("keeps a shared notification viewer limited to status without a PTY, composer or controls", () => {
		showStatus({ sessionId: "native-read-only", resumable: true });
		render({
			chat: {
				...props.chat,
				state: { sharedConversation: { owner: "owner", conversationId: "conv-a", readOnly: true } },
			} as any,
		});
		expect(container.textContent).toContain("native-read-only");
		expect(container.querySelector("[data-terminal]")).toBeNull();
		expect(button("nativeCliSession.stop")).toBeUndefined();
		expect(button("nativeCliSession.detach")).toBeUndefined();
		expect(getComposerTarget()).toBeNull();
		expect(composeToComposer({ text: "do not submit" })).toBe(false);
		expect(controls()).toHaveLength(0);
		expect(pasteMessages()).toHaveLength(0);
	});

	it("waits for ACK, blocks repeated clicks, and displays failure without guessing state", async () => {
		showStatus({});
		act(() => {
			button("nativeCliSession.detach").click();
			button("nativeCliSession.detach").click();
		});
		expect(controls()).toHaveLength(1);
		expect(controls()[0]).toMatchObject({
			terminalId: "cli-a",
			conversationId: "conv-a",
			ownerKind: "conversation",
			action: "detach",
		});
		expect(button("nativeCliSession.stop").disabled).toBe(true);
		expect(container.querySelector("strong")?.textContent).toBe("nativeCliSession.running");
		await act(async () => {
			resolveNativeCliControlResult(reply(false));
		});
		expect(props.pushNotice).toHaveBeenCalledWith("error", "nativeCliSession.controlFailed");
		expect(button("nativeCliSession.stop").disabled).toBe(false);
	});
	it("keeps disconnect, reconnect and explicit stop distinct from process exit", async () => {
		showStatus({ phase: "disconnected" });
		expect(composeToComposer({ text: "unsent" })).toBe(false);
		expect(container.querySelector("strong")?.textContent).toBe("nativeCliSession.disconnected");
		expect(button("nativeCliStart")).toBeUndefined();
		act(() => button("nativeCliSession.reconnect").click());
		expect(controls().at(-1)?.action).toBe("reconnect");
		await act(async () => {
			resolveNativeCliControlResult(reply());
		});
		act(() => button("nativeCliSession.stop").click());
		expect(controls().at(-1)?.action).toBe("stop");
		await act(async () => {
			resolveNativeCliControlResult(reply());
		});
	});
	it("does not show a PTY exit banner for a detached persistent process", () => {
		render({ chat: { ...props.chat, terminals: [{ ...props.chat.terminals[0], running: false }] } as any });
		showStatus({ phase: "disconnected" });
		expect(container.querySelector("[data-terminal]")?.hasAttribute("data-running")).toBe(false);
		expect(button("nativeCliStart")).toBeUndefined();
	});
	it("times out without retrying or changing process state", async () => {
		vi.useFakeTimers();
		try {
			showStatus({});
			act(() => button("nativeCliSession.detach").click());
			await act(async () => {
				await vi.advanceTimersByTimeAsync(15_000);
			});
			expect(controls()).toHaveLength(1);
			expect(props.pushNotice).toHaveBeenCalledWith("error", "nativeCliSession.controlFailed");
			expect(button("nativeCliSession.detach").disabled).toBe(false);
			expect(container.querySelector("strong")?.textContent).toBe("nativeCliSession.running");
		} finally {
			vi.useRealTimers();
		}
	});
	it("ignores a failed ACK after navigation and permits controls after returning", async () => {
		showStatus({});
		act(() => button("nativeCliSession.detach").click());
		const late = reply(false);
		render({ active: false });
		await act(async () => {
			expect(resolveNativeCliControlResult(late)).toBe(false);
		});
		expect(props.pushNotice).not.toHaveBeenCalled();
		render({ active: true });
		expect(button("nativeCliSession.detach").disabled).toBe(false);
		act(() => button("nativeCliSession.detach").click());
		expect(controls()).toHaveLength(2);
		await act(async () => {
			resolveNativeCliControlResult(reply());
		});
	});
	it("cancels a lost socket acknowledgement without retrying when the connection returns", async () => {
		showStatus({});
		act(() => button("nativeCliSession.detach").click());
		const late = reply(false);
		render({ chat: { ...props.chat, ready: false } });
		await act(async () => {
			expect(resolveNativeCliControlResult(late)).toBe(false);
		});
		expect(props.pushNotice).not.toHaveBeenCalled();
		render({ chat: { ...props.chat, ready: true } });
		expect(button("nativeCliSession.detach").disabled).toBe(false);
		expect(controls()).toHaveLength(1);
	});

	it("does not apply a prior conversation's ACK or failure notice to a new owner", async () => {
		showStatus({});
		act(() => button("nativeCliSession.detach").click());
		const late = reply(false);
		render({
			conversationId: "conv-b",
			nativeCli: {
				terminalId: "cli-b",
				config: { preset: "claude" },
				status: { phase: "running", updatedAt: 1, persistent: true },
			},
		});
		await act(async () => {
			expect(resolveNativeCliControlResult(late)).toBe(false);
		});
		expect(props.pushNotice).not.toHaveBeenCalled();
		expect(button("nativeCliSession.detach").disabled).toBe(false);
	});
	it("labels explicit native resume while keeping legacy restart transport", () => {
		showStatus({ phase: "exited", persistent: false, resumable: true });
		act(() => button("nativeCliSession.resume").click());
		expect(props.send).toHaveBeenCalledWith(
			expect.objectContaining({ type: "terminal_create", conversationId: "conv-a", nativeCli: { preset: "claude" } }),
		);
	});
});

describe("CLI argument handling", () => {
	it("preserves literal arguments without shell expansion", () => {
		expect(nativeCliArgumentLines("--flag\r\na b\r\n\r\n$(shell); > x\n")).toEqual(["--flag", "a b", "$(shell); > x"]);
	});
});
