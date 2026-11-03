import { useState, useCallback, useEffect } from "react";
import { FiEdit3, FiCheck, FiX, FiRefreshCw, FiFileText, FiClock, FiUser } from "react-icons/fi";
import { Markdown } from "./Markdown";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { isZhLocale, useI18n } from "../i18n";
import type { GroupBlackboard } from "../../../server/device-center/store";

interface GroupBlackboardViewProps {
	roomId: string;
	blackboard?: GroupBlackboard | null;
	disabled?: boolean;
	onSaved?: () => void;
}

export function GroupBlackboardView({ roomId, blackboard, disabled = false, onSaved }: GroupBlackboardViewProps) {
	const { locale } = useI18n();
	const zh = isZhLocale(locale);

	const [isEditing, setIsEditing] = useState(false);
	const [title, setTitle] = useState(blackboard?.title ?? "");
	const [content, setContent] = useState(blackboard?.content ?? "");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Sync when props change if not currently editing
	useEffect(() => {
		if (!isEditing) {
			setTitle(blackboard?.title ?? "");
			setContent(blackboard?.content ?? "");
		}
	}, [blackboard, isEditing]);

	const handleStartEdit = useCallback(() => {
		setTitle(blackboard?.title ?? "");
		setContent(blackboard?.content ?? "");
		setError(null);
		setIsEditing(true);
	}, [blackboard]);

	const handleCancelEdit = useCallback(() => {
		setIsEditing(false);
		setError(null);
		setTitle(blackboard?.title ?? "");
		setContent(blackboard?.content ?? "");
	}, [blackboard]);

	const handleSave = useCallback(async () => {
		if (!content.trim()) {
			setError(zh ? "黑板内容不能为空" : "Blackboard content cannot be empty");
			return;
		}

		setSaving(true);
		setError(null);
		try {
			const expectedVersion = blackboard?.version ?? 0;
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
					throw new Error(
						zh
							? "黑板已被其他成员更新，版本发生冲突，请刷新后重试。"
							: "Blackboard has been updated by another member (version conflict). Refresh and retry.",
					);
				}
				throw new Error(data.error || String(response.status));
			}

			setIsEditing(false);
			onSaved?.();
		} catch (err: any) {
			setError(err?.message || (zh ? "保存黑板失败" : "Failed to save blackboard"));
		} finally {
			setSaving(false);
		}
	}, [roomId, content, title, blackboard, zh, onSaved]);

	const formattedTime = blackboard?.updatedAt
		? new Date(blackboard.updatedAt).toLocaleTimeString(locale, {
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			})
		: "";

	return (
		<div className="dg-blackboard-view">
			<div className="dg-blackboard-header">
				<div className="dg-blackboard-meta">
					<span className="dg-blackboard-badge">
						{blackboard?.version ? `v${blackboard.version}` : zh ? "未初始化" : "Initial"}
					</span>
					{blackboard?.updatedBy && (
						<span className="dg-blackboard-updater" title={zh ? "最后更新者" : "Last updated by"}>
							<FiUser style={{ marginRight: 4 }} />
							{blackboard.updatedBy.name} ({blackboard.updatedBy.type === "bot" ? "Bot" : zh ? "人工" : "Human"})
						</span>
					)}
					{formattedTime && (
						<span className="dg-blackboard-time" title={zh ? "更新时间" : "Updated at"}>
							<FiClock style={{ marginRight: 4 }} />
							{formattedTime}
						</span>
					)}
				</div>
				<div className="dg-blackboard-actions">
					{!isEditing ? (
						<button
							type="button"
							className="btn secondary sm"
							onClick={handleStartEdit}
							disabled={disabled}
							title={zh ? "编辑黑板内容" : "Edit blackboard content"}
						>
							<FiEdit3 style={{ marginRight: 4 }} />
							{zh ? "编辑共识" : "Edit Consensus"}
						</button>
					) : (
						<div className="dg-edit-btn-group">
							<button type="button" className="btn secondary sm" onClick={handleCancelEdit} disabled={saving}>
								<FiX style={{ marginRight: 4 }} />
								{zh ? "取消" : "Cancel"}
							</button>
							<button
								type="button"
								className="btn primary sm"
								onClick={handleSave}
								disabled={saving || !content.trim()}
							>
								{saving ? (
									<FiRefreshCw className="spin" style={{ marginRight: 4 }} />
								) : (
									<FiCheck style={{ marginRight: 4 }} />
								)}
								{saving ? (zh ? "保存中..." : "Saving...") : zh ? "提交共识" : "Save"}
							</button>
						</div>
					)}
				</div>
			</div>

			{error && (
				<div className="dg-error-banner" role="alert">
					{error}
				</div>
			)}

			{isEditing ? (
				<div className="dg-blackboard-editor">
					<div className="dg-editor-field">
						<label className="dg-field-label">{zh ? "共识主题 / 标题 (可选)" : "Title / Subject (Optional)"}</label>
						<input
							type="text"
							className="dg-input"
							placeholder={zh ? "例如：系统统一重构规范 (RFC-089)" : "e.g. Unified System Redesign RFC"}
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							maxLength={200}
							disabled={saving}
						/>
					</div>
					<div className="dg-editor-field">
						<div className="dg-field-header">
							<label className="dg-field-label">
								{zh ? "结构化 Markdown 内容 (支持规范、任务契约与待办)" : "Structured Markdown Content"}
							</label>
							<span className="dg-field-bytes">{new TextEncoder().encode(content).length} bytes</span>
						</div>
						<textarea
							className="dg-textarea"
							rows={14}
							placeholder={
								zh
									? "# 群组共享共识\n\n## 架构契约\n- 统一事件模型\n- 接口规范定义\n\n## 任务流水线\n- [ ] BotA: 调研接口\n- [ ] BotB: 实现测试"
									: "# Shared Consensus\n\n## Architecture Contract\n- Unified event model\n\n## Pipeline\n- [ ] BotA: Draft interfaces"
							}
							value={content}
							onChange={(e) => setContent(e.target.value)}
							disabled={saving}
						/>
					</div>
				</div>
			) : (
				<div className="dg-blackboard-content">
					{blackboard?.title && <h3 className="dg-blackboard-title">{blackboard.title}</h3>}
					{blackboard?.content ? (
						<div className="dg-blackboard-markdown">
							<Markdown text={blackboard.content} />
						</div>
					) : (
						<div className="dg-blackboard-empty">
							<FiFileText style={{ fontSize: 32, opacity: 0.4, marginBottom: 8 }} />
							<p>
								{zh
									? "当前群组黑板为空。点击右上角“编辑共识”为所有协作 Bot 确立技术架构契约与长期记忆。"
									: "Blackboard is empty. Click 'Edit Consensus' to set shared contracts and long-term memory."}
							</p>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
