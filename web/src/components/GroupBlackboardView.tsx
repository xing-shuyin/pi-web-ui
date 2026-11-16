import { useState, useCallback, useEffect, useMemo } from "react";
import {
	FiEdit3,
	FiCheck,
	FiX,
	FiRefreshCw,
	FiFileText,
	FiClock,
	FiUser,
	FiCopy,
	FiLayers,
	FiCode,
	FiList,
	FiAlertTriangle,
} from "react-icons/fi";
import { Markdown } from "./Markdown";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useI18n, useT } from "../i18n";
import type { MessageKey } from "../i18n/catalog";
import { useCopyFeedback } from "../use-copy-feedback";
import type { GroupBlackboard } from "../../../server/device-center/store";

export interface BlackboardSectionDef {
	id: string;
	titleKey: MessageKey;
	aliases: string[];
}

// `aliases` are bilingual match tokens for the `##` headers the AI writes into the blackboard
// markdown; they are compared against user/AI content, never rendered. Translating them would
// break section resolution for existing boards, so they stay verbatim (data), while the tab
// titles come from `titleKey`.
export const PRESET_SECTIONS: BlackboardSectionDef[] = [
	{
		id: "architecture",
		titleKey: "groupBlackboardSectionArchitecture",
		aliases: ["架构设计", "系统架构", "architecture", "system architecture", "架构契约", "技术方案"],
	},
	{
		id: "contracts",
		titleKey: "groupBlackboardSectionContracts",
		aliases: ["接口契约", "接口规范", "contracts", "api contracts", "api规范", "协议契约", "数据契约"],
	},
	{
		id: "progress",
		titleKey: "groupBlackboardSectionProgress",
		aliases: ["任务分工", "分工与进度", "progress", "tasks", "task progress", "流水线分工", "任务流水线"],
	},
	{
		id: "blockers",
		titleKey: "groupBlackboardSectionBlockers",
		aliases: ["阻塞与决策", "决策记录", "blockers", "decisions", "风险与阻塞", "关键技术决策"],
	},
];

export interface ParsedSection {
	id: string;
	title: string;
	content: string;
	rawHeader: string;
}

export function parseMarkdownSections(markdown: string): { preamble: string; sections: ParsedSection[] } {
	if (!markdown || !markdown.trim()) return { preamble: "", sections: [] };

	const lines = markdown.split(/\r?\n/);
	const sections: ParsedSection[] = [];
	let currentTitle = "";
	let currentHeader = "";
	let currentLines: string[] = [];
	const preambleLines: string[] = [];
	let inFirstSection = false;

	for (const line of lines) {
		const match = line.match(/^##\s+(.+)$/);
		if (match) {
			const titleText = match[1].trim();
			if (!inFirstSection) {
				inFirstSection = true;
			} else {
				sections.push({
					id: resolveSectionId(currentTitle),
					title: currentTitle,
					content: currentLines.join("\n").trim(),
					rawHeader: currentHeader,
				});
				currentLines = [];
			}
			currentTitle = titleText;
			currentHeader = line;
			continue;
		}

		if (inFirstSection) {
			currentLines.push(line);
		} else {
			preambleLines.push(line);
		}
	}

	if (inFirstSection && currentTitle) {
		sections.push({
			id: resolveSectionId(currentTitle),
			title: currentTitle,
			content: currentLines.join("\n").trim(),
			rawHeader: currentHeader,
		});
	}

	return {
		preamble: preambleLines.join("\n").trim(),
		sections,
	};
}

function resolveSectionId(title: string): string {
	const lower = title.toLowerCase();
	for (const preset of PRESET_SECTIONS) {
		if (preset.aliases.some((alias) => lower.includes(alias.toLowerCase()))) {
			return preset.id;
		}
	}
	return `custom-${encodeURIComponent(title.slice(0, 32))}`;
}

export function assembleMarkdownSection(
	fullContent: string,
	sectionId: string,
	sectionTitle: string,
	newSectionContent: string,
): string {
	const { preamble, sections } = parseMarkdownSections(fullContent);
	const existingIdx = sections.findIndex((s) => s.id === sectionId);

	if (existingIdx >= 0) {
		sections[existingIdx].content = newSectionContent.trim();
	} else {
		sections.push({
			id: sectionId,
			title: sectionTitle,
			content: newSectionContent.trim(),
			rawHeader: `## ${sectionTitle}`,
		});
	}

	const parts: string[] = [];
	if (preamble) parts.push(preamble);
	for (const s of sections) {
		if (s.rawHeader) parts.push(s.rawHeader);
		else parts.push(`## ${s.title}`);
		if (s.content) parts.push(s.content);
	}
	return parts.join("\n\n");
}

interface GroupBlackboardViewProps {
	roomId: string;
	blackboard?: GroupBlackboard | null;
	disabled?: boolean;
	onSaved?: () => void;
}

export function GroupBlackboardView({ roomId, blackboard, disabled = false, onSaved }: GroupBlackboardViewProps) {
	const { locale } = useI18n();
	const t = useT();

	const [activeTab, setActiveTab] = useState<string>("all");
	const [isEditing, setIsEditing] = useState(false);
	const [title, setTitle] = useState(blackboard?.title ?? "");
	const [content, setContent] = useState(blackboard?.content ?? "");
	const [sectionContent, setSectionContent] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const { copied, copy } = useCopyFeedback({ duration: 1800 });

	const parsed = useMemo(() => parseMarkdownSections(blackboard?.content ?? ""), [blackboard?.content]);

	const availableTabs = useMemo(() => {
		const tabs: Array<{ id: string; label: string; count?: number; isCustom?: boolean }> = [
			{ id: "all", label: t("groupBlackboardAllConsensus") },
		];
		for (const preset of PRESET_SECTIONS) {
			const found = parsed.sections.find((s) => s.id === preset.id);
			tabs.push({
				id: preset.id,
				label: t(preset.titleKey),
				count: found?.content ? 1 : 0,
			});
		}
		for (const sec of parsed.sections) {
			if (!PRESET_SECTIONS.some((p) => p.id === sec.id)) {
				tabs.push({
					id: sec.id,
					label: sec.title,
					count: sec.content ? 1 : 0,
					isCustom: true,
				});
			}
		}
		return tabs;
	}, [parsed.sections, t]);

	useEffect(() => {
		if (!isEditing) {
			setTitle(blackboard?.title ?? "");
			setContent(blackboard?.content ?? "");
		}
	}, [blackboard, isEditing]);

	const activeSection = useMemo(() => {
		if (activeTab === "all") return null;
		return parsed.sections.find((s) => s.id === activeTab) ?? null;
	}, [activeTab, parsed.sections]);

	const activePresetDef = useMemo(() => {
		return PRESET_SECTIONS.find((p) => p.id === activeTab);
	}, [activeTab]);

	const handleStartEdit = useCallback(() => {
		setError(null);
		if (activeTab === "all") {
			setTitle(blackboard?.title ?? "");
			setContent(blackboard?.content ?? "");
		} else {
			const existing = parsed.sections.find((s) => s.id === activeTab);
			setSectionContent(existing?.content ?? "");
		}
		setIsEditing(true);
	}, [activeTab, blackboard, parsed.sections]);

	const handleCancelEdit = useCallback(() => {
		setIsEditing(false);
		setError(null);
		if (activeTab === "all") {
			setTitle(blackboard?.title ?? "");
			setContent(blackboard?.content ?? "");
		} else {
			setSectionContent("");
		}
	}, [activeTab, blackboard]);

	const handleSave = useCallback(async () => {
		setSaving(true);
		setError(null);
		try {
			const expectedVersion = blackboard?.version ?? 0;

			if (activeTab !== "all") {
				let sectionSaved = false;
				try {
					const secRes = await fetch(
						withToken(
							appUrl(
								`/api/device-center/rooms/${encodeURIComponent(roomId)}/blackboard/sections/${encodeURIComponent(activeTab)}`,
							),
						),
						{
							method: "PUT",
							credentials: "same-origin",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								content: sectionContent,
								expectedVersion,
							}),
						},
					);
					if (secRes.ok) {
						sectionSaved = true;
					}
				} catch {}

				if (!sectionSaved) {
					const sectionTitle = activePresetDef ? t(activePresetDef.titleKey) : activeSection?.title || activeTab;

					const newFullContent = assembleMarkdownSection(
						blackboard?.content ?? "",
						activeTab,
						sectionTitle,
						sectionContent,
					);

					const fullRes = await fetch(
						withToken(appUrl(`/api/device-center/rooms/${encodeURIComponent(roomId)}/blackboard`)),
						{
							method: "PUT",
							credentials: "same-origin",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								title: blackboard?.title || undefined,
								content: newFullContent,
								expectedVersion,
							}),
						},
					);

					const data = await fullRes.json().catch(() => ({}));
					if (!fullRes.ok) {
						if (fullRes.status === 409) {
							throw new Error(t("groupBlackboardVersionConflict"));
						}
						throw new Error(data.error || String(fullRes.status));
					}
				}
			} else {
				if (!content.trim()) {
					setError(t("groupBlackboardContentEmpty"));
					setSaving(false);
					return;
				}

				const response = await fetch(
					withToken(appUrl(`/api/device-center/rooms/${encodeURIComponent(roomId)}/blackboard`)),
					{
						method: "PUT",
						credentials: "same-origin",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							title: title.trim() || undefined,
							content,
							expectedVersion,
						}),
					},
				);

				const data = await response.json().catch(() => ({}));
				if (!response.ok) {
					if (response.status === 409) {
						throw new Error(t("groupBlackboardVersionConflict"));
					}
					throw new Error(data.error || String(response.status));
				}
			}

			setIsEditing(false);
			onSaved?.();
		} catch (err: any) {
			setError(err?.message || t("groupBlackboardSaveFailed"));
		} finally {
			setSaving(false);
		}
	}, [activeTab, blackboard, content, sectionContent, title, roomId, t, activePresetDef, activeSection, onSaved]);

	const currentContentToCopy = useMemo(() => {
		if (activeTab === "all") return blackboard?.content ?? "";
		return activeSection?.content ?? "";
	}, [activeTab, blackboard?.content, activeSection?.content]);

	const formattedTime = blackboard?.updatedAt
		? new Date(blackboard.updatedAt).toLocaleTimeString(locale, {
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			})
		: "";

	const renderPlaceholder = (tabId: string) => {
		switch (tabId) {
			case "architecture":
				return t("groupBlackboardPlaceholderArchitecture");
			case "contracts":
				return t("groupBlackboardPlaceholderContracts");
			case "progress":
				return t("groupBlackboardPlaceholderProgress");
			case "blockers":
				return t("groupBlackboardPlaceholderBlockers");
			default:
				return t("groupBlackboardPlaceholderSection");
		}
	};

	return (
		<div className="dg-blackboard-view">
			<div className="dg-blackboard-header">
				<div className="dg-blackboard-meta">
					<span className="dg-blackboard-badge" title={t("groupBlackboardProtocolVersion")}>
						{blackboard?.version ? `v${blackboard.version}` : t("groupBlackboardUninitialized")}
					</span>
					{blackboard?.updatedBy && (
						<span className="dg-blackboard-updater" title={t("groupBlackboardLastUpdatedBy")}>
							<FiUser style={{ marginRight: 4 }} />
							{blackboard.updatedBy.name} ({blackboard.updatedBy.type === "bot" ? "Bot" : t("groupBlackboardHuman")})
						</span>
					)}
					{formattedTime && (
						<span className="dg-blackboard-time" title={t("groupBlackboardUpdatedAt")}>
							<FiClock style={{ marginRight: 4 }} />
							{formattedTime}
						</span>
					)}
				</div>
				<div className="dg-blackboard-actions">
					<button
						type="button"
						className="btn secondary sm"
						onClick={() => copy(currentContentToCopy)}
						disabled={!currentContentToCopy.trim()}
						title={t("groupBlackboardCopyHint")}
					>
						{copied ? (
							<FiCheck style={{ color: "var(--green)", marginRight: 4 }} />
						) : (
							<FiCopy style={{ marginRight: 4 }} />
						)}
						{copied ? t("copied") : t("copy")}
					</button>

					{!isEditing ? (
						<button
							type="button"
							className="btn secondary sm"
							onClick={handleStartEdit}
							disabled={disabled}
							title={t("groupBlackboardEditHint")}
						>
							<FiEdit3 style={{ marginRight: 4 }} />
							{activeTab === "all" ? t("groupBlackboardEditAll") : t("groupBlackboardEditSection")}
						</button>
					) : (
						<div className="dg-edit-btn-group">
							<button type="button" className="btn secondary sm" onClick={handleCancelEdit} disabled={saving}>
								<FiX style={{ marginRight: 4 }} />
								{t("cancel")}
							</button>
							<button
								type="button"
								className="btn primary sm"
								onClick={handleSave}
								disabled={saving || (activeTab === "all" ? !content.trim() : !sectionContent.trim())}
							>
								{saving ? (
									<FiRefreshCw className="spin" style={{ marginRight: 4 }} />
								) : (
									<FiCheck style={{ marginRight: 4 }} />
								)}
								{saving ? t("groupBlackboardSaving") : t("groupBlackboardSave")}
							</button>
						</div>
					)}
				</div>
			</div>

			<div className="dg-bb-tabs" role="tablist">
				{availableTabs.map((tab) => {
					const isActive = activeTab === tab.id;
					return (
						<button
							key={tab.id}
							type="button"
							role="tab"
							aria-selected={isActive}
							className={`dg-bb-tab ${isActive ? "active" : ""}`}
							onClick={() => {
								if (isEditing) handleCancelEdit();
								setActiveTab(tab.id);
							}}
						>
							{tab.id === "all" && <FiLayers style={{ marginRight: 4 }} />}
							{tab.id === "architecture" && <FiLayers style={{ marginRight: 4 }} />}
							{tab.id === "contracts" && <FiCode style={{ marginRight: 4 }} />}
							{tab.id === "progress" && <FiList style={{ marginRight: 4 }} />}
							{tab.id === "blockers" && <FiAlertTriangle style={{ marginRight: 4 }} />}
							<span>{tab.label}</span>
							{tab.count !== undefined && tab.count > 0 && <span className="dg-bb-tab-dot" />}
						</button>
					);
				})}
			</div>

			{error && (
				<div className="dg-error-banner" role="alert">
					{error}
				</div>
			)}

			{isEditing ? (
				<div className="dg-blackboard-editor">
					{activeTab === "all" ? (
						<>
							<div className="dg-editor-field">
								<label className="dg-field-label">{t("groupBlackboardTitleLabel")}</label>
								<input
									type="text"
									className="dg-input"
									placeholder={t("groupBlackboardTitlePlaceholder")}
									value={title}
									onChange={(e) => setTitle(e.target.value)}
									maxLength={200}
									disabled={saving}
								/>
							</div>
							<div className="dg-editor-field">
								<div className="dg-field-header">
									<label className="dg-field-label">{t("groupBlackboardContentLabel")}</label>
									<span className="dg-field-bytes">{new TextEncoder().encode(content).length} bytes</span>
								</div>
								<textarea
									className="dg-textarea"
									rows={14}
									placeholder={t("groupBlackboardPlaceholderAll")}
									value={content}
									onChange={(e) => setContent(e.target.value)}
									disabled={saving}
								/>
							</div>
						</>
					) : (
						<div className="dg-editor-field">
							<div className="dg-field-header">
								<label className="dg-field-label">
									{t("groupBlackboardEditSectionTitle", {
										section: activePresetDef ? t(activePresetDef.titleKey) : activeSection?.title || activeTab,
									})}
								</label>
								<span className="dg-field-bytes">{new TextEncoder().encode(sectionContent).length} bytes</span>
							</div>
							<textarea
								className="dg-textarea"
								rows={12}
								placeholder={renderPlaceholder(activeTab)}
								value={sectionContent}
								onChange={(e) => setSectionContent(e.target.value)}
								disabled={saving}
							/>
						</div>
					)}
				</div>
			) : (
				<div className="dg-blackboard-content">
					{activeTab === "all" ? (
						<>
							{blackboard?.title && <h3 className="dg-blackboard-title">{blackboard.title}</h3>}
							{blackboard?.content ? (
								<div className="dg-blackboard-markdown">
									<Markdown text={blackboard.content} />
								</div>
							) : (
								<div className="dg-blackboard-empty">
									<FiFileText style={{ fontSize: 32, opacity: 0.4, marginBottom: 8 }} />
									<p>{t("groupBlackboardEmpty")}</p>
								</div>
							)}
						</>
					) : (
						<>
							<div className="dg-bb-section-header">
								<h4 className="dg-bb-section-title">
									{activePresetDef ? t(activePresetDef.titleKey) : activeSection?.title || activeTab}
								</h4>
							</div>
							{activeSection?.content ? (
								<div className="dg-blackboard-markdown">
									<Markdown text={activeSection.content} />
								</div>
							) : (
								<div className="dg-blackboard-empty">
									<FiFileText style={{ fontSize: 32, opacity: 0.4, marginBottom: 8 }} />
									<p>{t("groupBlackboardSectionEmpty")}</p>
								</div>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}
