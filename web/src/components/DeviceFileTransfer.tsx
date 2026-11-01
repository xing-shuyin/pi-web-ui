import { useState, useEffect, useRef } from "react";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { isZhLocale, useI18n } from "../i18n";
import type { GroupDevice } from "../device-group-messages";

export interface TransferFilePreview {
	path: string;
	size: number;
	sha256: string;
	baseline: string | null;
	status: "create" | "identical" | "conflict";
}

export interface TransferItem {
	transferId: string;
	roomId: string;
	sourceBotId: string;
	targetBotId: string;
	totalBytes: number;
	transferredBytes?: number;
	totalFiles: number;
	completedFiles?: number;
	totalChunks: number;
	receivedChunks?: number[];
	status:
		| "queued"
		| "staging"
		| "staged"
		| "ready"
		| "interrupted"
		| "applying"
		| "applied"
		| "cancelling"
		| "cancelled"
		| "failed";
	manifestHash?: string;
	sourceBotRevision: number;
	targetBotRevision: number;
	percent?: number;
	error?: string;
	preview?: {
		id: string;
		revision: string;
		files: TransferFilePreview[];
	};
	files?: TransferFilePreview[];
	revision?: string;
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KiB", "MiB", "GiB"];
	let i = 0;
	let val = bytes;
	while (val >= 1024 && i < units.length - 1) {
		val /= 1024;
		i++;
	}
	return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function request<T>(path: string, signal?: AbortSignal, body?: object): Promise<T> {
	const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
		method: body ? "POST" : "GET",
		credentials: "same-origin",
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
		...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(data.error || String(response.status));
	return data;
}

export function DeviceFileTransfer({
	roomId,
	bots = [],
	disabled = false,
}: {
	roomId: string;
	bots?: GroupDevice[];
	disabled?: boolean;
}) {
	const { locale } = useI18n();
	const zh = isZhLocale(locale);

	const [transfers, setTransfers] = useState<TransferItem[]>([]);
	const [selectedOverwrites, setSelectedOverwrites] = useState<Record<string, Set<string>>>({});
	const [applying, setApplying] = useState(false);
	const [statusMessage, setStatusMessage] = useState("");
	const [error, setError] = useState("");

	// New transfer form state
	const [showNewTransfer, setShowNewTransfer] = useState(false);
	const [sourceBotId, setSourceBotId] = useState("");
	const [targetBotId, setTargetBotId] = useState("");
	const [transferPaths, setTransferPaths] = useState("");
	const [recursive, setRecursive] = useState(true);
	const [starting, setStarting] = useState(false);

	const generationRef = useRef(0);
	const roomRef = useRef(roomId);
	roomRef.current = roomId;
	const controllersRef = useRef(new Set<AbortController>());
	const startKeyRef = useRef<{ fingerprint: string; key: string } | null>(null);
	function operationController() {
		const controller = new AbortController();
		controllersRef.current.add(controller);
		return controller;
	}
	const botNameMap = useRef(new Map<string, string>());

	useEffect(() => {
		botNameMap.current = new Map(bots.map((b) => [b.id, b.name || b.id]));
		setSourceBotId((previous) => (bots.some((bot) => bot.id === previous) ? previous : (bots[0]?.id ?? "")));
		setTargetBotId((previous) => (bots.some((bot) => bot.id === previous) ? previous : (bots[1]?.id ?? "")));
	}, [bots, roomId]);

	function getBotName(botId: string): string {
		return botNameMap.current.get(botId) || botId;
	}

	// Clear state and bump generation when roomId changes to prevent cross-room race
	useEffect(() => {
		generationRef.current++;
		startKeyRef.current = null;
		setStarting(false);
		setApplying(false);
		setTransfers([]);
		setError("");
		setStatusMessage("");
		setSelectedOverwrites({});
		setShowNewTransfer(false);
		setTransferPaths("");
		return () => {
			generationRef.current++;
			for (const controller of controllersRef.current) controller.abort();
			controllersRef.current.clear();
		};
	}, [roomId]);

	// Fetch transfers list with room generation and cancellation
	useEffect(() => {
		if (!roomId) return;
		const gen = generationRef.current;
		let timeoutId: NodeJS.Timeout;
		let activeController: AbortController | null = null;
		let disposed = false;

		async function fetchTransfers() {
			if (disposed || gen !== generationRef.current) return;
			if (document.visibilityState === "hidden") {
				timeoutId = setTimeout(fetchTransfers, 4000);
				return;
			}
			activeController = new AbortController();
			try {
				const res = await request<{ transfers: TransferItem[] }>(
					`rooms/${encodeURIComponent(roomId)}/transfers`,
					activeController.signal,
				);
				if (!disposed && gen === generationRef.current && roomRef.current === roomId && Array.isArray(res?.transfers)) {
					setTransfers(res.transfers);
				}
			} catch {
				// Failed poll ignored; keeps previous state
			} finally {
				if (!disposed && gen === generationRef.current) {
					const hasActive = transfers.some((t) => ["queued", "staging", "cancelling", "applying"].includes(t.status));
					timeoutId = setTimeout(fetchTransfers, hasActive ? 1500 : 4000);
				}
			}
		}

		void fetchTransfers();

		return () => {
			disposed = true;
			clearTimeout(timeoutId);
			activeController?.abort();
		};
	}, [roomId, transfers.length]);

	// Toggle overwrite selection for conflicted files
	const toggleOverwrite = (transferId: string, path: string) => {
		setSelectedOverwrites((prev) => {
			const current = new Set(prev[transferId] || []);
			if (current.has(path)) {
				current.delete(path);
			} else {
				current.add(path);
			}
			return { ...prev, [transferId]: current };
		});
	};

	// Start a deterministic transfer directly via user API
	const handleStartTransfer = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!sourceBotId || !targetBotId || !transferPaths.trim() || starting) return;
		if (sourceBotId === targetBotId) {
			setError(zh ? "源机器人与目标机器人不能相同" : "Source and target bots must be different");
			return;
		}

		const gen = generationRef.current;
		const targetRoom = roomId;
		const ctrl = operationController();

		setStarting(true);
		setError("");
		setStatusMessage(zh ? "正在创建并启动文件传输..." : "Initiating chunked file transfer...");

		try {
			const paths = transferPaths
				.split("\n")
				.map((p) => p.trim())
				.filter(Boolean);

			const fingerprint = JSON.stringify([roomId, sourceBotId, targetBotId, paths, recursive]);
			if (startKeyRef.current?.fingerprint !== fingerprint)
				startKeyRef.current = { fingerprint, key: crypto.randomUUID() };
			const result = await request<TransferItem>(`rooms/${encodeURIComponent(roomId)}/transfers/start`, ctrl.signal, {
				idempotencyKey: startKeyRef.current.key,
				sourceBotId,
				targetBotId,
				paths,
				recursive,
			});

			if (gen !== generationRef.current || targetRoom !== roomRef.current) return;

			setStatusMessage(
				zh
					? `传输任务已成功启动 (ID: ${result.transferId?.slice(0, 8) ?? ""})，正在后台分块传输中。`
					: `Transfer started (ID: ${result.transferId?.slice(0, 8) ?? ""}), streaming chunks in background.`,
			);
			setShowNewTransfer(false);
			setTransferPaths("");
			startKeyRef.current = null;

			const latest = await request<{ transfers: TransferItem[] }>(
				`rooms/${encodeURIComponent(roomId)}/transfers`,
				ctrl.signal,
			);
			if (gen === generationRef.current && targetRoom === roomRef.current && Array.isArray(latest?.transfers)) {
				setTransfers(latest.transfers);
			}
		} catch (err) {
			if (gen === generationRef.current && targetRoom === roomRef.current) {
				setError(err instanceof Error ? err.message : String(err));
			}
		} finally {
			controllersRef.current.delete(ctrl);
			if (gen === generationRef.current && targetRoom === roomRef.current) {
				setStarting(false);
			}
		}
	};

	// Apply staged transfer with explicit decisions
	const handleApply = async (item: TransferItem) => {
		const preview =
			item.preview ||
			(item.files ? { id: item.transferId, revision: item.revision || "", files: item.files } : undefined);
		if (!preview || applying) return;

		const gen = generationRef.current;
		const targetRoom = roomId;
		const ctrl = operationController();

		setApplying(true);
		setError("");
		setStatusMessage(zh ? "正在导入文件变更..." : "Applying file changes...");

		try {
			const overwrites = Array.from(selectedOverwrites[item.transferId] || []);
			const result = await request<any>(
				`rooms/${encodeURIComponent(roomId)}/transfers/${encodeURIComponent(item.transferId)}/apply`,
				ctrl.signal,
				{
					revision: preview.revision,
					overwritePaths: overwrites,
				},
			);

			if (gen !== generationRef.current || targetRoom !== roomRef.current) return;

			setStatusMessage(
				zh
					? `导入成功：已应用 ${result.applied?.length ?? 0} 个文件，未变 ${result.unchanged?.length ?? 0} 个`
					: `Apply successful: applied ${result.applied?.length ?? 0}, unchanged ${result.unchanged?.length ?? 0}`,
			);
			setTransfers((prev) => prev.map((t) => (t.transferId === item.transferId ? { ...t, status: "applied" } : t)));
		} catch (err) {
			if (gen === generationRef.current && targetRoom === roomRef.current) {
				setError(err instanceof Error ? err.message : String(err));
			}
		} finally {
			controllersRef.current.delete(ctrl);
			if (gen === generationRef.current && targetRoom === roomRef.current) {
				setApplying(false);
			}
		}
	};

	// Abort in-flight transfer
	const handleAbort = async (item: TransferItem) => {
		const gen = generationRef.current;
		const targetRoom = roomId;
		const ctrl = operationController();

		try {
			await request<any>(
				`rooms/${encodeURIComponent(roomId)}/transfers/${encodeURIComponent(item.transferId)}/abort`,
				ctrl.signal,
				{},
			);
			if (gen !== generationRef.current || targetRoom !== roomRef.current) return;

			setTransfers((prev) => prev.map((t) => (t.transferId === item.transferId ? { ...t, status: "cancelled" } : t)));
			setStatusMessage(zh ? "传输已取消，暂存文件与配额已物理释放" : "Transfer aborted; staged quota freed");
		} catch (err) {
			if (gen === generationRef.current && targetRoom === roomRef.current) {
				setError(err instanceof Error ? err.message : String(err));
			}
		} finally {
			controllersRef.current.delete(ctrl);
		}
	};

	const handleResume = async (item: TransferItem) => {
		const gen = generationRef.current;
		const targetRoom = roomId;
		const ctrl = operationController();
		try {
			const result = await request<TransferItem>(
				`rooms/${encodeURIComponent(targetRoom)}/transfers/${encodeURIComponent(item.transferId)}/resume`,
				ctrl.signal,
				{
					manifestHash: item.manifestHash,
					sourceBotRevision: item.sourceBotRevision,
					targetBotRevision: item.targetBotRevision,
				},
			);
			if (gen === generationRef.current && targetRoom === roomRef.current)
				setTransfers((prev) => prev.map((t) => (t.transferId === item.transferId ? result : t)));
		} catch (err) {
			if (gen === generationRef.current && targetRoom === roomRef.current)
				setError(err instanceof Error ? err.message : String(err));
		} finally {
			controllersRef.current.delete(ctrl);
		}
	};

	const stagingCount = transfers.filter((t) => ["queued", "staging", "cancelling"].includes(t.status)).length;
	const stagedCount = transfers.filter((t) => t.status === "staged" || t.status === "ready").length;

	return (
		<details className="dft-panel" open={transfers.length > 0}>
			<summary className="dft-summary">
				<span className="dft-title-icon">📦</span>
				<span>{zh ? "跨机大文件传输与断点续传" : "Cross-Device Chunked File Transfers"}</span>
				{transfers.length > 0 && (
					<span className="dft-badge">
						{stagingCount > 0
							? zh
								? `${stagingCount} 个传输中`
								: `${stagingCount} streaming`
							: stagedCount > 0
								? zh
									? `${stagedCount} 个待导入`
									: `${stagedCount} staged`
								: `${transfers.length}`}
					</span>
				)}
			</summary>
			<div className="dft-content">
				{error && (
					<div className="dft-alert dft-alert-error" role="alert">
						{error}
					</div>
				)}
				{statusMessage && <div className="dft-alert dft-alert-info">{statusMessage}</div>}

				{/* Header actions: toggle new transfer */}
				<div className="dft-toolbar">
					<button
						type="button"
						className="btn dft-btn-toggle"
						onClick={() => setShowNewTransfer((v) => !v)}
						disabled={disabled || bots.length < 2}
					>
						{showNewTransfer
							? zh
								? "收起传输表单"
								: "Close Transfer Form"
							: zh
								? "+ 发起新文件/目录传输"
								: "+ New File/Directory Transfer"}
					</button>
				</div>

				{/* New transfer start form */}
				{showNewTransfer && (
					<form className="dft-start-form" onSubmit={handleStartTransfer}>
						<div className="dft-form-row">
							<label className="dft-form-label">
								<span>{zh ? "源机器人 (发送端)" : "Source Bot (Sender)"}</span>
								<select
									className="dft-select"
									value={sourceBotId}
									onChange={(e) => setSourceBotId(e.target.value)}
									disabled={disabled || starting}
								>
									{bots.map((b) => (
										<option key={b.id} value={b.id}>
											{b.name || b.id} ({b.id.slice(0, 8)})
										</option>
									))}
								</select>
							</label>

							<label className="dft-form-label">
								<span>{zh ? "目标机器人 (接收端)" : "Target Bot (Receiver)"}</span>
								<select
									className="dft-select"
									value={targetBotId}
									onChange={(e) => setTargetBotId(e.target.value)}
									disabled={disabled || starting}
								>
									{bots
										.filter((b) => b.id !== sourceBotId)
										.map((b) => (
											<option key={b.id} value={b.id}>
												{b.name || b.id} ({b.id.slice(0, 8)})
											</option>
										))}
								</select>
							</label>
						</div>

						<div className="dft-form-row">
							<label className="dft-form-label full-width">
								<span>{zh ? "相对路径（文件或目录，每行一个）" : "Project-relative paths (one per line)"}</span>
								<textarea
									className="dft-textarea"
									rows={2}
									placeholder={zh ? "如: src/ 或 large-asset.bin" : "e.g. src/ or data/model.weights"}
									value={transferPaths}
									onChange={(e) => setTransferPaths(e.target.value)}
									disabled={disabled || starting}
								/>
							</label>
						</div>

						<div className="dft-form-footer">
							<label className="dft-checkbox-label">
								<input
									type="checkbox"
									checked={recursive}
									onChange={(e) => setRecursive(e.target.checked)}
									disabled={disabled || starting}
								/>
								<span>{zh ? "递归包含子目录 (recursive)" : "Recursive directory traversal"}</span>
							</label>

							<button
								type="submit"
								className="btn primary dft-btn-submit"
								disabled={disabled || starting || !transferPaths.trim() || sourceBotId === targetBotId}
							>
								{starting ? (zh ? "启动中..." : "Starting...") : zh ? "开始分块传输" : "Start Transfer"}
							</button>
						</div>
					</form>
				)}

				{/* Active & Staged Transfers list */}
				{transfers.length === 0 ? (
					<div className="dft-empty">
						<p>{zh ? "当前群暂无文件传输记录。" : "No active file transfers in this room."}</p>
						<span className="dft-hint">
							{zh
								? "支持突破 8MiB 限制的大文件及 >128 文件的目录分块传输。发起后将在此实时展示进度与断点续传状态。"
								: "Supports >8MiB files and 128+ file directories. Live progress, chunk checksums and resume controls appear here."}
						</span>
					</div>
				) : (
					<div className="dft-transfers-list">
						{transfers.map((item) => {
							const percent = Math.min(100, Math.max(0, item.percent ?? 0));
							const previewFiles = item.preview?.files || item.files || [];
							const overwriteSet = selectedOverwrites[item.transferId] || new Set();

							return (
								<div key={item.transferId} className={`dft-card dft-card-${item.status}`}>
									<div className="dft-card-header">
										<div className="dft-route">
											<span className="dft-bot-name">{getBotName(item.sourceBotId)}</span>
											<span className="dft-arrow">➔</span>
											<span className="dft-bot-name">{getBotName(item.targetBotId)}</span>
											<span className="dft-id-badge" title={item.transferId}>
												{item.transferId.slice(0, 8)}
											</span>
										</div>
										<span className={`dft-status-tag dft-tag-${item.status}`}>
											{item.status === "staging" && (zh ? "分块传输中" : "Streaming")}
											{(item.status === "staged" || item.status === "ready") && (zh ? "待确认导入" : "Ready")}
											{item.status === "queued" && (zh ? "排队中" : "Queued")}
											{item.status === "interrupted" && (zh ? "已中断" : "Interrupted")}
											{item.status === "cancelling" && (zh ? "取消中" : "Cancelling")}
											{item.status === "applying" && (zh ? "导入中" : "Applying")}
											{item.status === "applied" && (zh ? "已导入" : "Applied")}
											{item.status === "cancelled" && (zh ? "已取消" : "Cancelled")}
											{item.status === "failed" && (zh ? "失败" : "Failed")}
										</span>
									</div>

									<div className="dft-metrics">
										<span>
											{zh ? "文件: " : "Files: "}
											<strong>{item.totalFiles}</strong>
										</span>
										<span>
											{zh ? "大小: " : "Size: "}
											<strong>{formatBytes(item.totalBytes)}</strong>
										</span>
										<span>
											{zh ? "分块: " : "Chunks: "}
											<strong>
												{item.receivedChunks?.length ?? 0} / {item.totalChunks}
											</strong>
										</span>
									</div>

									{/* Progress Bar */}
									<div className="dft-progress-bar-wrap">
										<div className="dft-progress-bar" style={{ width: `${percent}%` }} />
									</div>
									<div className="dft-progress-label">
										<span>{percent}%</span>
										<span className="dft-hash-status">
											{item.status === "staged" || item.status === "ready" || item.status === "applied"
												? zh
													? "✓ SHA256 完整校验通过"
													: "✓ SHA256 Verified"
												: zh
													? "32KiB 有界分块传输与断点校验中"
													: "32KiB Bounded Chunk Streaming"}
										</span>
									</div>

									{/* Staged Preview Section */}
									{previewFiles.length > 0 && (
										<div className="dft-preview-section">
											<div className="dft-preview-title">{zh ? "变更差异预览：" : "File Changes Preview:"}</div>
											<div className="dft-files-table">
												{previewFiles.map((file) => (
													<div key={file.path} className={`dft-file-row dft-file-${file.status}`}>
														<span className="dft-file-status-icon">
															{file.status === "create" && "➕"}
															{file.status === "identical" && "✓"}
															{file.status === "conflict" && "⚠️"}
														</span>
														<span className="dft-file-path" title={file.path}>
															{file.path}
														</span>
														<span className="dft-file-size">{formatBytes(file.size)}</span>
														{file.status === "conflict" && (
															<label className="dft-overwrite-toggle">
																<input
																	type="checkbox"
																	checked={overwriteSet.has(file.path)}
																	onChange={() => toggleOverwrite(item.transferId, file.path)}
																	disabled={disabled || (item.status !== "staged" && item.status !== "ready")}
																/>
																<span>{zh ? "显式覆盖" : "Overwrite"}</span>
															</label>
														)}
													</div>
												))}
											</div>
										</div>
									)}

									{/* Action buttons */}
									<div className="dft-card-actions">
										{item.status === "interrupted" && item.manifestHash && (
											<button type="button" className="btn" disabled={disabled} onClick={() => handleResume(item)}>
												{zh ? "按原版本续传" : "Resume saved version"}
											</button>
										)}
										{["queued", "staging", "ready", "interrupted", "failed"].includes(item.status) && (
											<button
												type="button"
												className="btn dft-btn-abort"
												onClick={() => handleAbort(item)}
												disabled={disabled}
											>
												{zh ? "取消传输" : "Abort Transfer"}
											</button>
										)}
										{(item.status === "staged" || item.status === "ready") && (
											<button
												type="button"
												className="btn primary dft-btn-apply"
												onClick={() => handleApply(item)}
												disabled={disabled || applying}
											>
												{applying ? (zh ? "导入中..." : "Applying...") : zh ? "确认导入变更 (Apply)" : "Confirm Apply"}
											</button>
										)}
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</details>
	);
}
