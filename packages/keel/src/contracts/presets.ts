import type { UiState } from "../protocol.js";

/** 快照里的 agent 预设面：形状取协议单源（`state.agentPreset`），不另抄一份。 */
export type SnapshotAgentPresetView = NonNullable<UiState["agentPreset"]>;

/**
 * 会话级条目的写结果三态（与 `plan/mode` / `delegate/mode` 同一套，issues #968）：
 * `ok` 真写进转录 · `transient` 会话本来就不落盘 · `failed` 写不进去（调用方必须保持旧值并如实告知）。
 */
export type PresetEntryResult = "ok" | "transient" | "failed";

/**
 * 会话级**权限预设**条目的读写窄面（宿主实现：`server/core-preset-adapter.ts`）。
 *
 * 为什么是端口而不是内核自己写：`permission/preset` 条目住在 SDK 的 append-only 转录树上——
 * 写要 `SessionManager.appendCustomEntry()` 加落盘能力判定，读回要沿**叶链**取最后一条有效事件
 * （issues #979）。这套语义的单源是宿主 `server/chat-mode-entries.ts`，内核再写一遍就是第二套实现。
 *
 * 未注入 = 本引擎还写不了这个条目：`setPermissionPreset` **同步抛**（`CoreEngineNotReadyError`），
 * 绝不降级成「只改内存」——那会让界面显示已切换、重启后又回到旧值。
 */
export interface PresetTranscriptPort {
	/** 写一条 `permission/preset`；同值也要写（上次写失败就是这次重试的机会，#968）。 */
	setPermission(preset: string, conversationId?: string): Promise<PresetEntryResult>;
	/** 会话（重新）打开后把转录里的权限条目读回运行态；缺省 = 不恢复（快照回落到默认值）。 */
	readPermission?(conversationId?: string): string | undefined;
}
