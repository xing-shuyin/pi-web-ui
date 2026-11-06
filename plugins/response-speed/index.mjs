const MAX_RECORDS_PER_CONV = 200;
const MAX_CONVERSATIONS = 100;
const STORAGE_KEY = "records_by_conv";
const LEGACY_STORAGE_KEY = "records";

/**
 * 格式化耗时毫秒
 * @param {number} ms 毫秒数
 * @returns {string}
 */
export function formatDuration(ms) {
	if (ms === null || ms === undefined || typeof ms !== "number") return "--";
	const n = Number(ms);
	if (!Number.isFinite(n) || n < 0) return "--";
	if (n < 1000) return `${Math.round(n)}ms`;
	if (n < 60000) {
		const s = (n / 1000).toFixed(n < 10000 ? 2 : 1);
		return `${s
			.replace(/\.00$/, "")
			.replace(/(\.\d)0$/, "$1")
			.replace(/\.0$/, "")}s`;
	}
	return `${(n / 60000).toFixed(1).replace(/\.0$/, "")}m`;
}

/**
 * 格式化紧凑纯数值响应速度（以秒为基准，如 12.7、14.3、0.5 等，无记录为 --）
 * 用于底栏极简指标展示，如 "12.7/14.3"
 * @param {number|null} ms 毫秒数
 * @returns {string}
 */
export function formatCompactDuration(ms) {
	if (ms === null || ms === undefined || typeof ms !== "number") return "--";
	const n = Number(ms);
	if (!Number.isFinite(n) || n < 0) return "--";
	if (n === 0) return "0";
	const s = (n / 1000).toFixed(1);
	return s.replace(/\.0$/, "");
}

/**
 * 计算响应速度统计数据
 * @param {Array<{ latencyMs: number, timestamp?: number, model?: string }>} records
 */
export function calcStats(records) {
	const list = Array.isArray(records)
		? records.filter((r) => r && typeof r.latencyMs === "number" && Number.isFinite(r.latencyMs) && r.latencyMs > 0)
		: [];

	if (list.length === 0) {
		return {
			count: 0,
			avgMs: null,
			minMs: null,
			maxMs: null,
			latestMs: null,
			recent: [],
		};
	}

	let sum = 0;
	let min = Infinity;
	let max = -Infinity;

	for (const r of list) {
		const ms = r.latencyMs;
		sum += ms;
		if (ms < min) min = ms;
		if (ms > max) max = ms;
	}

	const avg = Math.round(sum / list.length);
	const latest = list[list.length - 1]?.latencyMs ?? null;

	return {
		count: list.length,
		avgMs: avg,
		minMs: min === Infinity ? null : min,
		maxMs: max === -Infinity ? null : max,
		latestMs: latest,
		recent: list.slice(-20).reverse(),
	};
}

export default {
	activate(host) {
		const recordsByConv = new Map();

		try {
			const saved = host.storage?.get(STORAGE_KEY);
			if (saved && typeof saved === "object" && !Array.isArray(saved)) {
				for (const [convId, list] of Object.entries(saved)) {
					if (Array.isArray(list)) {
						const validList = list.filter(
							(r) => r && typeof r.latencyMs === "number" && Number.isFinite(r.latencyMs) && r.latencyMs > 0,
						);
						if (validList.length > 0) {
							recordsByConv.set(convId, validList.slice(-MAX_RECORDS_PER_CONV));
						}
					}
				}
			} else {
				const legacy = host.storage?.get(LEGACY_STORAGE_KEY);
				if (Array.isArray(legacy)) {
					for (const r of legacy) {
						if (r && typeof r.latencyMs === "number" && Number.isFinite(r.latencyMs) && r.latencyMs > 0) {
							const cid = typeof r.conversationId === "string" && r.conversationId ? r.conversationId : "default";
							if (!recordsByConv.has(cid)) recordsByConv.set(cid, []);
							recordsByConv.get(cid).push(r);
						}
					}
				}
			}
		} catch {
			recordsByConv.clear();
		}

		const activeTurns = new Map();

		function getRecords(convId) {
			const id = String(convId || "default");
			return recordsByConv.get(id) || [];
		}

		function getActiveConvId(clientId) {
			try {
				const conv = clientId ? host.getActiveConversation?.({ clientId }) : host.getActiveConversation?.();
				if (conv?.conversationId) return conv.conversationId;
			} catch {}
			return "default";
		}

		function saveRecords() {
			try {
				const obj = {};
				const entries = [...recordsByConv.entries()];
				entries.sort((a, b) => {
					const timeA = a[1][a[1].length - 1]?.timestamp || 0;
					const timeB = b[1][b[1].length - 1]?.timestamp || 0;
					return timeB - timeA;
				});
				for (const [cid, list] of entries.slice(0, MAX_CONVERSATIONS)) {
					obj[cid] = list.slice(-MAX_RECORDS_PER_CONV);
				}
				host.storage?.set(STORAGE_KEY, obj);
			} catch {}
		}

		function refreshBottomBar(targetConvId) {
			const convId = targetConvId || getActiveConvId();
			const records = getRecords(convId);
			const stats = calcStats(records);
			const hasAvg = stats.count > 0 && stats.avgMs !== null;
			const avgStr = hasAvg ? formatDuration(stats.avgMs) : "--";
			const latestStr = stats.latestMs !== null ? formatDuration(stats.latestMs) : "--";

			const compactLabel = `${formatCompactDuration(stats.latestMs)}/${formatCompactDuration(stats.avgMs)}`;

			const hintZh =
				stats.count > 0
					? `⚡ AI 响应速度（当前对话）\n• 最新请求响应: ${latestStr}（首字 TTFT 耗时）\n• 历史平均速度: ${avgStr}\n• 最快响应: ${formatDuration(stats.minMs)} · 最慢响应: ${formatDuration(stats.maxMs)}\n• 样本次数: ${stats.count} 次\n（数值说明：最新 / 均速，点击查看明细看板）`
					: "⚡ AI 响应速度（当前对话）\n当前对话暂无测速记录。提问或 AI 自循环每次请求时将自动统计首包响应耗时（TTFT）。\n格式：最新/均速（秒）";

			const hintEn =
				stats.count > 0
					? `⚡ AI Response Speed (Current conv)\n• Latest: ${latestStr} (TTFT) · Avg: ${avgStr}\n• Range: ${formatDuration(stats.minMs)} - ${formatDuration(stats.maxMs)} · Requests: ${stats.count}\n(Format: Latest/Avg, click for details)`
					: "⚡ AI Response Speed (Current conv)\nNo latency records yet. Tracking starts on next turn.\nFormat: Latest/Avg (seconds)";

			host.ui?.update("response-speed-badge", {
				label: compactLabel,
				labelEn: compactLabel,
				hint: hintZh,
				hintEn: hintEn,
			});
		}

		function addRecord(data) {
			const latencyMs = Number(data?.latencyMs);
			if (!Number.isFinite(latencyMs) || latencyMs <= 0) return null;

			const convId =
				typeof data?.conversationId === "string" && data.conversationId.trim()
					? data.conversationId.trim()
					: getActiveConvId();

			const item = {
				id: `speed_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
				latencyMs: Math.round(latencyMs),
				timestamp: Number(data.timestamp) || Date.now(),
				model: typeof data.model === "string" ? data.model.slice(0, 100) : undefined,
				conversationId: convId,
			};

			if (!recordsByConv.has(convId)) {
				recordsByConv.set(convId, []);
			}
			const list = recordsByConv.get(convId);
			list.push(item);
			if (list.length > MAX_RECORDS_PER_CONV) {
				recordsByConv.set(convId, list.slice(-MAX_RECORDS_PER_CONV));
			}

			saveRecords();

			const activeId = getActiveConvId();
			if (convId === activeId || activeId === "default") {
				refreshBottomBar(convId);
			}

			const currentStats = calcStats(getRecords(convId));
			try {
				host.broadcast?.({
					type: "response_speed_stats",
					conversationId: convId,
					stats: currentStats,
					latestRecord: item,
				});
			} catch {}

			return item;
		}

		function clearRecords(targetConvId) {
			const convId = targetConvId || getActiveConvId();
			recordsByConv.delete(convId);
			saveRecords();
			refreshBottomBar(convId);

			try {
				host.broadcast?.({
					type: "response_speed_stats",
					conversationId: convId,
					stats: calcStats([]),
					cleared: true,
				});
			} catch {}
		}

		refreshBottomBar();

		host.onConversationChanged?.(() => {
			const convId = getActiveConvId();
			refreshBottomBar(convId);
			try {
				host.broadcast?.({
					type: "response_speed_conversation_switched",
					conversationId: convId,
					stats: calcStats(getRecords(convId)),
				});
			} catch {}
		});

		host.onAttach?.((clientId) => {
			const convId = getActiveConvId(clientId);
			try {
				host.sendTo?.(clientId, {
					type: "response_speed_stats",
					conversationId: convId,
					stats: calcStats(getRecords(convId)),
				});
			} catch {}
		});

		host.route?.("GET", "/stats", (req, res) => {
			const queryConvId =
				typeof req.query?.conversationId === "string" && req.query.conversationId.trim()
					? req.query.conversationId.trim()
					: undefined;
			const convId = queryConvId || getActiveConvId();
			res.json({
				ok: true,
				conversationId: convId,
				stats: calcStats(getRecords(convId)),
			});
		});

		host.route?.("POST", "/record", (req, res) => {
			const item = addRecord(req.body);
			if (!item) {
				res.status(400).json({ ok: false, error: "invalid latencyMs" });
				return;
			}
			const convId = item.conversationId;
			res.json({
				ok: true,
				record: item,
				conversationId: convId,
				stats: calcStats(getRecords(convId)),
			});
		});

		host.route?.("POST", "/reset", (req, res) => {
			const targetConvId =
				typeof req.body?.conversationId === "string" && req.body.conversationId.trim()
					? req.body.conversationId.trim()
					: undefined;
			const convId = targetConvId || getActiveConvId();
			clearRecords(convId);
			res.json({ ok: true, conversationId: convId });
		});

		host.onRunEvent?.((ev) => {
			const convId = ev.conversationId || "default";

			if (ev.type === "turn_start") {
				activeTurns.set(convId, {
					startTime: ev.at || Date.now(),
				});
			} else if (ev.type === "turn_first_token") {
				const turn = activeTurns.get(convId);
				if (turn) {
					activeTurns.delete(convId);
					const now = ev.at || Date.now();
					const delta =
						typeof ev.durationMs === "number" && ev.durationMs > 0 ? ev.durationMs : Math.max(1, now - turn.startTime);
					addRecord({
						latencyMs: delta,
						timestamp: now,
						conversationId: convId,
					});
				}
			} else if (ev.type === "turn_end") {
				activeTurns.delete(convId);
			} else if (ev.type === "run_end") {
				activeTurns.delete(convId);
			}
		});

		host.onUiAction?.("response-speed:show-details", () => {
			const convId = getActiveConvId();
			const stats = calcStats(getRecords(convId));
			try {
				host.broadcast?.({
					type: "response_speed_open_modal",
					conversationId: convId,
					stats,
				});
			} catch {}

			if (stats.count === 0) {
				host.notify?.(
					"info",
					"⚡ AI 响应速度：当前对话暂无测速记录。提问或 AI 自循环每次请求时将自动统计首包响应耗时（TTFT）。",
					"⚡ AI Response Speed: No latency records for this conversation yet. Tracking starts on next query or self-loop turn.",
				);
			}
		});

		return () => {
			activeTurns.clear();
			recordsByConv.clear();
		};
	},
};
