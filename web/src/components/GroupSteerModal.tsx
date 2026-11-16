import { useState, useCallback, useEffect, useRef } from "react";
import { FiNavigation, FiZap, FiRefreshCw, FiCheck, FiCpu, FiAlertCircle } from "react-icons/fi";
import { Modal } from "./Modal";
import { useT } from "../i18n";
import type { MessageKey } from "../i18n/catalog";
import { formatGroupDisplayText, type GroupTask } from "../device-group-messages";

export interface GroupSteerModalProps {
	task: GroupTask;
	botName?: string;
	deviceName?: string;
	onClose: () => void;
	onSubmit: (text: string) => Promise<void>;
}

interface SteerPreset {
	id: string;
	labelKey: MessageKey;
	textKey: MessageKey;
}

const STEER_PRESETS: SteerPreset[] = [
	{
		id: "summarize-finish",
		labelKey: "groupSteer.presetSummarizeLabel",
		textKey: "groupSteer.presetSummarizeText",
	},
	{
		id: "check-types",
		labelKey: "groupSteer.presetTypesLabel",
		textKey: "groupSteer.presetTypesText",
	},
	{
		id: "self-test",
		labelKey: "groupSteer.presetSelfTestLabel",
		textKey: "groupSteer.presetSelfTestText",
	},
	{
		id: "concise-report",
		labelKey: "groupSteer.presetConciseLabel",
		textKey: "groupSteer.presetConciseText",
	},
];

export function GroupSteerModal({ task, botName, deviceName, onClose, onSubmit }: GroupSteerModalProps) {
	const t = useT();

	const [steerText, setSteerText] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		textareaRef.current?.focus();
	}, []);

	const handleApplyPreset = useCallback(
		(preset: SteerPreset) => {
			const text = t(preset.textKey);
			setSteerText((prev) => {
				if (!prev.trim()) return text;
				return `${prev.trim()}\n${text}`;
			});
			textareaRef.current?.focus();
		},
		[t],
	);

	const handleSubmit = useCallback(async () => {
		const trimmed = steerText.trim();
		if (!trimmed) {
			setError(t("groupSteer.enterInstruction"));
			return;
		}

		setSubmitting(true);
		setError(null);
		try {
			await onSubmit(trimmed);
			onClose();
		} catch (err: any) {
			setError(err?.message || t("groupSteer.injectFailed"));
		} finally {
			setSubmitting(false);
		}
	}, [steerText, onSubmit, onClose, t]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
				e.preventDefault();
				handleSubmit();
			}
		},
		[handleSubmit],
	);

	const taskSummary = formatGroupDisplayText(task.text);
	const resolvedBotName = botName || task.botId;
	const resolvedDeviceName = deviceName || task.deviceId;

	return (
		<Modal
			open
			onClose={onClose}
			title={t("groupSteer.title")}
			icon={<FiNavigation className="dg-steer-icon" />}
			className="dg-steer-modal"
		>
			<div className="dg-steer-body">
				<div className="dg-steer-target-card">
					<div className="dg-steer-target-header">
						<div className="dg-steer-bot-badge">
							<FiCpu style={{ marginRight: 4 }} />
							<strong>@{resolvedBotName}</strong>
						</div>
						{resolvedDeviceName && (
							<span className="dg-steer-device-name" title={t("groupSteer.targetDevice")}>
								{resolvedDeviceName}
							</span>
						)}
						<span className="dg-steer-task-id" title={task.id}>
							#{task.id.slice(0, 8)}
						</span>
					</div>

					<div className="dg-steer-target-text" title={taskSummary}>
						<span className="dg-steer-text-label">{t("groupSteer.currentGoal")}</span>
						{taskSummary}
					</div>

					{task.progress?.phase && (
						<div className="dg-steer-progress-tag">
							<span className="dg-steer-progress-dot" />
							<span>
								{t("groupSteer.phase")}: <code>{task.progress.phase}</code>
								{task.progress.toolName && ` · Tool: ${task.progress.toolName}`}
							</span>
						</div>
					)}
				</div>

				<div className="dg-steer-presets-section">
					<div className="dg-steer-presets-header">
						<FiZap className="dg-steer-zap-icon" />
						<span>{t("groupSteer.presetsHeader")}</span>
					</div>
					<div className="dg-steer-preset-chips">
						{STEER_PRESETS.map((preset) => (
							<button
								key={preset.id}
								type="button"
								className="dg-steer-preset-chip"
								onClick={() => handleApplyPreset(preset)}
								disabled={submitting}
								title={t(preset.textKey)}
							>
								{t(preset.labelKey)}
							</button>
						))}
					</div>
				</div>

				<div className="dg-steer-input-section">
					<label className="dg-field-label">{t("groupSteer.instructionLabel")}</label>
					<textarea
						ref={textareaRef}
						className="dg-steer-textarea"
						rows={4}
						placeholder={t("groupSteer.placeholder")}
						value={steerText}
						onChange={(e) => setSteerText(e.target.value)}
						onKeyDown={handleKeyDown}
						disabled={submitting}
					/>
				</div>

				{error && (
					<div className="dg-error-banner" role="alert">
						<FiAlertCircle style={{ marginRight: 6, flexShrink: 0 }} />
						<span>{error}</span>
					</div>
				)}

				<div className="dg-steer-actions">
					<button type="button" className="btn secondary" onClick={onClose} disabled={submitting}>
						{t("cancel")}
					</button>
					<button
						type="button"
						className="btn primary"
						onClick={handleSubmit}
						disabled={submitting || !steerText.trim()}
					>
						{submitting ? (
							<FiRefreshCw className="spin" style={{ marginRight: 6 }} />
						) : (
							<FiCheck style={{ marginRight: 6 }} />
						)}
						{submitting ? t("groupSteer.injecting") : t("groupSteer.inject")}
					</button>
				</div>
			</div>
		</Modal>
	);
}
