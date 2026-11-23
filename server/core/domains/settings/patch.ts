import { DEFAULT_CLIENT_SETTINGS } from "../../../client-state.js";
import type { ClientSettings } from "../../../client-state.js";

/** `ClientSettings` 里没进默认对象的可选键：新增可选键要在这里登记，否则补丁会被当未知键丢掉。 */
const OPTIONAL_ONLY_KEYS = [
	"devNoCache",
	"autoReload",
	"claudePermissionMode",
] as const satisfies readonly (keyof ClientSettings)[];

export const CLIENT_SETTINGS_KEYS: ReadonlySet<string> = new Set<string>([
	...Object.keys(DEFAULT_CLIENT_SETTINGS),
	...OPTIONAL_ONLY_KEYS,
]);

export interface SettingsPatchResult {
	next: Partial<ClientSettings>;
	/** 真的发生了增 / 改的键，沿用补丁里的出现顺序。 */
	changed: string[];
	/** 不是 `ClientSettings` 键的输入，一律忽略。 */
	ignored: string[];
}

export function applySettingsPatch(
	current: Partial<ClientSettings> | null | undefined,
	patch: Partial<ClientSettings> | null | undefined,
): SettingsPatchResult {
	const next: Partial<ClientSettings> = { ...current };
	const changed: string[] = [];
	const ignored: string[] = [];
	for (const [rawKey, value] of Object.entries(patch ?? {})) {
		if (!CLIENT_SETTINGS_KEYS.has(rawKey)) {
			ignored.push(rawKey);
			continue;
		}
		if (value === undefined) continue;
		const key = rawKey as keyof ClientSettings;
		if (settingsEqual(readSetting(next, key), value)) continue;
		writeSetting(next, key, value);
		changed.push(rawKey);
	}
	return { next, changed, ignored };
}

/** 结构相等：对象键顺序不同不算变化，数组逐项比较。 */
function settingsEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, index) => settingsEqual(item, b[index]));
	}
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => Object.hasOwn(right, key) && settingsEqual(left[key], right[key]));
}

function readSetting(settings: Partial<ClientSettings>, key: keyof ClientSettings): unknown {
	return (settings as Record<keyof ClientSettings, unknown>)[key];
}

/** 按动态键写一个设置值（键已由 `CLIENT_SETTINGS_KEYS` 过滤，这里只负责类型收口）。 */
export function writeSetting(settings: Partial<ClientSettings>, key: keyof ClientSettings, value: unknown): void {
	(settings as Record<keyof ClientSettings, unknown>)[key] = value;
}
