import { FiVolume2 } from "react-icons/fi";
import { useT } from "../../i18n";
import { playSound, type SoundSettings } from "../../sounds";
import { speak, type TtsSettings } from "../../tts";
import { NotifyToggle } from "../NotifyToggle";
import { SoundSettingsPanel, TtsSettingsPanel } from "../SoundSettings";

/** 设置页「提示音与语音播报」Tab。 */
export function SoundTab({
	sound,
	onSoundChange,
	tts,
	onTtsChange,
}: {
	sound: SoundSettings;
	onSoundChange: (next: SoundSettings) => void;
	tts: TtsSettings;
	onTtsChange: (next: TtsSettings) => void;
}) {
	const t = useT();
	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiVolume2 className="set-section-icon" />
				{t("settingsSoundVoice")}
			</div>
			<SoundSettingsPanel settings={sound} onChange={onSoundChange} onPreview={(kind) => playSound(kind, sound)} />
			<NotifyToggle />
			<TtsSettingsPanel
				settings={tts}
				onChange={onTtsChange}
				onPreview={() => speak(t("ttsPreviewLine"), { ...tts, enabled: true })}
			/>
		</div>
	);
}
