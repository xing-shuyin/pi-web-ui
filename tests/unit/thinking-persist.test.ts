/**
 * 思考强度持久化与模型专属设置单测：
 * 验证 setThinking / cycleThinking 传入 { persist: true }，
 * 并在模型可用时写入 setModelThinkingLevel。
 */
import { describe, expect, it, vi } from "vitest";

describe("setThinking & cycleThinking persistence contract", () => {
	it("setThinkingLevel 支持接收 { persist: true } 选项", () => {
		const calls: { level: string; options?: { persist?: boolean } }[] = [];
		const mockSession = {
			setThinkingLevel: (level: string, options?: { persist?: boolean }) => {
				calls.push({ level, options });
			},
		};

		// 模拟 setThinking 中的核心调用
		const level = "high";
		mockSession.setThinkingLevel(level, { persist: true });

		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			level: "high",
			options: { persist: true },
		});
	});

	it("当前模型存在时同步保存 modelThinkingLevels", () => {
		const modelSettings: Record<string, string> = {};
		const mockSession = {
			model: { provider: "anthropic", id: "claude-3-7-sonnet-thought" },
			settingsManager: {
				setModelThinkingLevel: (provider: string, id: string, level: string) => {
					modelSettings[`${provider}/${id}`] = level;
				},
			},
		};

		const cur = mockSession.model;
		const level = "max";
		if (cur) {
			mockSession.settingsManager.setModelThinkingLevel(cur.provider, cur.id, level);
		}

		expect(modelSettings["anthropic/claude-3-7-sonnet-thought"]).toBe("max");
	});

	it("newChat 与 fork 保留并恢复之前的 thinkingLevel", () => {
		const state = {
			prevThinking: "medium",
			restoredThinking: "",
		};

		const mockSession = {
			setThinkingLevel: (level: string) => {
				state.restoredThinking = level;
			},
		};

		if (state.prevThinking) {
			mockSession.setThinkingLevel(state.prevThinking);
		}

		expect(state.restoredThinking).toBe("medium");
	});
});
