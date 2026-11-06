import { useState } from "react";
import type { UiPluginInfo, UiPluginSettingField } from "../types";
import { useT, useLocale, isZhLocale } from "../i18n";
import { appSend } from "../app-globals";
import { pluginSelectValues, type PluginSelectModel } from "../plugin-setting-options";
import { THINKING_VALUES, type ThinkingValue } from "../thinking-levels";

export function PluginSettingsForm({ plugin, models = [] }: { plugin: UiPluginInfo; models?: PluginSelectModel[] }) {
	const t = useT();
	const locale = useLocale();
	const zh = isZhLocale(locale);
	const schema = plugin.settingsSchema ?? [];
	const [draft, setDraft] = useState<Record<string, unknown>>(() => {
		const init: Record<string, unknown> = { ...plugin.settingsValues };
		for (const f of schema) if (f.type === "secret") init[f.key] = "";
		return init;
	});
	const [saving, setSaving] = useState(false);

	if (schema.length === 0) return null;

	const set = (key: string, v: unknown) => setDraft((prev) => ({ ...prev, [key]: v }));
	const selectOptions = (f: UiPluginSettingField) =>
		pluginSelectValues(f, models, draft[f.key]).map((v) => {
			if (v === "") return { value: "", label: t("pluginSettingsInherit") };
			if (f.optionsFrom === "thinkingLevels" && (THINKING_VALUES as readonly string[]).includes(v)) {
				return { value: v, label: t(`thinking.${v as ThinkingValue}`) };
			}
			if (f.optionsFrom === "models") {
				const hit = models.find((m) => `${m.provider}/${m.id}` === v);
				if (hit) return { value: v, label: hit.label };
			}
			const staticOpt = f.options?.find((o) => (typeof o === "string" ? o : o.value) === v);
			if (staticOpt && typeof staticOpt === "object") {
				const lbl = zh
					? (staticOpt.label ?? staticOpt.labelEn ?? staticOpt.value)
					: (staticOpt.labelEn ?? staticOpt.label ?? staticOpt.value);
				return { value: v, label: lbl };
			}
			return { value: v, label: v };
		});
	const isDirty = schema.some((f) =>
		f.type === "secret" ? String(draft[f.key] ?? "") !== "" : draft[f.key] !== plugin.settingsValues?.[f.key],
	);

	const save = () => {
		setSaving(true);
		appSend({ type: "plugin_settings", pluginId: plugin.id, values: draft });
		setTimeout(() => setSaving(false), 800);
	};

	const reset = () => {
		const init: Record<string, unknown> = { ...plugin.settingsValues };
		for (const f of schema) if (f.type === "secret") init[f.key] = "";
		setDraft(init);
	};

	return (
		<div className="plugin-settings-form">
			<div className="plugin-settings-fields">
				{schema.map((f) => (
					<label key={f.key} className="plugin-settings-field" data-key={f.key} title={f.hint}>
						<span className="plugin-settings-label">
							<span className="plugin-settings-label-text" title={f.label}>
								{f.label}
							</span>
							{f.hint && <span className="plugin-settings-hint">{f.hint}</span>}
						</span>
						<span className="plugin-settings-control">
							{f.type === "boolean" ? (
								<input type="checkbox" checked={Boolean(draft[f.key])} onChange={(e) => set(f.key, e.target.checked)} />
							) : f.type === "secret" ? (
								<input
									type="password"
									value={String(draft[f.key] ?? "")}
									placeholder={t(plugin.settingsValues?.[f.key] ? "pluginSecretSet" : "pluginSecretUnset")}
									autoComplete="new-password"
									onChange={(e) => set(f.key, e.target.value)}
								/>
							) : f.type === "select" ? (
								<select value={String(draft[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)}>
									{selectOptions(f).map((o) => (
										<option key={o.value} value={o.value}>
											{o.label}
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
						</span>
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
