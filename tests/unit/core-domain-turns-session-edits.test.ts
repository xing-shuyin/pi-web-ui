import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createSessionEditor, type EditSessionHost } from "../../packages/keel/src/adapters/sdk/session-edits.js";
import { projectSessionMessages } from "../../packages/keel/src/adapters/sdk/view.js";
import type { TurnCapableSession } from "../../packages/keel/src/contracts/session.js";

type AgentMessages = TurnCapableSession["messages"];

/** 只给出窄面真正会碰的那几项：条目树是真的 `SessionManager`，会话动作是桩。 */
function fakeHost(manager: SessionManager) {
	let messages: AgentMessages = manager.buildSessionProjection().messages;
	const reload = vi.fn(async () => {});
	const sendCustomMessage = vi.fn(async () => {});
	const host: EditSessionHost = {
		get isStreaming() {
			return false;
		},
		get sessionFile() {
			return manager.getSessionFile();
		},
		sessionManager: manager,
		abort: async () => {},
		clearQueue: () => ({ steering: [], followUp: [] }),
		reload,
		refreshContext: () => {
			messages = manager.buildSessionProjection().messages;
		},
		sendCustomMessage,
		get messages() {
			return messages as NonNullable<EditSessionHost["messages"]>;
		},
	};
	return { host, reload, sendCustomMessage };
}

function appendTurn(manager: SessionManager, timestamp = 1): { user: string; assistant: string } {
	const user = manager.appendMessage({ role: "user", content: "question", timestamp });
	const assistant = manager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: `call-${timestamp}`, name: "schedule", arguments: {} }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		stopReason: "toolUse",
		timestamp: timestamp + 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	return { user, assistant };
}

describe("adapters/sdk · 消息编辑窄面", () => {
	it("uiIds() 与出帧投影同一套编号（两处不会漂）", () => {
		const manager = SessionManager.inMemory();
		appendTurn(manager, 10);
		appendTurn(manager, 20);
		const { host } = fakeHost(manager);
		const editor = createSessionEditor(host);

		const projected = projectSessionMessages({
			messages: host.messages,
			isStreaming: false,
			dispose: () => {},
		} as TurnCapableSession);
		expect([...editor.uiIds().values()]).toEqual(projected.map((message) => message.id));
	});

	it("hideEntry + rebuildMessages：消息从模型上下文里真的消失", () => {
		const manager = SessionManager.inMemory();
		const { assistant } = appendTurn(manager);
		const { host } = fakeHost(manager);
		const editor = createSessionEditor(host);

		editor.hideEntry(assistant);
		editor.rebuildMessages();

		expect(editor.agentMessages().map((message) => message.role)).toEqual(["user"]);
		expect(editor.uiIds().has(assistant)).toBe(false);
	});

	it("branch + 重问标记：截断后的路径只剩基准之前的内容", () => {
		const manager = SessionManager.inMemory();
		const first = appendTurn(manager, 1);
		appendTurn(manager, 10);
		const { host } = fakeHost(manager);
		const editor = createSessionEditor(host);

		const base = editor.entry(first.assistant);
		expect(base?.id).toBe(first.assistant);
		editor.branch(first.assistant);
		editor.appendCustomEntry("pi-web-ui:reask", { version: 1 });

		expect(editor.leafId()).not.toBe(first.assistant);
		expect(editor.branchEntries().map((entry) => entry.id)).toEqual([first.user, first.assistant, editor.leafId()]);
		expect(editor.branchEntries().some((entry) => entry.type === "custom")).toBe(true);
	});

	it("restoreSessionFile：叶指针回到盘上的那份（分支只在内存里动）", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-reask-"));
		try {
			const manager = SessionManager.create(dir, dir);
			const { user, assistant } = appendTurn(manager);
			const sessionFile = manager.getSessionFile();
			const { host } = fakeHost(manager);
			const editor = createSessionEditor(host);

			manager.branch(user);
			expect(editor.leafId()).toBe(user);

			editor.restoreSessionFile(sessionFile);

			expect(editor.leafId()).toBe(assistant);
			expect(editor.agentMessages().map((message) => message.role)).toEqual(["user", "assistant"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("回滚只丢内存：已落盘的删除（appendFileSync）不会因 setSessionFile 回来", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-reask-persist-"));
		try {
			const manager = SessionManager.create(dir, dir);
			const { assistant } = appendTurn(manager);
			const sessionFile = manager.getSessionFile();
			const { host } = fakeHost(manager);
			const editor = createSessionEditor(host);

			editor.hideEntry(assistant);
			editor.restoreSessionFile(sessionFile);
			editor.rebuildMessages();

			expect(editor.agentMessages().map((message) => message.role)).toEqual(["user"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("没有会话文件时 restoreSessionFile 不动内存树（老口径）", () => {
		const manager = SessionManager.inMemory();
		const { assistant } = appendTurn(manager);
		const { host } = fakeHost(manager);
		const editor = createSessionEditor(host);

		editor.hideEntry(assistant);
		editor.restoreSessionFile(undefined);
		editor.rebuildMessages();

		expect(editor.agentMessages().map((message) => message.role)).toEqual(["user"]);
	});

	it("sendCustomMessage / reload 逐位转交，条目树查询是同步快照", async () => {
		const manager = SessionManager.inMemory();
		const { user } = appendTurn(manager);
		const { host, reload, sendCustomMessage } = fakeHost(manager);
		const editor = createSessionEditor(host);

		expect(editor.contextEntries().map((entry) => entry.id)).toEqual([user, expect.any(String)]);
		expect(editor.entry("missing")).toBeUndefined();
		expect(editor.isRetrying?.()).toBe(false);
		expect(editor.thinkingLevel).toBe("off");

		await editor.sendCustomMessage(
			{ customType: "manual-retry", content: "重试", display: false },
			{ triggerTurn: true },
		);
		await editor.reload();

		expect(sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "manual-retry", display: false }),
			{ triggerTurn: true },
		);
		expect(reload).toHaveBeenCalled();
	});
});
