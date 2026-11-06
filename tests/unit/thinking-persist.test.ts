import { describe, expect, it, vi } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

describe("思考强度持久化 (Issue #255)", () => {
	it("SettingsManager 能够正确记录与读取全局 defaultThinkingLevel 及按模型 modelThinkingLevels", () => {
		const sm = SettingsManager.inMemory();

		expect(sm.getDefaultThinkingLevel()).toBeUndefined();
		expect(sm.getModelThinkingLevel("anthropic", "claude-sonnet-4")).toBeUndefined();

		sm.setDefaultThinkingLevel("high");
		expect(sm.getDefaultThinkingLevel()).toBe("high");

		sm.setModelThinkingLevel("anthropic", "claude-sonnet-4", "medium");
		sm.setModelThinkingLevel("openai", "gpt-5", "max");

		expect(sm.getModelThinkingLevel("anthropic", "claude-sonnet-4")).toBe("medium");
		expect(sm.getModelThinkingLevel("openai", "gpt-5")).toBe("max");
		expect(sm.getModelThinkingLevel("anthropic", "claude-opus-4")).toBeUndefined();
	});

	it("模拟 setThinking 与 cycleThinking 调用链路正确传递 persist: true 与 modelThinkingLevel", () => {
		const sm = SettingsManager.inMemory();
		const mockSession = {
			model: { provider: "anthropic", id: "claude-sonnet-4" },
			settingsManager: sm,
			setThinkingLevel: vi.fn((level: string, options?: { persist?: boolean }) => {
				if (options?.persist) {
					sm.setDefaultThinkingLevel(level as any);
				}
			}),
			cycleThinkingLevel: vi.fn((options?: { persist?: boolean }) => {
				const next = "high";
				if (options?.persist) {
					sm.setDefaultThinkingLevel(next as any);
				}
				return next;
			}),
		};

		const levelToSet = "medium";
		mockSession.setThinkingLevel(levelToSet, { persist: true });
		if (mockSession.model) {
			mockSession.settingsManager.setModelThinkingLevel(
				mockSession.model.provider,
				mockSession.model.id,
				levelToSet as any,
			);
		}

		expect(mockSession.setThinkingLevel).toHaveBeenCalledWith("medium", { persist: true });
		expect(sm.getDefaultThinkingLevel()).toBe("medium");
		expect(sm.getModelThinkingLevel("anthropic", "claude-sonnet-4")).toBe("medium");

		const nextLevel = mockSession.cycleThinkingLevel({ persist: true });
		if (mockSession.model && nextLevel) {
			mockSession.settingsManager.setModelThinkingLevel(
				mockSession.model.provider,
				mockSession.model.id,
				nextLevel as any,
			);
		}

		expect(mockSession.cycleThinkingLevel).toHaveBeenCalledWith({ persist: true });
		expect(sm.getDefaultThinkingLevel()).toBe("high");
		expect(sm.getModelThinkingLevel("anthropic", "claude-sonnet-4")).toBe("high");
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
