import { useState, useEffect, useRef } from "react";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
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
	applyStarted?: boolean;
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
	const t = useT();

	const [transfers, setTransfers] = useState<TransferItem[]>([]);
	const [selectedOverwrites, setSelectedOverwrites] = useState<Record<string, Set<string>>>({});
	const [applying, setApplying] = useState(false);
	const [statusMessage, setStatusMessage] = useState("");
	const [error, setError] = useState("");

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

	const handleStartTransfer = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!sourceBotId || !targetBotId || !transferPaths.trim() || starting) return;
		if (sourceBotId === targetBotId) {
			setError(t("deviceFileTransferSameBotError"));
			return;
		}

		const gen = generationRef.current;
		const targetRoom = roomId;
		const ctrl = operationController();

		setStarting(true);
		setError("");
		setStatusMessage(t("deviceFileTransferStartingStatus"));

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

			setStatusMessage(t("deviceFileTransferStarted", { id: result.transferId?.slice(0, 8) ?? "" }));
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
		setStatusMessage(t("deviceFileTransferApplyingStatus"));

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
				t("deviceFileTransferApplied", {
					applied: result.applied?.length ?? 0,
					unchanged: result.unchanged?.length ?? 0,
				}),
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
			setStatusMessage(t("deviceFileTransferAborted"));
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
				<span>{t("deviceFileTransferTitle")}</span>
				{transfers.length > 0 && (
					<span className="dft-badge">
						{stagingCount > 0
							? t("deviceFileTransferStreamingCount", { count: stagingCount })
							: stagedCount > 0
								? t("deviceFileTransferStagedCount", { count: stagedCount })
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

				<div className="dft-toolbar">
					<button
						type="button"
						className="btn dft-btn-toggle"
						onClick={() => setShowNewTransfer((v) => !v)}
						disabled={disabled || bots.length < 2}
					>
						{showNewTransfer ? t("deviceFileTransferCloseForm") : t("deviceFileTransferNewTransfer")}
					</button>
				</div>

				{showNewTransfer && (
					<form className="dft-start-form" onSubmit={handleStartTransfer}>
						<div className="dft-form-row">
							<label className="dft-form-label">
								<span>{t("deviceFileTransferSourceBot")}</span>
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
								<span>{t("deviceFileTransferTargetBot")}</span>
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
								<span>{t("deviceFileTransferPathsLabel")}</span>
								<textarea
									className="dft-textarea"
									rows={2}
									placeholder={t("deviceFileTransferPathsPlaceholder")}
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
								<span>{t("deviceFileTransferRecursive")}</span>
							</label>

							<button
								type="submit"
								className="btn primary dft-btn-submit"
								disabled={disabled || starting || !transferPaths.trim() || sourceBotId === targetBotId}
							>
								{starting ? t("deviceFileTransferStarting") : t("deviceFileTransferStart")}
							</button>
						</div>
					</form>
				)}

				{transfers.length === 0 ? (
					<div className="dft-empty">
						<p>{t("deviceFileTransferEmpty")}</p>
						<span className="dft-hint">{t("deviceFileTransferEmptyHint")}</span>
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
											{item.status === "staging" && t("deviceFileTransferStatusStaging")}
											{(item.status === "staged" || item.status === "ready") && t("deviceFileTransferStatusReady")}
											{item.status === "queued" && t("groupWorkItemsStatusQueued")}
											{item.status === "interrupted" && t("groupWorkItemsStatusInterrupted")}
											{item.status === "cancelling" && t("deviceFileTransferStatusCancelling")}
											{item.status === "applying" && t("deviceFileTransferStatusApplying")}
											{item.status === "applied" && t("deviceFileTransferStatusApplied")}
											{item.status === "cancelled" && t("cancelled")}
											{item.status === "failed" && t("groupWorkItemsStatusFailed")}
										</span>
									</div>

									<div className="dft-metrics">
										<span>
											{t("deviceFileTransferMetricFiles")}
											<strong>{item.totalFiles != null ? item.totalFiles : "-"}</strong>
										</span>
										<span>
											{t("deviceFileTransferMetricSize")}
											<strong>{item.totalBytes != null ? formatBytes(item.totalBytes) : "-"}</strong>
										</span>
										<span>
											{t("deviceFileTransferMetricChunks")}
											<strong>
												{item.totalChunks != null ? `${item.receivedChunks?.length ?? 0} / ${item.totalChunks}` : "-"}
											</strong>
										</span>
									</div>

									<div className="dft-progress-bar-wrap">
										<div className="dft-progress-bar" style={{ width: `${percent}%` }} />
									</div>
									<div className="dft-progress-label">
										<span>{percent}%</span>
										<span className="dft-hash-status">
											{item.status === "staged" || item.status === "ready" || item.status === "applied"
												? t("deviceFileTransferHashVerified")
												: item.status === "cancelled"
													? t("deviceFileTransferHashCancelled")
													: item.status === "failed"
														? t("deviceFileTransferHashFailed")
														: item.status === "interrupted"
															? t("deviceFileTransferHashInterrupted")
															: t("deviceFileTransferHashStreaming")}
										</span>
									</div>

									{item.error && (
										<div className="dft-item-error" title={item.error}>
											{item.error}
										</div>
									)}

									{previewFiles.length > 0 && (
										<div className="dft-preview-section">
											<div className="dft-preview-title">{t("deviceFileTransferPreviewTitle")}</div>
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
																<span>{t("deviceFileTransferOverwrite")}</span>
															</label>
														)}
													</div>
												))}
											</div>
										</div>
									)}

									<div className="dft-card-actions">
										{item.status === "interrupted" && item.manifestHash && (
											<button type="button" className="btn" disabled={disabled} onClick={() => handleResume(item)}>
												{t("deviceFileTransferResume")}
											</button>
										)}
										{!item.applyStarted &&
											["queued", "staging", "ready", "interrupted", "failed"].includes(item.status) && (
												<button
													type="button"
													className="btn dft-btn-abort"
													onClick={() => handleAbort(item)}
													disabled={disabled}
												>
													{t("deviceFileTransferAbort")}
												</button>
											)}
										{(item.status === "staged" || item.status === "ready") && (
											<button
												type="button"
												className="btn primary dft-btn-apply"
												onClick={() => handleApply(item)}
												disabled={disabled || applying}
											>
												{applying ? t("deviceFileTransferApplying") : t("deviceFileTransferConfirmApply")}
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
