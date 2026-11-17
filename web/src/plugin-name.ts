import { isZhLocale } from "./pick-locale";

/**
 * 插件展示名 / 描述的唯一定值入口。
 *
 * 插件 manifest 的 `name` / `description` 是源语言（中文）文案，`nameEn` / `descriptionEn`
 * 是英文文案。宿主一律按**全局界面语言**在渲染时取值 —— 插件自己不保存语言偏好，
 * 切语言时跟着重新渲染即可（见 docs/architecture-plugins.md「插件界面语言」）。
 */
export interface PluginDisplayInfo {
	id: string;
	name?: string;
	nameEn?: string;
	description?: string;
	descriptionEn?: string;
}

function normalized(value: string | undefined): string {
	return typeof value === "string" ? value.trim() : "";
}

export function pluginDisplayName(plugin: PluginDisplayInfo, locale: string | null | undefined): string {
	const zh = normalized(plugin.name) || plugin.id;
	if (isZhLocale(locale)) return zh;
	return normalized(plugin.nameEn) || zh;
}

export function pluginDisplayDescription(
	plugin: PluginDisplayInfo,
	locale: string | null | undefined,
): string | undefined {
	const zh = normalized(plugin.description);
	const en = normalized(plugin.descriptionEn);
	if (isZhLocale(locale)) return zh || en || undefined;
	return en || zh || undefined;
}
