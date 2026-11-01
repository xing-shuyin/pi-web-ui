import { useEffect, useRef, useState } from "react";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import type { GroupDevice } from "../device-group-messages";
import type { DeviceDelivery, DeviceIntegration, DeviceReview } from "../types";

async function request<T>(path: string, signal: AbortSignal, body?: object, timeoutMs = 30000): Promise<T> {
	const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
		method: body ? "POST" : "GET",
		credentials: "same-origin",
		signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
		...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(data.error || String(response.status));
	return data;
}

export interface GroupIntegrationProps {
	roomId: string;
	conversationId: string;
	delivery: DeviceDelivery;
	review: DeviceReview;
	bots: GroupDevice[];
	disabled?: boolean;
	zh: boolean;
}

export function GroupIntegration({
	roomId,
	conversationId,
	delivery,
	review,
	bots,
	disabled = false,
	zh,
}: GroupIntegrationProps) {
	const [, setIntegrations] = useState<DeviceIntegration[]>([]);
	const [activeIntegration, setActiveIntegration] = useState<DeviceIntegration | null>(null);
	const [targetBotId, setTargetBotId] = useState<string>(delivery.botId || bots[0]?.id || "");
	const [targetBranch, setTargetBranch] = useState<string>(delivery.branch || "main");
	const [selectedCommands, setSelectedCommands] = useState<string[]>([]);
	const [customCommand, setCustomCommand] = useState<string>("");
	const [busy, setBusy] = useState<boolean>(false);
	const [error, setError] = useState<string>("");
	const [isOpen, setIsOpen] = useState<boolean>(false);

	const controllerRef = useRef<AbortController | null>(null);
	const generationRef = useRef(0);

	const basePath = `rooms/${encodeURIComponent(roomId)}/conversations/${encodeURIComponent(conversationId)}/integrations`;

	// 当所属 room, conversation, delivery 或 review 切换，或者用户展开时才拉取
	useEffect(() => {
		if (!isOpen) {
			controllerRef.current?.abort();
			return;
		}
		const generation = ++generationRef.current;
		controllerRef.current?.abort();
		const ctrl = new AbortController();
		controllerRef.current = ctrl;

		setError("");

		async function load() {
			try {
				const res = await request<{ integrations: DeviceIntegration[] }>(basePath, ctrl.signal, undefined, 15000);
				if (ctrl.signal.aborted || generation !== generationRef.current) return;
				const list = res.integrations || [];
				setIntegrations(list);
				const current = list.filter((it) => it.deliveryId === delivery.id).sort((a, b) => b.createdAt - a.createdAt)[0];
				setActiveIntegration(current || null);
			} catch {
				if (!ctrl.signal.aborted && generation === generationRef.current) {
					// 不吞静默失败，保留状态刷新
				}
			}
		}

		void load();

		return () => {
			ctrl.abort();
		};
	}, [isOpen, roomId, conversationId, delivery.id, delivery.commit, review.id]);

	// 准备集成（在隔离 worktree 中检出并尝试预合并）
	async function handlePrepare() {
		if (disabled || busy || !targetBotId) return;
		const generation = generationRef.current;
		controllerRef.current?.abort();
		const ctrl = new AbortController();
		controllerRef.current = ctrl;

		setBusy(true);
		setError("");
		try {
			const res = await request<{ integration: DeviceIntegration }>(
				basePath,
				ctrl.signal,
				{
					deliveryId: delivery.id,
					targetBotId,
					targetBranch: targetBranch.trim() || "main",
				},
				60000,
			);
			if (ctrl.signal.aborted || generation !== generationRef.current) return;
			setActiveIntegration(res.integration);
			setIntegrations((prev) => [res.integration, ...prev.filter((it) => it.id !== res.integration.id)]);
		} catch (err) {
			if (!ctrl.signal.aborted && generation === generationRef.current) {
				setError(err instanceof Error ? err.message : String(err));
			}
		} finally {
			if (generation === generationRef.current) {
				setBusy(false);
			}
		}
	}

	// 运行选中的验证命令（HTTP 允许至多 120s）
	async function handleVerify() {
		if (disabled || busy || !activeIntegration) return;
		const commandsToRun = [...selectedCommands];
		if (customCommand.trim() && !commandsToRun.includes(customCommand.trim())) {
			commandsToRun.push(customCommand.trim());
		}
		if (commandsToRun.length === 0) {
			setError(zh ? "请勾选或输入至少一条验证命令" : "Select or enter at least one validation command");
			return;
		}

		const generation = generationRef.current;
		controllerRef.current?.abort();
		const ctrl = new AbortController();
		controllerRef.current = ctrl;

		setBusy(true);
		setError("");
		try {
			const res = await request<{ integration: DeviceIntegration }>(
				`${basePath}/${encodeURIComponent(activeIntegration.id)}/verify`,
				ctrl.signal,
				{ commands: commandsToRun },
				120000,
			);
			if (ctrl.signal.aborted || generation !== generationRef.current) return;
			setActiveIntegration(res.integration);
			setIntegrations((prev) => prev.map((it) => (it.id === res.integration.id ? res.integration : it)));
		} catch (err) {
			if (!ctrl.signal.aborted && generation === generationRef.current) {
				setError(err instanceof Error ? err.message : String(err));
			}
		} finally {
			if (generation === generationRef.current) {
				setBusy(false);
			}
		}
	}

	// 用户最后明确确认后才写入目标 branch
	async function handleApply() {
		if (disabled || busy || !activeIntegration) return;
		const generation = generationRef.current;
		controllerRef.current?.abort();
		const ctrl = new AbortController();
		controllerRef.current = ctrl;

		setBusy(true);
		setError("");
		try {
			const res = await request<{ integration: DeviceIntegration }>(
				`${basePath}/${encodeURIComponent(activeIntegration.id)}/apply`,
				ctrl.signal,
				{ expectedTargetSha: activeIntegration.expectedTargetSha },
				60000,
			);
			if (ctrl.signal.aborted || generation !== generationRef.current) return;
			setActiveIntegration(res.integration);
			setIntegrations((prev) => prev.map((it) => (it.id === res.integration.id ? res.integration : it)));
		} catch (err) {
			if (!ctrl.signal.aborted && generation === generationRef.current) {
				setError(err instanceof Error ? err.message : String(err));
			}
		} finally {
			if (generation === generationRef.current) {
				setBusy(false);
			}
		}
	}

	// 取消集成
	async function handleCancel() {
		if (disabled || busy || !activeIntegration) return;
		const generation = generationRef.current;
		controllerRef.current?.abort();
		const ctrl = new AbortController();
		controllerRef.current = ctrl;

		setBusy(true);
		setError("");
		try {
			const res = await request<{ integration: DeviceIntegration }>(
				`${basePath}/${encodeURIComponent(activeIntegration.id)}/cancel`,
				ctrl.signal,
				undefined,
				30000,
			);
			if (ctrl.signal.aborted || generation !== generationRef.current) return;
			setActiveIntegration(res.integration);
			setIntegrations((prev) => prev.map((it) => (it.id === res.integration.id ? res.integration : it)));
		} catch (err) {
			if (!ctrl.signal.aborted && generation === generationRef.current) {
				setError(err instanceof Error ? err.message : String(err));
			}
		} finally {
			if (generation === generationRef.current) {
				setBusy(false);
			}
		}
	}

	const isApplied = activeIntegration?.status === "applied";
	const isConflict = activeIntegration?.status === "conflict";
	const isCancelled = activeIntegration?.status === "cancelled";
	const canVerify = activeIntegration?.status === "prepared" || activeIntegration?.status === "verified";
	const canApply = canVerify || activeIntegration?.status === "failed";

	return (
		<details
			className="gi-panel"
			onToggle={(e) => setIsOpen(e.currentTarget.open)}
			style={{ marginTop: "1rem", borderTop: "1px solid var(--border)", paddingTop: "0.75rem" }}
		>
			<summary style={{ cursor: "pointer", fontWeight: 600, fontSize: "0.95rem" }}>
				{zh ? "工程集成流水线" : "Engineering Integration Pipeline"} ·{" "}
				{isApplied
					? zh
						? "已合并"
						: "Merged"
					: activeIntegration
						? activeIntegration.status
						: zh
							? "待集成"
							: "Ready to integrate"}
			</summary>
			<div style={{ marginTop: "0.5rem" }}>
				<p style={{ margin: "0 0 0.5rem 0", fontSize: "0.85rem", color: "var(--text-faint)" }}>
					{zh
						? `已绑定交付 SHA (${delivery.commit.slice(0, 8)}) 与独立验收审查。在隔离工作树中安全预集成与验证，用户明确确认后才写入目标分支。`
						: `Bound to delivery SHA (${delivery.commit.slice(0, 8)}) and accepted review. Integrates in an isolated worktree; only writes to target branch upon explicit confirmation.`}
				</p>

				{error && (
					<p role="alert" style={{ color: "var(--red, #f43f5e)", fontSize: "0.85rem", margin: "0.25rem 0" }}>
						{error}
					</p>
				)}

				{!activeIntegration || isCancelled ? (
					<div className="gi-prepare-form" style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
						<div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
							<label style={{ fontSize: "0.85rem" }}>
								{zh ? "目标工作区 (Bot):" : "Target Bot Workspace:"}
								<select
									value={targetBotId}
									onChange={(e) => setTargetBotId(e.target.value)}
									disabled={disabled || busy}
									style={{ marginLeft: "0.25rem" }}
								>
									{bots.map((b) => (
										<option key={b.id} value={b.id}>
											{b.name || b.id}
										</option>
									))}
								</select>
							</label>

							<label style={{ fontSize: "0.85rem" }}>
								{zh ? "目标分支:" : "Target Branch:"}
								<input
									type="text"
									value={targetBranch}
									onChange={(e) => setTargetBranch(e.target.value)}
									disabled={disabled || busy}
									style={{ marginLeft: "0.25rem", width: "120px" }}
								/>
							</label>

							<button
								type="button"
								className="btn primary"
								disabled={disabled || busy || !targetBotId}
								onClick={() => void handlePrepare()}
							>
								{busy ? (zh ? "准备中…" : "Preparing…") : zh ? "准备隔离集成" : "Prepare Isolated Integration"}
							</button>
						</div>
					</div>
				) : (
					<div className="gi-active-task" style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
						<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
							<span style={{ fontSize: "0.85rem", fontWeight: 600 }}>
								{zh ? "集成状态: " : "Status: "}
								<span
									style={{
										color: isApplied ? "var(--green, #10b981)" : isConflict ? "var(--red, #f43f5e)" : "var(--accent)",
									}}
								>
									{activeIntegration.status}
								</span>
							</span>
							{!isApplied && !isCancelled && (
								<button
									type="button"
									className="btn danger"
									disabled={disabled || busy}
									onClick={() => void handleCancel()}
									style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}
								>
									{zh ? "取消集成" : "Cancel"}
								</button>
							)}
						</div>

						<div style={{ fontSize: "0.8rem", color: "var(--text-faint)" }}>
							<span>
								{zh ? "目标分支: " : "Target Branch: "}
								<code>{activeIntegration.targetBranch}</code>
							</span>
							{activeIntegration.expectedTargetSha && (
								<span style={{ marginLeft: "1rem" }}>
									{zh ? "基线 SHA: " : "Target SHA: "}
									<code>{activeIntegration.expectedTargetSha.slice(0, 8)}</code>
								</span>
							)}
							{activeIntegration.newCommitSha && (
								<span style={{ marginLeft: "1rem" }}>
									{zh ? "新提交 SHA: " : "New Commit SHA: "}
									<code>{activeIntegration.newCommitSha.slice(0, 8)}</code>
								</span>
							)}
						</div>

						{/* 冲突预览 */}
						{isConflict && activeIntegration.conflicts && (
							<div style={{ background: "rgba(244, 63, 94, 0.1)", padding: "0.5rem", borderRadius: "4px" }}>
								<strong style={{ color: "var(--red, #f43f5e)", fontSize: "0.85rem" }}>
									{zh ? "检测到合并冲突！无法自动合并：" : "Merge conflicts detected:"}
								</strong>
								<ul style={{ margin: "0.25rem 0", paddingLeft: "1.2rem", fontSize: "0.8rem" }}>
									{activeIntegration.conflicts.map((file, i) => (
										<li key={i}>
											<code>{file}</code>
										</li>
									))}
								</ul>
								{activeIntegration.diff && (
									<details style={{ marginTop: "0.25rem", fontSize: "0.8rem" }}>
										<summary>{zh ? "查看冲突 Diff" : "View Conflict Diff"}</summary>
										<pre style={{ maxHeight: "150px", overflow: "auto", fontSize: "0.75rem" }}>
											{activeIntegration.diff}
										</pre>
									</details>
								)}
							</div>
						)}

						{/* 差异预览 */}
						{activeIntegration.diff && !isConflict && (
							<details style={{ fontSize: "0.85rem", margin: "0.25rem 0" }}>
								<summary>{zh ? "集成 Diff 预览" : "Integration Diff Preview"}</summary>
								<pre
									style={{
										maxHeight: "200px",
										overflow: "auto",
										fontSize: "0.75rem",
										background: "var(--code-bg, rgba(0,0,0,0.2))",
										padding: "0.5rem",
										borderRadius: "4px",
									}}
								>
									{activeIntegration.diff}
								</pre>
							</details>
						)}

						{/* 显式验证命令区域（绝不自动执行自述命令） */}
						{canVerify && (
							<div
								style={{
									border: "1px solid var(--border)",
									borderRadius: "4px",
									padding: "0.5rem",
									background: "var(--bg-elev2)",
								}}
							>
								<div style={{ fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.25rem" }}>
									{zh
										? "显式验证命令（防 Bot 自述注入，不自动执行）"
										: "Explicit Validation Commands (Never auto-runs Bot claims)"}
								</div>
								<p style={{ fontSize: "0.75rem", color: "var(--text-faint)", margin: "0 0 0.25rem 0" }}>
									{zh
										? "请勾选或自定义要在此隔离工作树内运行的测试/检查命令："
										: "Check or enter commands to execute in the isolated worktree:"}
								</p>

								{delivery.checks.length > 0 && (
									<div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", margin: "0.25rem 0" }}>
										{delivery.checks.map((c, i) => (
											<label
												key={i}
												style={{ fontSize: "0.8rem", display: "flex", alignItems: "center", gap: "0.25rem" }}
											>
												<input
													type="checkbox"
													checked={selectedCommands.includes(c.command)}
													disabled={disabled || busy}
													onChange={(e) => {
														if (e.target.checked) setSelectedCommands((prev) => [...prev, c.command]);
														else setSelectedCommands((prev) => prev.filter((cmd) => cmd !== c.command));
													}}
												/>
												<code>{c.command}</code>
												<span style={{ color: "var(--text-faint)", fontSize: "0.75rem" }}>
													({zh ? "Bot 自述结果:" : "Bot claimed:"} {c.status})
												</span>
											</label>
										))}
									</div>
								)}

								<div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem" }}>
									<input
										type="text"
										placeholder={zh ? "自定义验证命令，如 npm test" : "Custom command, e.g. npm test"}
										value={customCommand}
										onChange={(e) => setCustomCommand(e.target.value)}
										disabled={disabled || busy}
										style={{ flex: 1, fontSize: "0.8rem" }}
									/>
									<button
										type="button"
										className="btn"
										disabled={disabled || busy || (selectedCommands.length === 0 && !customCommand.trim())}
										onClick={() => void handleVerify()}
										style={{ fontSize: "0.8rem" }}
									>
										{busy && activeIntegration.status === "verifying"
											? zh
												? "验证中…"
												: "Verifying…"
											: zh
												? "运行所选命令"
												: "Run Selected"}
									</button>
								</div>

								{activeIntegration.validationCommands.length > 0 && (
									<div style={{ marginTop: "0.5rem" }}>
										<div style={{ fontSize: "0.8rem", fontWeight: 600 }}>
											{zh ? "验证结果：" : "Validation Results:"}
										</div>
										{activeIntegration.validationCommands.map((v, i) => (
											<div key={i} style={{ fontSize: "0.75rem", margin: "0.25rem 0" }}>
												<code>{v.command}</code>:{" "}
												<span
													style={{
														color: v.status === "passed" ? "var(--green, #10b981)" : "var(--red, #f43f5e)",
														fontWeight: 600,
													}}
												>
													{v.status}
												</span>
												{v.exitCode !== undefined && ` (exit ${v.exitCode})`}
												{v.output && (
													<pre
														style={{
															maxHeight: "100px",
															overflow: "auto",
															margin: "0.1rem 0",
															padding: "0.25rem",
															background: "rgba(0,0,0,0.15)",
														}}
													>
														{v.output}
													</pre>
												)}
											</div>
										))}
									</div>
								)}
							</div>
						)}

						{/* 最终合并确认按钮：用户明确确认后才写入目标 branch */}
						{canApply && (
							<div style={{ marginTop: "0.5rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
								<button
									type="button"
									className="btn primary"
									disabled={disabled || busy}
									onClick={() => void handleApply()}
									style={{ fontSize: "0.85rem" }}
								>
									{busy && activeIntegration.status === "applying"
										? zh
											? "正在写入目标分支…"
											: "Writing to target branch…"
										: zh
											? `确认合并写入 ${activeIntegration.targetBranch}`
											: `Confirm & Merge into ${activeIntegration.targetBranch}`}
								</button>
								<span style={{ fontSize: "0.75rem", color: "var(--text-faint)" }}>
									{zh
										? "（点击即确认合并，绝不强制覆盖或自动推送）"
										: "(Explicit confirmation; never forces or pushes)"}
								</span>
							</div>
						)}

						{isApplied && (
							<div
								style={{ color: "var(--green, #10b981)", fontSize: "0.85rem", fontWeight: 600, marginTop: "0.25rem" }}
							>
								✓{" "}
								{zh
									? `已成功合并写入分支 ${activeIntegration.targetBranch}`
									: `Successfully merged into branch ${activeIntegration.targetBranch}`}
							</div>
						)}
					</div>
				)}
			</div>
		</details>
	);
}
