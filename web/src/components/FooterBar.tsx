import { useEffect, useRef, useState } from "react";
import { FiFile, FiFolder } from "react-icons/fi";
import type { ChatState } from "../use-chat";
import { useT } from "../i18n";
import { cacheMetrics, estimateStreamTokens, streamRate, trimRateSamples, type RateSample } from "../cache-stats";

interface FooterBarProps {
	chat: ChatState;
	send: (msg: { type: "complete_path"; path: string } | { type: "set_cwd"; path: string }) => boolean;
}

/**
 * Compact status bar: connection, context usage, cost, session, queue, and the
 * workspace path — click the path to switch directories (with completion).
 */
export function FooterBar({ chat, send }: FooterBarProps) {
	const t = useT();
	const state = chat.state;
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const [selIdx, setSelIdx] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const completions = chat.pathCompletions;

	// Debounced path completion requests while editing.
	useEffect(() => {
		if (!editing) return;
		const t = setTimeout(() => {
			send({ type: "complete_path", path: draft });
		}, 150);
		return () => clearTimeout(t);
	}, [draft, editing, send]);

	// Reset selection whenever the completion list changes.
	useEffect(() => setSelIdx(0), [completions]);

	// Keep the highlighted item visible while navigating with the keyboard.
	useEffect(() => {
		const el = document.querySelector(`.status-completions .pc-item[data-idx="${selIdx}"]`);
		el?.scrollIntoView({ block: "nearest" });
	}, [selIdx]);

	// Live generation-speed samples (tokens/sec). Kept in a ref so pushing a
	// sample never triggers a re-render. The SDK only commits a turn's usage
	// counters at message_end, so `stats.tokens.output` is FLAT while streaming —
	// instead we estimate tokens from the in-flight message content (text +
	// thinking), which grows every token. Sample at most every 250ms; baseline
	// resets the moment streaming stops.
	const samplesRef = useRef<RateSample[]>([]);
	const streamingNow = state?.isStreaming ?? false;
	const streamEst = state?.streamingMessage ? estimateStreamTokens(state.streamingMessage.content) : 0;
	useEffect(() => {
		if (!streamingNow) {
			samplesRef.current = [];
			return;
		}
		const now = Date.now();
		const prev = samplesRef.current;
		const last = prev[prev.length - 1];
		if (last && now - last.t < 250) return; // throttle
		samplesRef.current = trimRateSamples([...prev, { t: now, out: streamEst }], now);
	}, [streamingNow, streamEst]);

	if (!state) return null;
	const s = state.stats;

	const cache = cacheMetrics(s.tokens);
	const hitPct = cache.hitRate * 100;
	const hitClass = cache.totalInput === 0 ? "" : cache.hitRate >= 0.7 ? "ok" : cache.hitRate >= 0.4 ? "mid" : "warn";
	const hitText = cache.totalInput > 0 ? `${hitPct.toFixed(1)}%` : "—";
	const rate = streamingNow ? streamRate(samplesRef.current) : 0;

	const connClass = chat.ready ? "ok" : "busy";
	const connLabel = chat.ready ? t("connected") : t("connecting");

	const context = s.contextUsage;
	const ctxText =
		context.tokens !== null && context.percent !== null
			? `${formatTokens(context.tokens)} / ${formatTokens(context.contextWindow)}`
			: "—";
	const ctxPercent = context.percent ?? null;
	const ctxBarClass = ctxPercent === null ? "" : ctxPercent >= 80 ? "warn" : ctxPercent >= 50 ? "mid" : "ok";

	const queueTotal = state.queue.steering.length + state.queue.followUp.length;

	const startEdit = () => {
		setDraft(state.cwd);
		setEditing(true);
	};

	/** Fill the input with a completion and keep browsing (dirs) or stay for submit. */
	const applyCompletion = (path: string, isDir: boolean) => {
		// Shell-style: completing into a directory appends a trailing separator so
		// the next completion lists its contents (\ on Windows, / elsewhere).
		const sep = path.includes("\\") ? "\\" : "/";
		setDraft(isDir ? `${path}${sep}` : path);
		setSelIdx(0);
		inputRef.current?.focus();
	};

	const commit = (path: string) => {
		const trimmed = path.trim();
		if (trimmed && trimmed !== state.cwd) send({ type: "set_cwd", path: trimmed });
		setEditing(false);
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setSelIdx((i) => Math.min(i + 1, completions.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setSelIdx((i) => Math.max(i - 1, 0));
		} else if (e.key === "Tab" && completions.length > 0) {
			e.preventDefault();
			const c = completions[Math.min(selIdx, completions.length - 1)];
			applyCompletion(c.path, c.type === "dir");
		} else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
			const trimmed = draft.trim();
			if (trimmed.endsWith("/") || trimmed.endsWith("\\")) {
				// Explicit directory (trailing separator) → switch immediately.
				commit(trimmed);
			} else if (completions.some((c) => c.path === trimmed)) {
				// Input exactly matches a suggestion → switch to it.
				commit(trimmed);
			} else if (completions.length > 0 && completions[selIdx]) {
				// Fill the highlighted completion first; press Enter again to switch.
				e.preventDefault();
				const c = completions[selIdx];
				applyCompletion(c.path, c.type === "dir");
			} else {
				commit(trimmed);
			}
		} else if (e.key === "Escape") {
			if (completions.length > 0) {
				// First Esc closes the suggestion list; second exits editing.
				e.stopPropagation();
				send({ type: "complete_path", path: "" }); // clears list
			} else {
				setEditing(false);
			}
		}
	};

	return (
		<footer className="statusbar">
			<span className={`status-dot ${connClass}`} title={connLabel} />
			<span className="status-item">{connLabel}</span>
			<span className="status-sep">·</span>

			{chat.engine && chat.engine !== "pi" && (
				<>
					<span
						className={`status-item engine-badge engine-${chat.engine}`}
						title={`${t("engineBadge")}: ${chat.engine}`}
					>
						{chat.engine === "dsh" ? "DSH" : chat.engine}
					</span>
					<span className="status-sep">·</span>
				</>
			)}

			<span className="status-item status-ctx" title={t("contextUsage")}>
				{t("context")}
				<span className={`ctx-bar ${ctxBarClass}`}>
					{ctxPercent !== null && <span className="ctx-bar-fill" style={{ width: `${Math.min(ctxPercent, 100)}%` }} />}
				</span>
				{ctxText}
			</span>
			<span className="status-sep">·</span>

			<span className="status-item" title={t("cumulativeCost")}>
				${formatCost(s.cost)}
			</span>
			<span className="status-sep">·</span>

			<span
				className="status-item status-cache"
				title={t("cacheHitTip", {
					read: formatTokens(cache.read),
					write: formatTokens(cache.write),
					miss: formatTokens(cache.miss),
					input: formatTokens(cache.totalInput),
				})}
			>
				{t("cacheHit")}
				<b className={`cache-pct ${hitClass}`}>{hitText}</b>
			</span>
			<span className="status-sep">·</span>

			<span className="status-item" title={t("sessionMessages")}>
				{t("messages")} {s.totalMessages}
			</span>

			{chat.statuses.length > 0 && (
				<>
					<span className="status-sep">·</span>
					<span className="status-item ext-status" title={t("pluginStatus")}>
						{chat.statuses.map((st) => st.text).join(" · ")}
					</span>
				</>
			)}

			{state.isStreaming && (
				<>
					<span className="status-sep">·</span>
					<span className="status-item working">
						<span className="working-spin" />
						{t("working")}
						{queueTotal > 0 && (
							<span className="status-queue">
								⏳ {queueTotal} {t("queued")}
							</span>
						)}
					</span>
					<span className="status-item status-rate" title={t("rateTip")}>
						{rate > 0 ? `${Math.round(rate)}${t("tps")}` : "…"}
					</span>
				</>
			)}

			{editing ? (
				<div className="status-cwd-wrap">
					<input
						ref={inputRef}
						className="status-cwd-input"
						value={draft}
						autoFocus
						placeholder={t("enterPath")}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={onKeyDown}
						onBlur={() => setEditing(false)}
					/>
					{completions.length > 0 && (
						<ul
							className="status-completions"
							onMouseDown={(e) => e.preventDefault()} // keep input focused
						>
							{completions.map((c, i) => (
								<li key={c.path}>
									<button
										type="button"
										data-idx={i}
										className={`pc-item ${i === selIdx ? "sel" : ""}`}
										onMouseEnter={() => setSelIdx(i)}
										onClick={() => applyCompletion(c.path, c.type === "dir")}
									>
										<span className="pc-icon">{c.type === "dir" ? <FiFolder /> : <FiFile />}</span>
										<span className="pc-body">
											<span className="pc-name">{c.name}</span>
											<span className="pc-path">{c.path}</span>
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			) : (
				<button
					type="button"
					className="status-item status-cwd"
					title={t("cwdTip", { path: state.cwd })}
					onClick={startEdit}
				>
					📁 {state.cwd}
				</button>
			)}
		</footer>
	);
}

function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
	return String(n);
}

function formatCost(cost: number): string {
	if (cost <= 0) return "0";
	if (cost < 0.0001) return "<0.0001";
	return cost.toFixed(4).replace(/\.?0+$/, "");
}
