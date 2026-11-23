import { DEFAULT_CLIENT_SETTINGS } from "../../../../../server/client-state.js";
import type { ClientSettings } from "../../../../../server/client-state.js";
import type { ClientId } from "../../contracts/ids.js";
import type { StatePort } from "../../contracts/ports.js";
import { applySettingsPatch, writeSetting } from "./patch.js";
import { buildSettingsView } from "./read-model.js";
import type { SettingsView } from "./read-model.js";

/** 每个 clientId 一份落盘键：`StatePort` 只认字符串键，命名在这里收口。 */
export function settingsStateKey(clientId: ClientId): string {
	return `settings:${clientId}`;
}

export interface SettingsLoadResult {
	/** 生效值：默认值 ← 已落盘补丁的浅合并（未进视图的字段仍是原样，视图才是下发面）。 */
	settings: ClientSettings;
	view: SettingsView;
}

export interface SettingsSaveResult extends SettingsLoadResult {
	changed: string[];
	ignored: string[];
	version: number;
}

/**
 * 设置落盘只经注入的 `StatePort`；落盘的是补丁原值，归一化在读取时由 `buildSettingsView` 统一做。
 * 没有真的变化（空补丁 / 全未知键 / 值相同）就不写盘、不升版本号。
 */
export class SettingsStore {
	private revision = 0;

	constructor(private readonly state: StatePort) {}

	version(): number {
		return this.revision;
	}

	load(clientId: ClientId): SettingsLoadResult {
		const settings = this.effective(clientId);
		return { settings, view: buildSettingsView({ current: settings }) };
	}

	save(clientId: ClientId, patch: Partial<ClientSettings> | null | undefined): SettingsSaveResult {
		const before = this.effective(clientId);
		const result = applySettingsPatch(before, patch);
		if (result.changed.length === 0) {
			return {
				settings: before,
				view: buildSettingsView({ current: before }),
				changed: result.changed,
				ignored: result.ignored,
				version: this.revision,
			};
		}
		this.persist(clientId, result.changed, result.next);
		this.revision += 1;
		const settings = this.effective(clientId);
		return {
			settings,
			view: buildSettingsView({ current: settings }),
			changed: result.changed,
			ignored: result.ignored,
			version: this.revision,
		};
	}

	/** 已落盘的补丁（未知键在这一步就被剔掉，脏数据进不了生效值）。 */
	private stored(clientId: ClientId): Partial<ClientSettings> {
		const raw = this.state.read(settingsStateKey(clientId));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return applySettingsPatch({}, raw as Partial<ClientSettings>).next;
	}

	private effective(clientId: ClientId): ClientSettings {
		const settings = structuredClone(DEFAULT_CLIENT_SETTINGS);
		for (const [rawKey, value] of Object.entries(this.stored(clientId))) {
			if (value === undefined) continue;
			writeSetting(settings, rawKey as keyof ClientSettings, value);
		}
		return { ...settings, ...buildSettingsView({ current: settings }) };
	}

	/** 只写变更键，别把默认值整份抄进用户数据目录。 */
	private persist(clientId: ClientId, changed: readonly string[], next: Partial<ClientSettings>): void {
		const keys = new Set(changed);
		const stored: Record<string, unknown> = { ...this.stored(clientId) };
		for (const [key, value] of Object.entries(next)) {
			if (keys.has(key)) stored[key] = value;
		}
		this.state.write(settingsStateKey(clientId), stored);
	}
}
