import { presetToolHostOf } from "../adapters/sdk/preset-tools.js";
import { CoreEngineNotReadyError } from "../contracts/core-engine-errors.js";
import type { ClientId } from "../contracts/ids.js";
import type { TransportPort } from "../contracts/ports.js";
import type { PresetEntryResult, PresetTranscriptPort, SnapshotAgentPresetView } from "../contracts/presets.js";
import type { TurnCapableSession } from "../contracts/session.js";
import type { SettingsStorePort } from "../contracts/settings-store.js";
import {
	agentPresetOf,
	agentPresetRefusedReceipt,
	agentPresetSwitchedReceipt,
	agentPresetViewOf,
	applyAgentPresetGate,
	isBlankConversation,
	permissionPresetEntryReceipt,
	permissionPresetOf,
	permissionPresetRefusedReceipt,
	permissionPresetSwitchedReceipt,
	type ChatModeState,
	type PresetReceipt,
	type PresetState,
} from "../domains/tools/index.js";
import type { Conversation, ConversationRegistry } from "../kernel/conversation/index.js";
import type { ClientSettings } from "../settings-schema.js";
import { localizedName, PI_AGENT_PRESETS, PI_PERMISSION_OPTIONS } from "../tool-catalog.js";

/** 会话句柄的来源：`SessionRegistry` 的窄面（`get` 同步、`ensure` 没开就开一个）。 */
export interface PresetSessionLookup {
	get(conversationId: string): { session: TurnCapableSession } | undefined;
	ensure(conversation: Conversation): Promise<{ session: TurnCapableSession }>;
}

/**
 * 两个预设 handler 用到的那几件现成东西：不认 `ClientRuntime`，只认这张窄面
 * （同 `ExtraHandlerRuntime` / `NativeCliRuntime` 的手法，省掉一次 app 内的类型回环）。
 */
export interface PresetHandlerRuntime {
	readonly clientId: ClientId;
	readonly options: {
		readonly transport: TransportPort;
		readonly stateStore?: () => SettingsStorePort | undefined;
		/** 会话句柄（工具集与提示词只在会话上）；缺省 = `selectAgentPreset` 同步抛。 */
		readonly sessions?: PresetSessionLookup;
		readonly getLang?: () => string;
		/** 预设运行态（与快照投影同一份）；缺省 = 两个 handler 都同步抛。 */
		readonly presets?: PresetState;
		/** 计划 / 审查者模式的运行态：预设门禁要按它减工具（与写工具闸门同一份）。 */
		readonly chatModes?: ChatModeState;
		/** 宿主侧的会话级权限条目读写；缺省 = `setPermissionPreset` 同步抛。 */
		readonly presetTranscript?: () => PresetTranscriptPort | undefined;
	};
	readonly registry: ConversationRegistry<Conversation>;
	/** 刷一帧快照（`publisher.request()`）。 */
	readonly publisher: { request(): void };
}

/** 端口已齐、只差 handler 的两个成员（面：`dispatch-surface.ts` 第 145 / 147 行）。 */
export interface PresetHandlers {
	selectAgentPreset(preset: string): Promise<void>;
	setPermissionPreset(preset: string): Promise<void>;
}

/** 预设切换句柄：重设后的活动工具名 + 提示词重载（两个都要，缺一不成事）。 */
export interface ConversationPresetGate {
	activeTools: string[];
	reloadPrompt(): Promise<void>;
}

/**
 * 快照里的预设投影（`agentPreset` + `permission`）：`viewOf` 与单测共用这一份，不各写一条。
 * 两个字段都会填——快照说「只读分析」就必须真的能读到它，不允许空着。
 */
export function conversationPresetViewOf(input: {
	conversationId: string;
	queued: number;
	session?: TurnCapableSession;
	settings?: ClientSettings;
	presets: PresetState;
	chatModes?: ChatModeState;
	lang: string;
}): { agentPreset: SnapshotAgentPresetView; permission: string } {
	return {
		agentPreset: agentPresetViewOf({
			preset: input.presets.agentPresetOf(input.conversationId),
			locked:
				input.presets.lockedOf(input.conversationId) ||
				!isBlankConversation({
					queued: input.queued,
					messages: input.session?.messages,
					isStreaming: input.session?.isStreaming,
				}),
			lang: input.lang,
		}),
		permission: permissionPresetOf({
			preset: input.presets.permissionOf(input.conversationId),
			settings: input.settings,
		}),
	};
}

/**
 * 按预设重设一条会话的工具集（`selectAgentPreset` 与「会话一开就按预设门禁」共用这一份）。
 *
 * 返回 `undefined` = 这个会话没有可重设的工具集 / 没有提示词重载口：调用方必须**拒绝切换**，
 * 绝不能改成「只改状态」——那就是审计里点名要避免的假开关。
 */
export function gateConversationPreset(input: {
	session: TurnCapableSession | undefined;
	preset: string;
	settings?: ClientSettings;
	modes?: { planMode?: boolean; delegateMode?: boolean };
}): ConversationPresetGate | undefined {
	const host = presetToolHostOf(input.session);
	if (!host) return undefined;
	const activeTools = applyAgentPresetGate({
		activeTools: host.activeTools,
		preset: input.preset,
		settings: input.settings,
		...input.modes,
	});
	return { activeTools, reloadPrompt: () => host.reloadPrompt() };
}

/**
 * `selectAgentPreset` / `setPermissionPreset`：老实现 `agent-service.ts:10885` / `:10950`。
 *
 * 两个「真」各自落在：
 * - **agent 预设**：`gateConversationPreset()` 真的按预设重设会话的 active tools（唯一漏斗
 *   `applyAgentToolsGating`），再 `resourceLoader.reload()` 让 SDK 重新装配系统提示词；
 *   会话没开就先开一个——没有会话就没有可重设的工具集。
 * - **权限预设**：先写会话级 `permission/preset` 条目（三态，写不进去就**保持旧值**），再改内存投影，
 *   快照 `permission` 由此真填；重启后由 `restore()` 从转录读回（与 `plan/mode` 同一套机制）。
 *
 * 未注入端口一律**同步抛** `CoreEngineNotReadyError`（注册表口径：不是 rejected promise ——
 * 派发点写的是 `void cs.selectAgentPreset?.(…)`，rejection 只会变成没人接的告警）。
 */
export function createPresetHandlers(runtime: PresetHandlerRuntime): PresetHandlers {
	const presets = (what: string): PresetState => {
		const state = runtime.options.presets;
		if (!state) throw new CoreEngineNotReadyError(what);
		return state;
	};
	const sessions = (what: string): PresetSessionLookup => {
		const lookup = runtime.options.sessions;
		if (!lookup) throw new CoreEngineNotReadyError(what);
		return lookup;
	};
	const transcript = (what: string): PresetTranscriptPort => {
		const port = runtime.options.presetTranscript?.();
		if (!port) throw new CoreEngineNotReadyError(what);
		return port;
	};
	const settings = (): ClientSettings | undefined =>
		runtime.options.stateStore?.()?.getSettingsSnapshot(runtime.clientId);
	const lang = (): string => runtime.options.getLang?.() ?? "zh";
	const announce = (receipt: PresetReceipt): void => {
		if (runtime.options.transport.isClosed()) return;
		runtime.options.transport.send({
			type: "notice",
			level: receipt.level,
			text: receipt.text,
			textEn: receipt.textEn,
		});
	};
	const flushSnapshot = (): void => runtime.publisher.request();
	/** 预设的两种语言名：`text` 跟界面语言，`textEn` 一律给真英文（回执两个字段都要能看）。 */
	const agentPresetNames = (id: string): { name: string; nameEn: string } => {
		const hit = PI_AGENT_PRESETS.find((p) => p.id === id);
		return { name: localizedName(hit, lang(), id), nameEn: localizedName(hit, "en", id) };
	};

	const selectAgentPreset = async (
		deps: { state: PresetState; lookup: PresetSessionLookup },
		preset: string,
	): Promise<void> => {
		const { state, lookup } = deps;
		const conv = runtime.registry.activeConv();
		if (!conv) {
			announce(agentPresetRefusedReceipt("no-conversation", ""));
			return;
		}
		const currentSettings = settings();
		const current = agentPresetOf({ preset: state.agentPresetOf(conv.id), settings: currentSettings });
		const session = lookup.get(conv.id)?.session;
		const blank = isBlankConversation({
			queued: conv.queues.total(),
			messages: session?.messages,
			isStreaming: session?.isStreaming,
		});
		// 已经锁死或会话已经开跑：锁死并如实告知（空白会话才能切，老实现同口径）。
		if (state.lockedOf(conv.id) || !blank) {
			state.setAgentPreset(conv.id, current, true);
			const locked = agentPresetNames(current);
			announce(agentPresetRefusedReceipt("locked", locked.name, locked.nameEn));
			flushSnapshot();
			return;
		}
		const hit = PI_AGENT_PRESETS.find((p) => p.id === preset);
		if (!hit) {
			announce(agentPresetRefusedReceipt("unknown", preset));
			return;
		}
		let opened: { session: TurnCapableSession };
		try {
			opened = await lookup.ensure(conv);
		} catch (error) {
			announce(agentPresetRefusedReceipt("no-tools", error instanceof Error ? error.message : String(error)));
			flushSnapshot();
			return;
		}
		const chatModes = runtime.options.chatModes;
		const gate = gateConversationPreset({
			session: opened.session,
			preset: hit.id,
			settings: currentSettings,
			modes: {
				planMode: chatModes?.planModeOf(conv.id) === true,
				delegateMode: chatModes?.delegateModeOf(conv.id) === true,
			},
		});
		if (!gate) {
			announce(agentPresetRefusedReceipt("no-tools", conv.id));
			flushSnapshot();
			return;
		}
		try {
			// 流式 / 压缩中 SDK 会拒绝 reload：老口径也是尽力而为（工具集已经真的换了）。
			await gate.reloadPrompt();
		} catch {}
		state.setAgentPreset(conv.id, hit.id, false);
		const switched = agentPresetNames(hit.id);
		announce(agentPresetSwitchedReceipt(switched.name, switched.nameEn));
		flushSnapshot();
	};

	const setPermissionPreset = async (port: PresetTranscriptPort, state: PresetState, preset: string): Promise<void> => {
		const conv = runtime.registry.activeConv();
		if (!conv) {
			announce(permissionPresetRefusedReceipt("no-conversation", ""));
			return;
		}
		const hit = PI_PERMISSION_OPTIONS.find((p) => p.value === preset);
		if (!hit) {
			announce(permissionPresetRefusedReceipt("unknown", preset));
			return;
		}
		const unchanged = permissionPresetOf({ preset: state.permissionOf(conv.id), settings: settings() }) === hit.value;
		// 提交顺序（#968）：先落盘条目（同值也要试——上次写失败就是这次重试的机会），再改内存与公告。
		let persisted: PresetEntryResult;
		try {
			persisted = await port.setPermission(hit.value, conv.id);
		} catch {
			// 抛错与「写不进去」等价：绝不把异常当成已保存。
			persisted = "failed";
		}
		if (persisted === "failed") {
			announce(permissionPresetEntryReceipt("failed"));
			flushSnapshot();
			return;
		}
		if (unchanged) {
			if (persisted === "transient") announce(permissionPresetEntryReceipt("transient"));
			flushSnapshot();
			return;
		}
		state.setPermission(conv.id, hit.value);
		announce(
			permissionPresetSwitchedReceipt(localizedName(hit, lang(), hit.value), localizedName(hit, "en", hit.value)),
		);
		if (persisted === "transient") announce(permissionPresetEntryReceipt("transient"));
		flushSnapshot();
	};

	return {
		// 端口解析在箭头体里先完成：未注入就是**同步**抛（返回 promise 之前）。
		selectAgentPreset: (preset: string) =>
			selectAgentPreset(
				{ state: presets("selectAgentPreset"), lookup: sessions("selectAgentPreset.sessions") },
				preset,
			),
		setPermissionPreset: (preset: string) =>
			setPermissionPreset(transcript("setPermissionPreset"), presets("setPermissionPreset"), preset),
	};
}
