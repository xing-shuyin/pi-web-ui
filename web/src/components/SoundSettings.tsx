import { useEffect, useState } from "react";
import { FiVolume2 } from "react-icons/fi";
import type { SoundKind, SoundSettings } from "../sounds";
import { isTtsAvailable, type TtsSettings } from "../tts";
import { useI18n, useT } from "../i18n";
import {
	getPluginTtsProvider,
	listPluginTtsProviders,
	onTtsProvidersChange,
	type PluginHostTtsProviderInfo,
} from "../plugin-host";

interface SoundSettingsProps {
	settings: SoundSettings;
	onChange: (settings: SoundSettings) => void;
	onPreview: (kind: SoundKind) => void;
}

const SOUND_EVENTS: {
	kind: SoundKind;
	labelKey: "sound.question" | "sound.done" | "sound.subagentDone" | "sound.start" | "sound.error" | "sound.approval";
	descKey:
		| "sound.question.desc"
		| "sound.done.desc"
		| "sound.subagentDone.desc"
		| "sound.start.desc"
		| "sound.error.desc"
		| "sound.approval.desc";
}[] = [
	{
		kind: "question",
		labelKey: "sound.question",
		descKey: "sound.question.desc",
	},
	{ kind: "done", labelKey: "sound.done", descKey: "sound.done.desc" },
	{ kind: "subagentDone", labelKey: "sound.subagentDone", descKey: "sound.subagentDone.desc" },
	{ kind: "start", labelKey: "sound.start", descKey: "sound.start.desc" },
	{ kind: "error", labelKey: "sound.error", descKey: "sound.error.desc" },
	{ kind: "approval", labelKey: "sound.approval", descKey: "sound.approval.desc" },
];

export function SoundSettingsPanel({ settings, onChange, onPreview }: SoundSettingsProps) {
	const t = useT();
	const toggle = (patch: Partial<SoundSettings>) => onChange({ ...settings, ...patch });

	return (
		<div className="sound-menu">
			<div className="dd-header">{t("soundHeader")}</div>

			<label className="sound-row sound-master">
				<span className="sound-label">
					<FiVolume2 className="sound-icon" />
					<span>{t("enableSound")}</span>
				</span>
				<input type="checkbox" checked={settings.enabled} onChange={(e) => toggle({ enabled: e.target.checked })} />
			</label>

			{SOUND_EVENTS.map(({ kind, labelKey, descKey }) => (
				<label key={kind} className={`sound-row ${settings.enabled ? "" : "disabled"}`}>
					<span className="sound-label">
						<span className="sound-name">{t(labelKey)}</span>
						<span className="sound-desc">{t(descKey)}</span>
					</span>
					<span className="sound-right">
						<button
							type="button"
							className="sound-preview"
							title={t("preview")}
							disabled={!settings.enabled}
							onClick={(e) => {
								e.preventDefault();
								onPreview(kind);
							}}
						>
							{t("preview")}
						</button>
						<input
							type="checkbox"
							checked={settings[kind]}
							disabled={!settings.enabled}
							onChange={(e) => toggle({ [kind]: e.target.checked })}
						/>
					</span>
				</label>
			))}

			<div className={`sound-volume ${settings.enabled ? "" : "disabled"}`}>
				<span className="sound-name">{t("volume")}</span>
				<input
					type="range"
					min={0}
					max={100}
					step={5}
					value={settings.volume}
					disabled={!settings.enabled}
					onChange={(e) => toggle({ volume: Number(e.target.value) })}
				/>
				<span className="sound-vol-num">{settings.volume}%</span>
			</div>
		</div>
	);
}

interface TtsSettingsProps {
	settings: TtsSettings;
	onChange: (settings: TtsSettings) => void;
	onPreview: () => void;
}

function useTtsProviders(): PluginHostTtsProviderInfo[] {
	const [providers, setProviders] = useState<PluginHostTtsProviderInfo[]>(() => listPluginTtsProviders());
	useEffect(() => {
		return onTtsProvidersChange(() => {
			setProviders(listPluginTtsProviders());
		});
	}, []);
	return providers;
}

export function TtsSettingsPanel({ settings, onChange, onPreview }: TtsSettingsProps) {
	const t = useT();
	const { locale } = useI18n();
	const providers = useTtsProviders();
	const engine = settings.engine || "builtin";
	const supportsRate = providers.find((provider) => provider.id === engine)?.supportsRate !== false;
	const available = isTtsAvailable() && providers.some((provider) => provider.id === engine);
	const [providerVoices, setProviderVoices] = useState<{ voiceURI: string; name: string; lang?: string }[]>([]);
	const [voiceError, setVoiceError] = useState("");
	useEffect(() => {
		let cancelled = false;
		setProviderVoices([]);
		setVoiceError("");
		Promise.resolve(getPluginTtsProvider(engine)?.getVoices?.())
			.then((voices) => {
				if (!cancelled) setProviderVoices(voices || []);
			})
			.catch((error) => {
				if (!cancelled) setVoiceError(error.message);
			});
		return () => {
			cancelled = true;
		};
	}, [engine, available]);

	const toggle = (patch: Partial<TtsSettings>) => onChange({ ...settings, ...patch });

	return (
		<div className="sound-menu">
			<div className="dd-header">{t("ttsHeader")}</div>

			{!available && <div className="sound-desc tts-unavailable">{t("ttsUnavailable")}</div>}
			{voiceError && (
				<div className="sound-desc" role="alert">
					{voiceError}
				</div>
			)}

			<label className={`sound-row sound-master ${available ? "" : "disabled"}`}>
				<span className="sound-label">
					<FiVolume2 className="sound-icon" />
					<span className="sound-name">{t("ttsEnable")}</span>
					<span className="sound-desc">{t("ttsEnableDesc")}</span>
				</span>
				<input
					type="checkbox"
					checked={settings.enabled}
					disabled={!available}
					onChange={(e) => toggle({ enabled: e.target.checked })}
				/>
			</label>

			{providers.length > 0 && (
				<div className={`sound-volume ${available ? "" : "disabled"}`}>
					<span className="sound-name">{t("ttsEngine")}</span>
					<select
						className="set-input tts-voice-select"
						value={settings.engine || "builtin"}
						disabled={!isTtsAvailable()}
						onChange={(e) => toggle({ engine: e.target.value, voiceURI: "" })}
					>
						{!providers.some((provider) => provider.id === engine) && <option value={engine}>{engine}</option>}
						{providers.map((p) => (
							<option key={p.id} value={p.id}>
								{locale === "zh" ? p.label : p.labelEn || p.label}
							</option>
						))}
					</select>
				</div>
			)}

			<label className={`sound-row ${settings.enabled && available ? "" : "disabled"}`}>
				<span className="sound-label">
					<span className="sound-name">{t("ttsAnnounce")}</span>
					<span className="sound-desc">{t("ttsAnnounceDesc")}</span>
				</span>
				<input
					type="checkbox"
					checked={settings.announce}
					disabled={!settings.enabled || !available}
					onChange={(e) => toggle({ announce: e.target.checked })}
				/>
			</label>

			<label className={`sound-row ${settings.enabled && available ? "" : "disabled"}`}>
				<span className="sound-label">
					<span className="sound-name">{t("ttsReadReplies")}</span>
					<span className="sound-desc">{t("ttsReadRepliesDesc")}</span>
				</span>
				<input
					type="checkbox"
					checked={settings.readReplies}
					disabled={!settings.enabled || !available}
					onChange={(e) => toggle({ readReplies: e.target.checked })}
				/>
			</label>

			<label className={`sound-row ${settings.enabled && settings.readReplies && available ? "" : "disabled"}`}>
				<span className="sound-label">
					<span className="sound-name">{t("ttsStreamReplies")}</span>
					<span className="sound-desc">{t("ttsStreamRepliesDesc")}</span>
				</span>
				<input
					type="checkbox"
					checked={settings.streamReplies}
					disabled={!settings.enabled || !settings.readReplies || !available}
					onChange={(e) => toggle({ streamReplies: e.target.checked })}
				/>
			</label>

			<div className={`sound-volume ${available ? "" : "disabled"}`}>
				<span className="sound-name">{t("ttsRate")}</span>
				<input
					type="range"
					min={0.5}
					max={2}
					step={0.1}
					value={supportsRate ? settings.rate : 1}
					disabled={!available || !supportsRate}
					onChange={(e) => toggle({ rate: Number(e.target.value) })}
				/>
				<span className="sound-vol-num">{(supportsRate ? settings.rate : 1).toFixed(1)}×</span>
			</div>

			<div className={`sound-volume ${available ? "" : "disabled"}`}>
				<span className="sound-name">{t("ttsVoice")}</span>
				<select
					className="set-input tts-voice-select"
					value={settings.voiceURI}
					disabled={!available}
					onChange={(e) => toggle({ voiceURI: e.target.value })}
				>
					<option value="">{t("ttsVoiceAuto")}</option>
					{providerVoices.map((v) => (
						<option key={v.voiceURI} value={v.voiceURI}>
							{v.name}
							{v.lang ? ` (${v.lang})` : ""}
						</option>
					))}
				</select>
				<button type="button" className="sound-preview tts-preview" disabled={!available} onClick={onPreview}>
					{t("preview")}
				</button>
			</div>
		</div>
	);
}
