import { useState, useCallback, useEffect, useRef } from "react";
import { FiNavigation, FiZap, FiRefreshCw, FiCheck, FiCpu, FiAlertCircle } from "react-icons/fi";
import { Modal } from "./Modal";
import { isZhLocale, useI18n } from "../i18n";
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
	labelZh: string;
	labelEn: string;
	textZh: string;
	textEn: string;
}

const STEER_PRESETS: SteerPreset[] = [
	{
		id: "summarize-finish",
		labelZh: "直接汇总当前阶段产物并结束",
		labelEn: "Summarize & Finish",
		textZh: "直接汇总当前阶段产物并结束，保留关键交付物与验证结论。",
		textEn: "Directly summarize current phase deliverables and finish, retaining key evidence and conclusions.",
	},
	{
		id: "check-types",
		labelZh: "优先检查并补充类型声明",
		labelEn: "Prioritize Types",
		textZh: "优先检查并补充缺失的类型声明，确保 strict typecheck 零错误。",
		textEn: "Prioritize checking and adding type declarations to ensure zero typecheck errors.",
	},
	{
		id: "self-test",
		labelZh: "先进行自测并展示通过证据",
		labelEn: "Self-test & Show Evidence",
		textZh: "先进行自测并展示通过证据，包括具体的测试用例与终端运行输出。",
		textEn: "Run self-tests first and present verification evidence including test cases and terminal output.",
	},
	{
		id: "concise-report",
		labelZh: "精简输出与风险",
		labelEn: "Concise Output & Risks",
		textZh: "精简后续输出，跳过冗余细节，仅汇报核心变更、未决风险与阻碍项。",
		textEn: "Keep subsequent output concise; report only core changes, unresolved risks, and blockers.",
	},
];

export function GroupSteerModal({ task, botName, deviceName, onClose, onSubmit }: GroupSteerModalProps) {
	const { locale } = useI18n();
	const zh = isZhLocale(locale);

	const [steerText, setSteerText] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		textareaRef.current?.focus();
	}, []);

	const handleApplyPreset = useCallback(
		(preset: SteerPreset) => {
			const text = zh ? preset.textZh : preset.textEn;
			setSteerText((prev) => {
				if (!prev.trim()) return text;
				return `${prev.trim()}\n${text}`;
			});
			textareaRef.current?.focus();
		},
		[zh],
	);

	const handleSubmit = useCallback(async () => {
		const trimmed = steerText.trim();
		if (!trimmed) {
			setError(zh ? "请输入转向纠偏指令" : "Please enter steering instruction");
			return;
		}

		setSubmitting(true);
		setError(null);
		try {
			await onSubmit(trimmed);
			onClose();
		} catch (err: any) {
			setError(err?.message || (zh ? "注入转向指令失败" : "Failed to inject steering instruction"));
		} finally {
			setSubmitting(false);
		}
	}, [steerText, onSubmit, onClose, zh]);

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
			title={zh ? "任务飞行中实时转向 (In-flight Steering)" : "In-flight Task Steering"}
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
							<span className="dg-steer-device-name" title={zh ? "目标设备" : "Target Device"}>
								{resolvedDeviceName}
							</span>
						)}
						<span className="dg-steer-task-id" title={task.id}>
							#{task.id.slice(0, 8)}
						</span>
					</div>

					<div className="dg-steer-target-text" title={taskSummary}>
						<span className="dg-steer-text-label">{zh ? "当前目标：" : "Current Goal: "}</span>
						{taskSummary}
					</div>

					{task.progress?.phase && (
						<div className="dg-steer-progress-tag">
							<span className="dg-steer-progress-dot" />
							<span>
								{zh ? "阶段" : "Phase"}: <code>{task.progress.phase}</code>
								{task.progress.toolName && ` · Tool: ${task.progress.toolName}`}
							</span>
						</div>
					)}
				</div>

				<div className="dg-steer-presets-section">
					<div className="dg-steer-presets-header">
						<FiZap className="dg-steer-zap-icon" />
						<span>{zh ? "常用纠偏预设（点击快速填入）" : "Quick Steering Presets"}</span>
					</div>
					<div className="dg-steer-preset-chips">
						{STEER_PRESETS.map((preset) => (
							<button
								key={preset.id}
								type="button"
								className="dg-steer-preset-chip"
								onClick={() => handleApplyPreset(preset)}
								disabled={submitting}
								title={zh ? preset.textZh : preset.textEn}
							>
								{zh ? preset.labelZh : preset.labelEn}
							</button>
						))}
					</div>
				</div>

				<div className="dg-steer-input-section">
					<label className="dg-field-label">
						{zh ? "转向指令 (Ctrl+Enter 提交)" : "Steering Instruction (Ctrl+Enter to submit)"}
					</label>
					<textarea
						ref={textareaRef}
						className="dg-steer-textarea"
						rows={4}
						placeholder={
							zh
								? "例如：当前步骤已通过，请直接进行单元测试并汇报覆盖率；或者跳过重构，保持既有接口契约。"
								: "e.g. Current phase looks good, please jump to unit tests; or skip refactoring and adhere to contracts."
						}
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
						{zh ? "取消" : "Cancel"}
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
						{submitting ? (zh ? "注入中..." : "Injecting...") : zh ? "发送转向指令" : "Inject Steering"}
					</button>
				</div>
			</div>
		</Modal>
	);
}
