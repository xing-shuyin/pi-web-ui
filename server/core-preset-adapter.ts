import type { ChatModeTranscript } from "../packages/keel/src/adapters/sdk/chat-mode.js";
import type { PresetEntryResult, PresetTranscriptPort } from "../packages/keel/src/contracts/presets.js";
import { appendModeEntry, MODE_ENTRY_TYPES } from "./chat-mode-entries.js";
import { readPermissionFromSession } from "./permission-preset.js";

/**
 * 宿主侧 `PresetTranscriptPort`：会话级**权限预设**条目的读写。
 *
 * 内核（`app/preset-handlers.ts` 的 `setPermissionPreset`）负责校验、内存投影、快照与公告；
 * 这里只做一件事——把 `permission/preset` 条目写进 / 读回 SDK 的 append-only 转录树。
 * 读写用的是**同一份**单源（`server/chat-mode-entries.ts` 的三态写侧、`permission-preset.ts` 的叶链读侧），
 * 与 `plan/mode` / `delegate/mode` 完全同一套机制（issues #968 / #979）。
 *
 * 本适配器不抛：拿不到转录（会话开不起来 / 已退役）= 「写不进去」，按三态的 `failed` 交给内核，
 * 内核那边保持旧值并如实告知（绝不把「没写盘」装成「已切换」）。
 */
export interface CorePresetSinks {
	/** 该对话已经开着的会话（同步；没开会话 = `undefined`，读回按「没有条目」处理）。 */
	transcriptOf(conversationId?: string): ChatModeTranscript | undefined;
	/** 该对话的会话（没开就开一个）：条目要写转录，所以必须先有会话。 */
	ensureTranscript(conversationId?: string): Promise<ChatModeTranscript | undefined>;
}

export function createCorePresetTranscriptPort(sinks: CorePresetSinks): PresetTranscriptPort {
	return {
		async setPermission(preset: string, conversationId?: string): Promise<PresetEntryResult> {
			const transcript = await sinks.ensureTranscript(conversationId).catch(() => undefined);
			if (!transcript) return "failed";
			return appendModeEntry(transcript.manager, MODE_ENTRY_TYPES.permission, { preset });
		},
		readPermission(conversationId?: string): string | undefined {
			const transcript = sinks.transcriptOf(conversationId);
			return transcript ? readPermissionFromSession(transcript.manager) : undefined;
		},
	};
}
