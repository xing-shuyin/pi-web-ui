/**
 * 设置面板「本地补丁 → 服务端回执」单源。
 *
 * 契约（改这块前先读）：
 * 1. 每次修改先进 pending（本地 overlay），只有服务端回执证明「这一笔生效了」（等值回执，或该字段
 *    相对发送前发生变化）才移除；否则 UI 不会因为一次未确认（或已失败）的保存回退到旧值 ——
 *    「看起来保存了，其实没保存」在结构上不可能出现。
 * 2. pending 超过 {@link SETTINGS_ACK_TIMEOUT_MS} 仍未确认 → 状态 `failed`：界面必须显式提示并可重试，
 *    禁止用定时器假装「已保存」。
 * 3. `promptOverrides` / `toolPromptOverrides` 是 map 语义字段：服务端按「子键覆盖、空字符串删除」合并。
 *    本地 overlay 必须用同一语义叠加，绝不能把一次局部 patch 当成整值 —— 否则面板会把没动过的子键当成已删除，
 *    再把重建出来的草稿写回服务端，就是真正的丢配置。
 * 4. 文本类草稿（提示词覆盖等）用 {@link reconcileOverrideDraft} 重建：只刷新未被本地占用的 token，
 *    本地占用（正在编辑 / 已改但未回执）的内容永远保留。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type SettingsSnapshot = Record<string, unknown>;
export type SettingsPatch = Record<string, unknown>;

export interface PendingSetting {
	/** 尚未被服务端回执确认的补丁值；map 语义字段已与此前的补丁合并 */
	value: unknown;
	/** 最近一次发送时间（0 = 发送通道不可用，立即视为失败） */
	at: number;
	/** 发送前该字段的服务端值：判断「服务端到底动没动」的基准（服务端可能做归一化/夹取） */
	prev: unknown;
}

export type PendingSettings = Record<string, PendingSetting>;

/** `idle` = 无未确认修改；`saved` = 刚刚确认/本地动作已落盘；`failed` = 超时未确认，必须显式提示 */
export type SettingsSaveStatus = "idle" | "saving" | "saved" | "failed";

/** 服务端 `settings-service.set` 里按 map 合并（子键覆盖、空值删除）的字段。 */
export const MERGE_PATCH_KEYS: ReadonlySet<string> = new Set(["promptOverrides", "toolPromptOverrides"]);

/** 超过这个时长还没等到服务端回执，就认为保存失败（回执通常 <100ms）。 */
export const SETTINGS_ACK_TIMEOUT_MS = 10_000;

/** 本地动作（例如插件面板自己保存）后「已保存」提示的停留时间。 */
const SAVED_PULSE_MS = 2_400;

export function isSettingsMap(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function looseEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
}

/** 同一条补丁再次到达时如何累积：map 语义字段合并子键，其余整值替换。 */
export function mergePatchValue(key: string, prevValue: unknown, nextValue: unknown): unknown {
	if (MERGE_PATCH_KEYS.has(key) && isSettingsMap(prevValue) && isSettingsMap(nextValue)) {
		return { ...prevValue, ...nextValue };
	}
	return nextValue;
}

/** 把未确认补丁叠加到服务端快照上（map 字段按服务端同样的合并语义）。 */
export function overlayPendingSettings<S extends object>(server: S, pending: PendingSettings): S {
	if (!server || Object.keys(pending).length === 0) return server;
	const merged: SettingsSnapshot = { ...(server as unknown as SettingsSnapshot) };
	for (const [key, entry] of Object.entries(pending)) {
		if (MERGE_PATCH_KEYS.has(key) && isSettingsMap(entry.value)) {
			const base = isSettingsMap(merged[key]) ? merged[key] : {};
			const next: Record<string, unknown> = { ...base };
			for (const [sub, value] of Object.entries(entry.value)) {
				if (typeof value === "string" && !value.trim()) delete next[sub];
				else next[sub] = value;
			}
			merged[key] = next;
		} else {
			merged[key] = entry.value;
		}
	}
	return merged as S;
}

/**
 * 服务端回执是否已经反映了这条补丁。
 * 判定：每个补丁子键「等值回执」或「相对发送前变化」即算确认 —— 服务端可能对数值做归一化
 * （夹取范围），只看等值会把成功保存误报成失败；反过来 keep=没变才是真的没生效。
 */
export function isPatchConfirmed(
	key: string,
	serverValue: unknown,
	entry: Pick<PendingSetting, "value" | "prev">,
): boolean {
	const confirmedOne = (sent: unknown, echoed: unknown, before: unknown) => {
		if (looseEqual(echoed, sent)) return true;
		// 空串 = 删除语义：服务端没有该子键即算生效
		if (typeof sent === "string" && !sent.trim()) return echoed === undefined || echoed === "";
		return !looseEqual(echoed, before);
	};
	if (MERGE_PATCH_KEYS.has(key)) {
		if (!isSettingsMap(entry.value)) return confirmedOne(entry.value, serverValue, entry.prev);
		const sent = entry.value;
		const server = isSettingsMap(serverValue) ? serverValue : {};
		const before = isSettingsMap(entry.prev) ? entry.prev : {};
		for (const [sub, value] of Object.entries(sent)) {
			if (!confirmedOne(value, server[sub], before[sub])) return false;
		}
		return true;
	}
	return confirmedOne(entry.value, serverValue, entry.prev);
}

/** 丢掉已被服务端回执确认的 pending（保留未确认的，含已超时失败的）。 */
export function prunePendingSettings(pending: PendingSettings, server: SettingsSnapshot): PendingSettings {
	const entries = Object.entries(pending);
	let changed = false;
	const next: PendingSettings = {};
	for (const [key, entry] of entries) {
		if (isPatchConfirmed(key, server[key], entry)) {
			changed = true;
			continue;
		}
		next[key] = entry;
	}
	return changed ? next : pending;
}

/**
 * 用服务端真值重建「分段覆盖」草稿：只写未被 `keepTokens` 占用的 token。
 * 占用 = 正在编辑（focus）或本地已改但没拿到回执（dirty）。
 */
export function reconcileOverrideDraft(
	prev: Record<string, string>,
	serverOverrides: Record<string, string> | undefined,
	keepTokens: Iterable<string>,
): Record<string, string> {
	const next: Record<string, string> = {};
	for (const [token, value] of Object.entries(serverOverrides ?? {})) {
		next[token] = typeof value === "string" ? value : "";
	}
	for (const token of keepTokens) {
		if (Object.hasOwn(prev, token)) next[token] = prev[token] ?? "";
		else delete next[token];
	}
	return next;
}

/** 服务端已与草稿一致的 dirty token 解除占用（保存完成）。 */
export function releaseConfirmedDrafts(
	dirty: Iterable<string>,
	draft: Record<string, string>,
	serverOverrides: Record<string, string> | undefined,
): Set<string> {
	const server = serverOverrides ?? {};
	const next = new Set<string>();
	for (const token of dirty) {
		if ((draft[token] ?? "") !== (server[token] ?? "")) next.add(token);
	}
	return next;
}

export interface SettingsSync<S extends object> {
	/** 服务端快照 + 未确认补丁（map 字段已按合并语义叠加） */
	settings: S;
	status: SettingsSaveStatus;
	/** 超时未确认的字段名，用于提示/重试 */
	failedKeys: string[];
	patch: (patch: SettingsPatch) => void;
	retry: () => void;
	/** 本地已完成保存的动作（插件面板等）闪一次「已保存」 */
	pulse: () => void;
}

/**
 * 未确认补丁 → 服务端回执 的同步状态机。
 * `sendPatch` 返回 false 表示通道不可用（ws 未连接），此时补丁立即标记为失败而不是静默丢弃。
 */
export function useSettingsSync<S extends object>(
	serverSettings: S,
	sendPatch: (patch: SettingsPatch) => boolean,
): SettingsSync<S> {
	const [pending, setPending] = useState<PendingSettings>({});
	const pendingRef = useRef<PendingSettings>(pending);
	pendingRef.current = pending;
	const serverRef = useRef<S>(serverSettings);
	serverRef.current = serverSettings;
	const [, setTick] = useState(0);
	const [pulsing, setPulsing] = useState(false);
	const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const settings = useMemo(() => overlayPendingSettings(serverSettings, pending), [serverSettings, pending]);

	// 回执到达：丢掉已被确认的补丁
	useEffect(() => {
		setPending((prev) =>
			Object.keys(prev).length === 0 ? prev : prunePendingSettings(prev, serverSettings as unknown as SettingsSnapshot),
		);
	}, [serverSettings]);

	const pendingCount = Object.keys(pending).length;
	// 等待回执期间按秒刷新一次，让超时能落到 failed 状态
	useEffect(() => {
		if (pendingCount === 0) return;
		const id = setInterval(() => setTick((n) => n + 1), 500);
		return () => clearInterval(id);
	}, [pendingCount]);

	useEffect(() => {
		return () => {
			if (pulseTimer.current) clearTimeout(pulseTimer.current);
		};
	}, []);

	// 每次渲染都重算（回执等待期间的 500ms tick 会驱动重渲染），超时才可能落到 failed
	const now = Date.now();
	const failedKeys =
		pendingCount === 0 ? [] : Object.keys(pending).filter((key) => now - pending[key].at >= SETTINGS_ACK_TIMEOUT_MS);

	const patch = useCallback(
		(patchValues: SettingsPatch) => {
			const keys = Object.keys(patchValues).filter((key) => patchValues[key] !== undefined);
			if (keys.length === 0) return;
			const delivered = sendPatch(patchValues);
			const at = delivered ? Date.now() : 0;
			const server = serverRef.current;
			setPending((prev) => {
				const next: PendingSettings = { ...prev };
				for (const key of keys) {
					const existing = prev[key];
					next[key] = {
						value: mergePatchValue(key, existing?.value, patchValues[key]),
						at,
						// 重复编辑同一字段时保留最初的发送前基线
						prev: existing ? existing.prev : (server as SettingsSnapshot)[key],
					};
				}
				return next;
			});
		},
		[sendPatch],
	);

	const retry = useCallback(() => {
		const payload: SettingsPatch = {};
		for (const [key, entry] of Object.entries(pendingRef.current)) payload[key] = entry.value;
		if (Object.keys(payload).length === 0) return;
		const delivered = sendPatch(payload);
		const at = delivered ? Date.now() : 0;
		setPending((prev) => {
			const next: PendingSettings = {};
			for (const [key, entry] of Object.entries(prev)) next[key] = { ...entry, at };
			return next;
		});
	}, [sendPatch]);

	const pulse = useCallback(() => {
		setPulsing(true);
		if (pulseTimer.current) clearTimeout(pulseTimer.current);
		pulseTimer.current = setTimeout(() => setPulsing(false), SAVED_PULSE_MS);
	}, []);

	const status: SettingsSaveStatus =
		failedKeys.length > 0 ? "failed" : pendingCount > 0 ? "saving" : pulsing ? "saved" : "idle";

	return { settings, status, failedKeys, patch, retry, pulse };
}
