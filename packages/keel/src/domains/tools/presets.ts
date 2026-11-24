import type { SnapshotAgentPresetView } from "../../contracts/presets.js";
import { DELEGATE_MODE_BLOCKED_TOOL_NAMES } from "../../delegate-mode.js";
import { PLAN_MODE_BLOCKED_TOOL_NAMES } from "../../plan-mode.js";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "../../settings-schema.js";
import type { ActiveToolSet } from "../../tool-catalog.js";
import {
	applyAgentToolsGating,
	effectiveDisabledAgentTools,
	localizedName,
	PI_AGENT_PRESETS,
} from "../../tool-catalog.js";

/** 老实现的三处兜底值（`settings-schema.ts:374-375` 的默认值同口径）。 */
export const DEFAULT_AGENT_PRESET = "standard";
export const DEFAULT_PERMISSION_PRESET = "workspace-write-never";

interface PresetRecord {
	/** 会话选定的 agent 预设（未选 = 用设置的默认值）。 */
	agentPreset?: string;
	/** 预设被锁死（会话已经开跑过；空会话才能切）。 */
	locked?: boolean;
	/** 会话级权限预设的内存投影；真值在转录 `permission/preset` 条目（见 `PresetTranscriptPort`）。 */
	permission?: string;
}

/**
 * 预设的运行态：一个进程内投影，出帧与门禁读的都是这一份。
 *
 * - **agent 预设不落盘**（与老实现逐字一致：`agentService:5930` 每次开会话都回到
 *   `defaultAgentPreset`），但它必须跨「会话关掉再开」存活，否则界面显示「只读分析」、
 *   工具集却是全功能 —— 那正是假开关。所以状态挂在对话上，不挂在会话上。
 * - **权限预设的真值在转录**，这里只是投影：写侧先落条目再改内存（issues #968），
 *   读侧由 `restore()` 在会话（重新）打开时从条目读回。
 */
export class PresetState {
	private readonly byConversation = new Map<string, PresetRecord>();

	agentPresetOf(conversationId: string): string | undefined {
		return this.byConversation.get(conversationId)?.agentPreset;
	}

	lockedOf(conversationId: string): boolean {
		return this.byConversation.get(conversationId)?.locked === true;
	}

	setAgentPreset(conversationId: string, preset: string, locked: boolean): void {
		this.byConversation.set(conversationId, {
			...this.byConversation.get(conversationId),
			agentPreset: preset,
			locked,
		});
	}

	permissionOf(conversationId: string): string | undefined {
		return this.byConversation.get(conversationId)?.permission;
	}

	/** 权限预设的唯一切换点（写侧与恢复侧共用）：`undefined` 不覆盖已有值。 */
	setPermission(conversationId: string, preset: string | undefined): void {
		if (!preset) return;
		this.byConversation.set(conversationId, { ...this.byConversation.get(conversationId), permission: preset });
	}
}

/**
 * 「空会话」判据（老实现 `isBlankConversation` 同口径，`nativeCli` 那一支见报告）：
 * 一条消息都没发、两条队列都空、也没在流式。只有空会话能切 agent 预设。
 */
export function isBlankConversation(input: {
	queued: number;
	messages?: readonly unknown[];
	isStreaming?: boolean;
}): boolean {
	return input.queued === 0 && (input.messages?.length ?? 0) === 0 && input.isStreaming !== true;
}

/** 快照里的 agent 预设面：id 缺省走默认预设，`locked` = 显式锁 或 会话已开跑。 */
export function agentPresetViewOf(input: {
	preset: string | undefined;
	locked: boolean;
	lang: string;
}): SnapshotAgentPresetView {
	const id = input.preset ?? DEFAULT_AGENT_PRESET;
	return {
		id,
		name: localizedName(
			PI_AGENT_PRESETS.find((p) => p.id === id),
			input.lang,
			"全功能",
		),
		locked: input.locked,
	};
}

/** 当前会话生效的权限预设：会话条目 → 设置默认 → 老默认值。 */
export function permissionPresetOf(input: { preset?: string; settings?: ClientSettings }): string {
	return input.preset ?? input.settings?.defaultPermissionPreset ?? DEFAULT_PERMISSION_PRESET;
}

/** 当前会话生效的 agent 预设（`selectAgentPreset` 没被调用过就是设置的默认值）。 */
export function agentPresetOf(input: { preset?: string; settings?: ClientSettings }): string {
	return input.preset ?? input.settings?.defaultAgentPreset ?? DEFAULT_AGENT_PRESET;
}

/**
 * 按预设重设工具时该禁用的名字（`applyAgentToolsGating` 的 `disabled` 入参）。
 *
 * 与老实现 `applyToolGating`（`agentService:10762`）的**同一批**来源：设置里的开关、
 * 计划模式 / 审查者模式的写工具闸门，再交给 `applyAgentToolsGating` 做「减法 + 预设白名单」。
 * 差的那几项（插件工具注册表同步、Bot 工具、子代理白名单、懒加载已加载集、终端只读 schema）
 * 见报告「未做项」——它们是别的域的状态，内核还没有对应持有者。
 */
export function presetGateDisabledTools(input: {
	settings?: ClientSettings;
	planMode?: boolean;
	delegateMode?: boolean;
}): string[] {
	const disabled = new Set(effectiveDisabledAgentTools(input.settings ?? DEFAULT_CLIENT_SETTINGS));
	if (input.planMode) {
		for (const name of PLAN_MODE_BLOCKED_TOOL_NAMES) disabled.add(name);
	} else if (input.delegateMode) {
		for (const name of DELEGATE_MODE_BLOCKED_TOOL_NAMES) disabled.add(name);
	}
	return [...disabled];
}

/**
 * 真重设活动工具集：算出禁用集 → 交给活动集唯一漏斗 `applyAgentToolsGating`（预设白名单在它里面）。
 * 返回重设后的活动工具名（调用方用它证明「工具集合真的变了」，不是只改了状态）。
 */
export function applyAgentPresetGate(input: {
	activeTools: ActiveToolSet;
	preset: string;
	settings?: ClientSettings;
	planMode?: boolean;
	delegateMode?: boolean;
}): string[] {
	applyAgentToolsGating(input.activeTools, presetGateDisabledTools(input), input.preset);
	return input.activeTools.getActiveToolNames();
}

export interface PresetReceipt {
	level: "info" | "warning";
	text: string;
	textEn: string;
}

/** 预设的「已切换」回执（老实现 `selectAgentPreset` 的 notice 同口径；`textEn` 一律给真英文名）。 */
export function agentPresetSwitchedReceipt(name: string, nameEn: string): PresetReceipt {
	return { level: "info", text: `已切换为「${name}」预设`, textEn: `Switched to preset "${nameEn}"` };
}

/** 预设锁死 / 未知预设 / 无活动对话：一律警告，不改任何状态。 */
export function agentPresetRefusedReceipt(
	reason: "locked" | "unknown" | "no-conversation" | "no-tools",
	detail: string,
	detailEn = detail,
): PresetReceipt {
	if (reason === "locked") {
		return {
			level: "warning",
			text: `会话已开始，预设锁定为「${detail}」（空白会话可切换）`,
			textEn: `Session already started; preset locked to "${detailEn}" (only blank sessions can switch)`,
		};
	}
	if (reason === "unknown") {
		return { level: "warning", text: `未知预设「${detail}」`, textEn: `Unknown preset "${detail}"` };
	}
	if (reason === "no-conversation") {
		return {
			level: "warning",
			text: "没有活动对话，无法切换预设",
			textEn: "No active conversation, so the preset cannot be switched",
		};
	}
	return {
		level: "warning",
		text: `会话还没有可重设的工具集（或提示词重载口），预设未切换：${detail}`,
		textEn: `The conversation has no resettable tool set (or prompt reload hook) yet, so the preset was not switched: ${detail}`,
	};
}

/** 权限预设的「已切换」回执（老实现 `setPermissionPreset` 的 notice 同口径；`textEn` 给真英文名）。 */
export function permissionPresetSwitchedReceipt(name: string, nameEn: string): PresetReceipt {
	return {
		level: "info",
		text: `当前会话权限已切换为「${name}」`,
		textEn: `Current session permission switched to "${nameEn}"`,
	};
}

export function permissionPresetRefusedReceipt(reason: "unknown" | "no-conversation", detail: string): PresetReceipt {
	if (reason === "unknown") {
		return { level: "warning", text: `未知权限预设「${detail}」`, textEn: `Unknown permission preset "${detail}"` };
	}
	return {
		level: "warning",
		text: "没有活动对话，无法切换权限预设",
		textEn: "No active conversation, so the permission preset cannot be switched",
	};
}

/**
 * 「没写进转录 / 只在本进程生效」的回执：不报假成功，也不把失败说成已保存
 * （与 `server/chat-mode-entries.ts` 的 `modeEntryReceipt` 同一口径，`plan` / `delegate` 用那份）。
 */
export function permissionPresetEntryReceipt(result: "transient" | "failed"): PresetReceipt {
	if (result === "failed") {
		return {
			level: "warning",
			text: "权限预设没能写入对话记录（切换未生效）：重启或重载后会回到旧值。可重试一次。",
			textEn:
				"permission preset could not be written to the conversation transcript, so the switch did not take effect. Retry, or it will fall back to the old value after a restart.",
		};
	}
	return {
		level: "info",
		text: "权限预设已在本次运行生效；该对话未落盘（临时/内联会话），所以不保存。",
		textEn:
			"Permission preset applies to this run only; this conversation is not persisted (temporary/inline session), so the setting is not saved.",
	};
}
