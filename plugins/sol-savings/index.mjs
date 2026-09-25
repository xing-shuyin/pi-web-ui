/**
 * sol-savings — SoL-Pi 会话节省统计与规划底栏插件。
 *
 * 核心功能：
 *  1. 实时统计 SoL-Pi 在当前打开会话中通过 Observation Pack（大工具输出截断替换）
 *     与 Online Context Compact（在线边界压缩）规避的上下文 Token 总量；
 *  2. 借鉴 atfa/pi-sol-plan-footer 解析 SoL-Pi 规划（Plan）状态与进度；
 *  3. 将节省指标与计划徽标实时展示在 pi-web-ui 底部状态栏（bottombar）；
 *  4. 点击底栏徽标即可弹出详细节省清单与工具分类统计。
 */

function formatTokens(count) {
	const n = Number(count) || 0;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function formatBytes(bytes) {
	const n = Number(bytes) || 0;
	if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${n} B`;
}

/** 估算占位符自身 token 数（约 70~90 tokens）。 */
const PLACEHOLDER_TOKENS_EST = 80;

/**
 * 从当前对话消息快照中分析 SoL-Pi 节省情况。
 */
export function analyzeSolSavings(messages = []) {
	let totalSavedTokens = 0;
	let totalOriginalBytes = 0;
	let packedCount = 0;
	const toolBreakdown = {};
	const packedList = [];

	// 计算每个消息后续的 assistant 轮次，代表该占位符被送入模型的频次
	const assistantCountsAfter = new Array(messages.length).fill(0);
	let count = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		assistantCountsAfter[i] = count;
		if (messages[i]?.role === "assistant") {
			count++;
		}
	}

	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		const contents = Array.isArray(m?.content) ? m.content : [];
		for (const c of contents) {
			const text = typeof c === "string" ? c : typeof c?.text === "string" ? c.text : "";
			if (!text.includes("[large tool result replaced")) continue;

			const match = text.match(
				/\[large tool result replaced after its first \d+ provider requests\][\s\S]*?id:\s*([^\n\r]+)[\s\S]*?tool:\s*([^\n\r]+)[\s\S]*?original_bytes:\s*(\d+)[\s\S]*?estimated_tokens:\s*(\d+)/i,
			);
			if (match) {
				const id = match[1].trim();
				const tool = match[2].trim();
				const bytes = parseInt(match[3], 10) || 0;
				const tokens = parseInt(match[4], 10) || 0;
				const netPerSend = Math.max(0, tokens - PLACEHOLDER_TOKENS_EST);
				const subsequentSends = Math.max(1, assistantCountsAfter[i]);
				const savedTokensForObs = netPerSend * subsequentSends;

				packedCount++;
				totalOriginalBytes += bytes;
				totalSavedTokens += savedTokensForObs;

				toolBreakdown[tool] = (toolBreakdown[tool] || 0) + 1;
				packedList.push({
					id,
					tool,
					bytes,
					tokens,
					savedTokens: savedTokensForObs,
					sends: subsequentSends,
				});
			}
		}
	}

	// 查找可能存在的 SoL-Pi 规划（Plan）
	let latestPlan = null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		const contents = Array.isArray(m?.content) ? m.content : [];
		for (const c of contents) {
			const text = typeof c === "string" ? c : typeof c?.text === "string" ? c.text : "";
			if (text.includes("sol-pi-online-context-state-v1") || text.includes('"plan":')) {
				try {
					const jsonMatch = text.match(/\{[\s\S]*"plan"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
					if (jsonMatch) {
						const parsed = JSON.parse(jsonMatch[0]);
						if (Array.isArray(parsed.plan) && parsed.plan.length > 0) {
							latestPlan = parsed.plan;
							break;
						}
					}
				} catch {
					/* ignore parse error */
				}
			}
		}
		if (latestPlan) break;
	}

	return {
		packedCount,
		totalSavedTokens,
		totalOriginalBytes,
		toolBreakdown,
		packedList,
		plan: latestPlan,
	};
}

/**
 * 格式化 Plan 进度简述（借鉴 pi-sol-plan-footer）。
 */
export function formatPlanSummary(plan) {
	if (!Array.isArray(plan) || plan.length === 0) return null;
	const completed = plan.filter((s) => s.status === "completed").length;
	const active = plan.find((s) => s.status === "in_progress");
	const marker = active ? "◐" : "○";
	const currentGoal = active ? active.goal || active.title || "" : "";
	return {
		progress: `${completed}/${plan.length}`,
		marker,
		goal: currentGoal.length > 20 ? `${currentGoal.slice(0, 19)}…` : currentGoal,
		badge: `${completed}/${plan.length} ${marker}`,
	};
}

export default function solSavingsPlugin(host) {
	let cachedStats = null;

	function refreshFooter() {
		const conv = host.getActiveConversation();
		if (!conv || !Array.isArray(conv.messages)) {
			host.ui.update("sol-savings-badge", {
				badge: undefined,
				label: "SoL-Pi",
				hint: "SoL-Pi 节省：当前会话暂无数据",
				hintEn: "SoL-Pi savings: No data for current conversation",
			});
			cachedStats = null;
			return;
		}

		const stats = analyzeSolSavings(conv.messages);
		cachedStats = stats;

		const planInfo = formatPlanSummary(stats.plan);
		let badgeText = undefined;
		let labelText = "SoL-Pi";

		if (stats.totalSavedTokens > 0) {
			const savedFmt = formatTokens(stats.totalSavedTokens);
			badgeText = planInfo ? `${savedFmt} · ${planInfo.progress} ${planInfo.marker}` : `${savedFmt} 省`;
		} else if (planInfo) {
			badgeText = `Plan ${planInfo.badge}`;
		}

		const breakdownStr = Object.entries(stats.toolBreakdown)
			.map(([tool, cnt]) => `${tool}: ${cnt}`)
			.join(", ");

		const hintZh =
			stats.totalSavedTokens > 0
				? `⚡ SoL-Pi 已为本会话节省约 ${stats.totalSavedTokens.toLocaleString()} tokens（压缩 ${stats.packedCount} 个输出${breakdownStr ? ` [${breakdownStr}]` : ""}，累计原始数据 ${formatBytes(stats.totalOriginalBytes)}）${planInfo ? `\n🎯 规划进度：${planInfo.progress} ${planInfo.marker} ${planInfo.goal}` : ""}\n点击查看完整明细`
				: planInfo
					? `⚡ SoL-Pi 规划进行中：${planInfo.progress} ${planInfo.marker} ${planInfo.goal}`
					: `⚡ SoL-Pi：当前会话暂未触发大工具输出打包或在线压缩`;

		const hintEn =
			stats.totalSavedTokens > 0
				? `⚡ SoL-Pi saved ~${stats.totalSavedTokens.toLocaleString()} tokens in this session (${stats.packedCount} outputs packed${breakdownStr ? ` [${breakdownStr}]` : ""}, ${formatBytes(stats.totalOriginalBytes)} raw data)${planInfo ? `\n🎯 Plan: ${planInfo.progress} ${planInfo.marker} ${planInfo.goal}` : ""}\nClick for full details`
				: planInfo
					? `⚡ SoL-Pi Plan in progress: ${planInfo.progress} ${planInfo.marker} ${planInfo.goal}`
					: `⚡ SoL-Pi: No observations packed or plan active in this session yet`;

		host.ui.update("sol-savings-badge", {
			badge: badgeText,
			label: labelText,
			hint: hintZh,
			hintEn: hintEn,
		});
	}

	function showDetails() {
		if (!cachedStats || (cachedStats.totalSavedTokens === 0 && !cachedStats.plan)) {
			host.notify(
				"info",
				"⚡ SoL-Pi：当前会话暂无大输出被打包，尚未产生 Token 节省。",
				"⚡ SoL-Pi: No large tool outputs packed yet in this session.",
			);
			return;
		}

		const breakdown = Object.entries(cachedStats.toolBreakdown)
			.map(([t, c]) => `  • ${t}：${c} 次打包`)
			.join("\n");

		const planInfo = formatPlanSummary(cachedStats.plan);

		const textZh = [
			`⚡ **SoL-Pi 会话节省统计明细**`,
			`• **累计节省 Token**：约 **${cachedStats.totalSavedTokens.toLocaleString()}** tokens`,
			`• **打包大输出数量**：共 **${cachedStats.packedCount}** 个结果（原体积 ${formatBytes(cachedStats.totalOriginalBytes)}）`,
			breakdown ? `• **按工具细分**：\n${breakdown}` : null,
			planInfo ? `• **活动规划（Plan）**：${planInfo.progress} ${planInfo.marker} ${planInfo.goal}` : null,
		]
			.filter(Boolean)
			.join("\n");

		const textEn = [
			`⚡ **SoL-Pi Session Savings Details**`,
			`• **Tokens Saved**: ~**${cachedStats.totalSavedTokens.toLocaleString()}** tokens`,
			`• **Outputs Packed**: **${cachedStats.packedCount}** observations (${formatBytes(cachedStats.totalOriginalBytes)} raw)`,
			breakdown ? `• **Tool Breakdown**:\n${breakdown}` : null,
			planInfo ? `• **Active Plan**: ${planInfo.progress} ${planInfo.marker} ${planInfo.goal}` : null,
		]
			.filter(Boolean)
			.join("\n");

		host.notify("info", textZh, textEn);
	}

	// 注册 HTTP 路由供客户端动作桥（client/entry.mjs）调用
	if (typeof host.route === "function") {
		host.route("POST", "/trigger-details", (_req, res) => {
			showDetails();
			res.json({ ok: true });
		});
		host.route("GET", "/details", (_req, res) => {
			res.json(cachedStats || {});
		});
	}

	// 注册 UI 动作与消息监听
	host.onMessage((msg) => {
		if (msg && typeof msg === "object" && msg.action === "sol-savings:details") {
			showDetails();
		}
	});

	// 监听运行与连接事件，适时刷新
	host.onAttach(() => refreshFooter());
	host.onRunEvent((ev) => {
		if (ev.type === "tool_end" || ev.type === "turn_end" || ev.type === "run_end" || ev.type === "message") {
			refreshFooter();
		}
	});

	// 初始刷新
	refreshFooter();
}
