import { useState } from "react";
import type { ClientMessage, UiPluginInfo } from "../types";
import { useT } from "../i18n";

/**
 * 插件声明式设置表单（manifest "settings" schema → 自动渲染）。
 * 值保存在 storage.json 的 "settings" 键（宿主统一管理），保存时发
 * plugin_settings，服务端校验 + 持久化 + 通知插件（onSettingsChanged）。
 */
export function PluginSettingsForm({ plugin, send }: { plugin: UiPluginInfo; send: (msg: ClientMessage) => boolean }) {
	const t = useT();
	const schema = plugin.settingsSchema ?? [];
	const [draft, setDraft] = useState<Record<string, unknown>>(
		() => ({ ...plugin.settingsValues }) as Record<string, unknown>,
	);
	const [saving, setSaving] = useState(false);

	if (schema.length === 0) return null;

	const set = (key: string, v: unknown) => setDraft((prev) => ({ ...prev, [key]: v }));
	const isDirty = schema.some((f) => draft[f.key] !== plugin.settingsValues?.[f.key]);

	const save = () => {
		setSaving(true);
		send({ type: "plugin_settings", pluginId: plugin.id, values: draft });
		setTimeout(() => setSaving(false), 800);
	};

	const reset = () => setDraft({ ...plugin.settingsValues });

	return (
		<div className="plugin-settings-form">
			<div className="plugin-settings-fields">
				{schema.map((f) => (
					<label key={f.key} className="plugin-settings-field" title={f.hint}>
						<span className="plugin-settings-label">{f.label}</span>
						{f.type === "boolean" ? (
							<input type="checkbox" checked={Boolean(draft[f.key])} onChange={(e) => set(f.key, e.target.checked)} />
						) : f.type === "select" ? (
							<select value={String(draft[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)}>
								{(f.options ?? []).map((o) => (
									<option key={o} value={o}>
										{o}
									</option>
								))}
							</select>
						) : (
							<input
								type={f.type === "password" ? "password" : f.type === "number" ? "number" : "text"}
								value={String(draft[f.key] ?? "")}
								min={f.min}
								max={f.max}
								onChange={(e) => set(f.key, f.type === "number" ? Number(e.target.value) : e.target.value)}
							/>
						)}
					</label>
				))}
			</div>
			<div className="plugin-settings-actions">
				<button type="button" className="btn plugin-settings-save" disabled={!isDirty || saving} onClick={save}>
					{saving ? t("pluginSettingsSaving") : t("pluginSettingsSave")}
				</button>
				<button type="button" className="btn plugin-settings-reset" onClick={reset}>
					{t("pluginSettingsReset")}
				</button>
			</div>
		</div>
	);
}
