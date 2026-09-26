/**
 * sol-savings — SoL-Pi 会话节省统计与规划底栏插件。
 *
 * 核心功能：
 *  1. 实时统计 SoL-Pi 在当前打开会话中通过 Observation Pack（大工具输出截断替换）
 *     与 Online Context Compact（在线边界压缩）规避的上下文 Token 总量；
 *  2. 借鉴 atfa/pi-sol-plan-footer 解析 SoL-Pi 规划（Plan）状态与进度；
 *  3. 将节省指标与计划徽标实时展示在 pi-web-ui 底部状态栏（bottombar）；
 *  4. 点击底栏徽标即可弹出详细节省清单与工具分类统计，并支持一键检测/写入配置与安装。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { exec } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

function getAgentDir() {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

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
				/\[large tool result replaced after its first \d+ provider requests\][\s\S]*?id:\s*["']?([^"'\n\r,]+)["']?[\s\S]*?tool:\s*["']?([^"'\n\r,]+)["']?[\s\S]*?original_bytes:\s*["']?(\d+)["']?[\s\S]*?estimated_tokens:\s*["']?(\d+)["']?/i,
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

export function checkSolPiStatus() {
	const agentDir = getAgentDir();
	const configPath = join(agentDir, "sol-pi.json");
	const settingsPath = join(agentDir, "settings.json");

	let installed = false;
	try {
		if (existsSync(settingsPath)) {
			const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
			const pkgs = Array.isArray(settings?.packages) ? settings.packages : [];
			installed = pkgs.some((p) => typeof p === "string" && p.toLowerCase().includes("sol-pi"));
		}
	} catch {
		/* ignore */
	}

	if (!installed) {
		const gitPkgDir = join(agentDir, "git", "github.com", "NVlabs", "SoL-Pi");
		if (existsSync(gitPkgDir)) installed = true;
	}

	let hasConfig = false;
	let config = null;
	if (existsSync(configPath)) {
		try {
			config = JSON.parse(readFileSync(configPath, "utf8"));
			hasConfig = true;
		} catch {
			/* ignore */
		}
	}

	return {
		installed,
		hasConfig,
		configPath,
		config,
	};
}

export function writeSolPiConfig(customPatch = {}) {
	const agentDir = getAgentDir();
	const configPath = join(agentDir, "sol-pi.json");
	const recommended = {
		version: 1,
		observationPack: true,
		onlineContextCompact: true,
		actionFusion: false,
		evidencePreservingReducer: false,
		cacheWriteReadRatio: 12.5,
		...customPatch,
	};
	writeFileSync(configPath, JSON.stringify(recommended, null, 2), "utf8");
	return recommended;
}

export function solSavingsPlugin(host) {
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
			badgeText = planInfo ? `省 ${savedFmt} · ${planInfo.progress} ${planInfo.marker}` : `省 ${savedFmt}`;
		} else if (planInfo) {
			badgeText = `Plan ${planInfo.badge}`;
		} else {
			badgeText = "省 0";
		}

		const breakdownStr = Object.entries(stats.toolBreakdown)
			.map(([tool, cnt]) => `${tool}: ${cnt}`)
			.join(", ");

		const hintZh =
			stats.totalSavedTokens > 0
				? `⚡ SoL-Pi（当前会话）：已节省约 ${stats.totalSavedTokens.toLocaleString()} tokens（压缩 ${stats.packedCount} 个输出${breakdownStr ? ` [${breakdownStr}]` : ""}，累计原始数据 ${formatBytes(stats.totalOriginalBytes)}）${planInfo ? `\n🎯 规划进度：${planInfo.progress} ${planInfo.marker} ${planInfo.goal}` : ""}\n点击查看当前会话明细`
				: planInfo
					? `⚡ SoL-Pi（当前会话）规划进行中：${planInfo.progress} ${planInfo.marker} ${planInfo.goal}\n点击查看当前会话明细`
					: `⚡ SoL-Pi（当前会话）：已节省 0 tokens，暂未触发大工具输出打包（阈值 >10KB）\n点击查看当前会话明细`;

		const hintEn =
			stats.totalSavedTokens > 0
				? `⚡ SoL-Pi (Current conversation): Saved ~${stats.totalSavedTokens.toLocaleString()} tokens in this session (${stats.packedCount} outputs packed${breakdownStr ? ` [${breakdownStr}]` : ""}, ${formatBytes(stats.totalOriginalBytes)} raw data)${planInfo ? `\n🎯 Plan: ${planInfo.progress} ${planInfo.marker} ${planInfo.goal}` : ""}\nClick for session details`
				: planInfo
					? `⚡ SoL-Pi (Current conversation) Plan in progress: ${planInfo.progress} ${planInfo.marker} ${planInfo.goal}\nClick for session details`
					: `⚡ SoL-Pi (Current conversation): 0 tokens saved (no outputs >10KB packed yet)\nClick for session details`;

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
				"⚡ SoL-Pi（当前会话）：暂未触发大输出截断（阈值 >10KB），当前会话累计节省 0 Tokens。\n• 仅按当前会话独立统计，未跨会话累加。",
				"⚡ SoL-Pi (Current conversation): No large tool outputs packed yet (>10KB threshold), 0 tokens saved in this session.",
			);
			return;
		}

		const breakdown = Object.entries(cachedStats.toolBreakdown)
			.map(([t, c]) => `  • ${t}：${c} 次打包`)
			.join("\n");

		const planInfo = formatPlanSummary(cachedStats.plan);

		const textZh = [
			`⚡ **SoL-Pi 会话节省统计明细（当前会话）**`,
			`• **当前会话累计节省**：约 **${cachedStats.totalSavedTokens.toLocaleString()}** tokens`,
			`• **打包大输出数量**：共 **${cachedStats.packedCount}** 个结果（原体积 ${formatBytes(cachedStats.totalOriginalBytes)}）`,
			breakdown ? `• **按工具细分**：\n${breakdown}` : null,
			planInfo ? `• **活动规划（Plan）**：${planInfo.progress} ${planInfo.marker} ${planInfo.goal}` : null,
			`• **统计范围**：仅限当前会话，切换会话自动隔离。`,
		]
			.filter(Boolean)
			.join("\n");

		const textEn = [
			`⚡ **SoL-Pi Session Savings Details (Current Conversation)**`,
			`• **Current Session Tokens Saved**: ~**${cachedStats.totalSavedTokens.toLocaleString()}** tokens`,
			`• **Outputs Packed**: **${cachedStats.packedCount}** observations (${formatBytes(cachedStats.totalOriginalBytes)} raw)`,
			breakdown ? `• **Tool Breakdown**:\n${breakdown}` : null,
			planInfo ? `• **Active Plan**: ${planInfo.progress} ${planInfo.marker} ${planInfo.goal}` : null,
			`• **Scope**: Current conversation only; isolated across sessions.`,
		]
			.filter(Boolean)
			.join("\n");

		host.notify("info", textZh, textEn);
	}

	// 注册 HTTP 路由供前端弹窗查询状态与一键配置/安装
	host.route?.("GET", "/status", (_req, res) => {
		const conv = host.getActiveConversation?.();
		const stats = conv && Array.isArray(conv.messages) ? analyzeSolSavings(conv.messages) : null;
		res.json({
			...checkSolPiStatus(),
			conversationId: conv?.conversationId || conv?.id || null,
			conversationTitle: conv?.title || null,
			stats,
		});
	});

	host.route?.("POST", "/action", async (req, res) => {
		const action = req.body?.action;
		try {
			if (action === "write_config") {
				// 已有配置时拒绝静默覆写（用户的自定义配置会被推荐值洗掉）；
				// 确要覆盖必须带显式 overwrite:"true"。
				const overwrite = String(req.body?.overwrite ?? "") === "true";
				const status = checkSolPiStatus();
				if (status.hasConfig && !overwrite) {
					res.status(409).json({ ok: false, error: '已存在 sol-pi.json，拒绝覆盖（如确需覆盖请带 overwrite:"true"）' });
					return;
				}
				const config = writeSolPiConfig();
				res.json({ ok: true, config });
			} else if (action === "install") {
				// 确认门：install 会从远端拉取并安装第三方扩展，必须带显式
				// confirm:"install"（客户端弹确认框后才发），防误触/跨站盲装。
				if (req.body?.confirm !== "install") {
					res.status(400).json({ ok: false, error: '缺少 confirm:"install" 确认参数' });
					return;
				}
				// 执行 pi install git:github.com/NVlabs/SoL-Pi（120s 超时防挂死）
				await execAsync("pi install git:github.com/NVlabs/SoL-Pi", { timeout: 120_000 });
				// 自动写默认推荐配置；用户已有配置时不覆盖
				const status = checkSolPiStatus();
				const config = status.hasConfig ? status.config : writeSolPiConfig();
				res.json({ ok: true, config });
			} else {
				res.status(400).json({ ok: false, error: "unknown action" });
			}
		} catch (err) {
			res.status(500).json({ ok: false, error: err?.message || String(err) });
		}
	});

	// 注册 UI 动作与消息监听
	host.onMessage((msg) => {
		if (msg && typeof msg === "object" && msg.action === "sol-savings:details") {
			showDetails();
		}
	});

	// 监听运行与连接事件，适时刷新
	host.onAttach?.(() => refreshFooter());
	host.onConversationChanged?.(() => refreshFooter());
	host.onRunEvent?.((ev) => {
		if (ev.type === "tool_end" || ev.type === "turn_end" || ev.type === "run_end" || ev.type === "message") {
			refreshFooter();
		}
	});

	// 初始刷新
	refreshFooter();
}

Object.assign(solSavingsPlugin, {
	activate(host) {
		return solSavingsPlugin(host);
	},
});

export default solSavingsPlugin;
