import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";

describe("switchConversation 性能与快速切换优化 (#switch-conv-perf)", () => {
	it("行为验证 switchConversation 先 flushSnapshot 和 transition_progress done，后 pushSettings", async () => {
		const calls: string[] = [];
		const conv1 = { id: "c1", cwd: "/test" } as any;
		const conv2 = { id: "c2", cwd: "/test" } as any;
		const cs: any = fakeClientSession();
		cs.activeId = "c1";
		cs.cwd = "/test";
		cs.convs = new Map([
			["c1", conv1],
			["c2", conv2],
		]);
		Object.defineProperty(cs, "conv", { get: () => cs.convs.get(cs.activeId) });
		cs.displaceActive = vi.fn().mockReturnValue(null);
		cs.webUi = { refresh: vi.fn() };
		cs.emitConversations = vi.fn();
		cs.goalSvc = { emitGoalStatus: vi.fn() };
		cs.pushTerminals = vi.fn();
		cs.flushSnapshot = vi.fn(() => calls.push("flushSnapshot"));
		cs.emit = vi.fn((msg: any) => {
			if (msg.type === "transition_progress" && msg.phase === "done") {
				calls.push("transition_done");
			}
		});
		cs.pushSlashCommands = vi.fn();
		cs.notifyConversationChanged = vi.fn();
		cs.pushSettings = vi.fn(() => calls.push("pushSettings"));

		await cs.switchConversation("c2");

		expect(calls).toEqual(["flushSnapshot", "transition_done", "pushSettings"]);
	});

	it("静态保障：遇到不存在的对话发送 transition_progress error 提示且释放旧 Git watcher", () => {
		const src = readFileSync(join(__dirname, "../../server/agent-service.ts"), "utf-8");
		const switchConvStart = src.indexOf("async switchConversation(id: string): Promise<void> {");
		expect(switchConvStart).toBeGreaterThan(0);
		const switchConvEnd = src.indexOf("private shownInRunningList(conv: Conversation): boolean {", switchConvStart);
		expect(switchConvEnd).toBeGreaterThan(switchConvStart);

		const switchConvBody = src.slice(switchConvStart, switchConvEnd);

		// 检查 1: 遇到不存在的对话发送 transition_progress error 提示
		expect(switchConvBody).toContain('type: "transition_progress"');
		expect(switchConvBody).toContain('phase: "error"');

		// 检查 2: 跨项目切换时调用 unwatchGit 释放旧工作区 Git watcher
		expect(switchConvBody).toContain("this.files.unwatchGit()");
	});

	it("refreshSessionsOnSwitch 使用 SESSION_INFO_CACHE_TTL (30s) 而不是粗暴的 2 秒", () => {
		const src = readFileSync(join(__dirname, "../../server/agent-service.ts"), "utf-8");
		const refreshStart = src.indexOf("private refreshSessionsOnSwitch(): void {");
		expect(refreshStart).toBeGreaterThan(0);
		const refreshEnd = src.indexOf("private async pushSessions(): Promise<void> {", refreshStart);
		const refreshBody = src.slice(refreshStart, refreshEnd);

		expect(refreshBody).toContain("ClientSession.SESSION_INFO_CACHE_TTL");
		expect(refreshBody).not.toContain("2_000");
	});

	it("switchSession 在跨项目打开历史会话时也会调用 unwatchGit", () => {
		const src = readFileSync(join(__dirname, "../../server/agent-service.ts"), "utf-8");
		const switchSessionStart = src.indexOf("async switchSession(path: string,");
		expect(switchSessionStart).toBeGreaterThan(0);
		const targetCwdIdx = src.indexOf("this.cwd = targetCwd;", switchSessionStart);
		expect(targetCwdIdx).toBeGreaterThan(switchSessionStart);

		const sliceAroundTargetCwd = src.slice(targetCwdIdx, targetCwdIdx + 200);
		expect(sliceAroundTargetCwd).toContain("this.files.unwatchGit();");
	});
});
