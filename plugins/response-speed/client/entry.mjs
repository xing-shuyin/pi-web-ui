import { apiBase as getSharedApiBase } from "@pi-web-ui/plugin-sdk/client";

const ACTION_SHOW_DETAILS = "response-speed:show-details";
const STYLE_ID = "response-speed-styles";
const MODAL_ID = "response-speed-modal-root";

function formatMs(ms) {
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

function getRating(ms) {
	if (ms < 800) return { label: "极速", color: "#10b981" };
	if (ms < 2000) return { label: "良好", color: "#3b82f6" };
	if (ms < 5000) return { label: "一般", color: "#f59e0b" };
	return { label: "偏慢", color: "#ef4444" };
}

function apiBase() {
	return getSharedApiBase("response-speed");
}

const state = {
	conversationId: null,
	stats: {
		count: 0,
		avgMs: null,
		minMs: null,
		maxMs: null,
		latestMs: null,
		recent: [],
	},
};

function ensureStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const s = document.createElement("style");
	s.id = STYLE_ID;
	s.textContent = `
		.resp-speed-overlay {
			position: fixed;
			inset: 0;
			z-index: 9999;
			background: rgba(0, 0, 0, 0.65);
			backdrop-filter: blur(4px);
			-webkit-backdrop-filter: blur(4px);
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 16px;
			animation: resp-speed-fadein 0.15s ease-out;
		}
		@keyframes resp-speed-fadein {
			from { opacity: 0; }
			to { opacity: 1; }
		}
		.resp-speed-modal {
			background: var(--bg-elev2, #1a1d26);
			color: var(--text, #e6e8ef);
			border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
			border-radius: 12px;
			box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
			width: 100%;
			max-width: 520px;
			max-height: 85vh;
			display: flex;
			flex-direction: column;
			overflow: hidden;
		}
		.resp-speed-head {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 14px 18px;
			border-bottom: 1px solid var(--border-soft, rgba(255, 255, 255, 0.08));
		}
		.resp-speed-title {
			font-size: 15px;
			font-weight: 600;
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.resp-speed-close {
			background: none;
			border: none;
			color: var(--text-dim, #9aa1b4);
			cursor: pointer;
			padding: 4px;
			font-size: 20px;
			line-height: 1;
			border-radius: 4px;
		}
		.resp-speed-close:hover {
			color: var(--text, #fff);
			background: rgba(255, 255, 255, 0.08);
		}
		.resp-speed-body {
			padding: 18px;
			overflow-y: auto;
			display: flex;
			flex-direction: column;
			gap: 16px;
		}
		.resp-speed-grid {
			display: grid;
			grid-template-columns: repeat(2, 1fr);
			gap: 10px;
		}
		.resp-speed-card {
			background: rgba(255, 255, 255, 0.03);
			border: 1px solid var(--border-soft, rgba(255, 255, 255, 0.06));
			border-radius: 8px;
			padding: 12px;
			display: flex;
			flex-direction: column;
			gap: 4px;
		}
		.resp-speed-card-label {
			font-size: 12px;
			color: var(--text-dim, #9aa1b4);
		}
		.resp-speed-card-val {
			font-size: 20px;
			font-weight: 600;
			font-family: var(--mono, monospace);
		}
		.resp-speed-card-val.highlight {
			color: var(--green, #10b981);
		}
		.resp-speed-section-title {
			font-size: 13px;
			font-weight: 600;
			color: var(--text-dim, #9aa1b4);
			margin-top: 4px;
		}
		.resp-speed-table-wrap {
			border: 1px solid var(--border-soft, rgba(255, 255, 255, 0.08));
			border-radius: 6px;
			overflow: hidden;
			max-height: 240px;
			overflow-y: auto;
		}
		.resp-speed-table {
			width: 100%;
			border-collapse: collapse;
			font-size: 12px;
			text-align: left;
		}
		.resp-speed-table th {
			background: rgba(255, 255, 255, 0.04);
			padding: 8px 10px;
			font-weight: 500;
			color: var(--text-dim, #9aa1b4);
			border-bottom: 1px solid var(--border-soft, rgba(255, 255, 255, 0.08));
			position: sticky;
			top: 0;
			backdrop-filter: blur(4px);
		}
		.resp-speed-table td {
			padding: 8px 10px;
			border-bottom: 1px solid rgba(255, 255, 255, 0.04);
		}
		.resp-speed-table tr:last-child td {
			border-bottom: none;
		}
		.resp-speed-footer {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 12px 18px;
			border-top: 1px solid var(--border-soft, rgba(255, 255, 255, 0.08));
		}
		.resp-speed-btn {
			padding: 6px 14px;
			border-radius: 6px;
			font-size: 13px;
			cursor: pointer;
			border: 1px solid var(--border, rgba(255, 255, 255, 0.15));
			background: rgba(255, 255, 255, 0.05);
			color: var(--text, #e6e8ef);
			transition: all 0.12s ease;
		}
		.resp-speed-btn:hover {
			background: rgba(255, 255, 255, 0.1);
		}
		.resp-speed-btn.danger {
			color: var(--red, #ef4444);
			border-color: rgba(239, 68, 68, 0.25);
		}
		.resp-speed-btn.danger:hover {
			background: rgba(239, 68, 68, 0.1);
		}
	`;
	document.head.appendChild(s);
}

async function fetchStats(targetConvId) {
	try {
		const convId = targetConvId || state.conversationId;
		const query = convId ? `?conversationId=${encodeURIComponent(convId)}` : "";
		const res = await fetch(`${apiBase()}/stats${query}`);
		if (res.ok) {
			const json = await res.json();
			if (json.conversationId) {
				state.conversationId = json.conversationId;
			}
			if (json.stats) {
				state.stats = json.stats;
				renderModalContent();
			}
		}
	} catch {}
}

async function resetStats() {
	try {
		await fetch(`${apiBase()}/reset`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: state.conversationId || undefined }),
		});
	} catch {}
	state.stats = {
		count: 0,
		avgMs: null,
		minMs: null,
		maxMs: null,
		latestMs: null,
		recent: [],
	};
	renderModalContent();
}

function renderModalContent() {
	const overlay = document.getElementById(MODAL_ID);
	if (!overlay) return;

	const stats = state.stats;
	const count = stats.count || 0;
	const avgStr = stats.avgMs ? formatMs(stats.avgMs) : "--";
	const latestStr = stats.latestMs ? formatMs(stats.latestMs) : "--";
	const minStr = stats.minMs ? formatMs(stats.minMs) : "--";
	const maxStr = stats.maxMs ? formatMs(stats.maxMs) : "--";

	let tableRows = "";
	if (stats.recent && stats.recent.length > 0) {
		tableRows = stats.recent
			.map((r, i) => {
				const rating = getRating(r.latencyMs);
				const timeStr = r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : `#${count - i}`;
				return `
					<tr>
						<td>${timeStr}</td>
						<td style="font-family: var(--mono, monospace); font-weight: 600;">${formatMs(r.latencyMs)}</td>
						<td><span style="color: ${rating.color}; font-weight: 500;">${rating.label}</span></td>
					</tr>
				`;
			})
			.join("");
	} else {
		tableRows = `<tr><td colspan="3" style="text-align: center; color: var(--text-dim, #888); padding: 18px;">当前对话暂无历史测速记录</td></tr>`;
	}

	const modal = overlay.querySelector(".resp-speed-modal");
	if (!modal) return;

	modal.innerHTML = `
		<div class="resp-speed-head">
			<div class="resp-speed-title">
				<span>⚡</span>
				<span>AI 响应速度统计看板（当前对话）</span>
			</div>
			<button type="button" class="resp-speed-close" aria-label="关闭">&times;</button>
		</div>
		<div class="resp-speed-body">
			<div class="resp-speed-grid">
				<div class="resp-speed-card">
					<span class="resp-speed-card-label">最新请求响应速度 (最新)</span>
					<span class="resp-speed-card-val highlight">${latestStr}</span>
				</div>
				<div class="resp-speed-card">
					<span class="resp-speed-card-label">平均响应速度 (均速)</span>
					<span class="resp-speed-card-val">${avgStr}</span>
				</div>
				<div class="resp-speed-card">
					<span class="resp-speed-card-label">最快响应时间</span>
					<span class="resp-speed-card-val" style="color: #10b981;">${minStr}</span>
				</div>
				<div class="resp-speed-card">
					<span class="resp-speed-card-label">最慢响应时间</span>
					<span class="resp-speed-card-val" style="color: #ef4444;">${maxStr}</span>
				</div>
			</div>

			<div style="font-size: 12px; color: var(--text-dim, #9aa1b4); line-height: 1.5; background: rgba(255,255,255,0.03); padding: 10px 12px; border-radius: 6px; border: 1px solid var(--border-soft, rgba(255,255,255,0.06));">
				💡 <strong>响应速度说明</strong>：统计当前对话向 AI 发起请求到收到首包响应（TTFT）的耗时。每个对话独立记录，提问与 AI 自循环中的每一次 turn 请求均独立测速。
			</div>

			<div class="resp-speed-section-title">最近响应明细 (当前对话样本总数: ${count} 次)</div>
			<div class="resp-speed-table-wrap">
				<table class="resp-speed-table">
					<thead>
						<tr>
							<th>时间</th>
							<th>首包响应耗时</th>
							<th>评级</th>
						</tr>
					</thead>
					<tbody>
						${tableRows}
					</tbody>
				</table>
			</div>
		</div>
		<div class="resp-speed-footer">
			<button type="button" class="resp-speed-btn danger" id="resp-speed-reset-btn">清空当前对话统计</button>
			<button type="button" class="resp-speed-btn" id="resp-speed-close-btn">关闭</button>
		</div>
	`;

	modal.querySelector(".resp-speed-close")?.addEventListener("click", closeDashboardModal);
	modal.querySelector("#resp-speed-close-btn")?.addEventListener("click", closeDashboardModal);
	modal.querySelector("#resp-speed-reset-btn")?.addEventListener("click", async () => {
		if (confirm("确定要清空当前对话的 AI 响应速度统计记录吗？")) {
			await resetStats();
		}
	});
}

function closeDashboardModal() {
	const el = document.getElementById(MODAL_ID);
	if (el) el.remove();
	window.removeEventListener("keydown", onKeyDown);
}

function onKeyDown(e) {
	if (e.key === "Escape") closeDashboardModal();
}

function showDashboardModal(convId) {
	ensureStyles();
	if (convId) {
		state.conversationId = convId;
	}

	let overlay = document.getElementById(MODAL_ID);
	if (!overlay) {
		overlay = document.createElement("div");
		overlay.id = MODAL_ID;
		overlay.className = "resp-speed-overlay";

		const modal = document.createElement("div");
		modal.className = "resp-speed-modal";
		overlay.appendChild(modal);

		overlay.addEventListener("click", (e) => {
			if (e.target === overlay) closeDashboardModal();
		});

		document.body.appendChild(overlay);
		window.addEventListener("keydown", onKeyDown);
	}

	renderModalContent();
	void fetchStats(convId);
}

function init() {
	void fetchStats();

	window.addEventListener("pi-web-ui:plugin-data", (e) => {
		if (e.detail?.pluginId === "response-speed") {
			const payload = e.detail.payload;
			if (payload?.type === "response_speed_stats") {
				if (!state.conversationId || !payload.conversationId || state.conversationId === payload.conversationId) {
					if (payload.conversationId) state.conversationId = payload.conversationId;
					if (payload.stats) {
						state.stats = payload.stats;
						renderModalContent();
					}
				}
			} else if (payload?.type === "response_speed_conversation_switched") {
				state.conversationId = payload.conversationId;
				if (payload.stats) {
					state.stats = payload.stats;
					renderModalContent();
				}
			} else if (payload?.type === "response_speed_open_modal") {
				if (payload.conversationId) state.conversationId = payload.conversationId;
				if (payload.stats) state.stats = payload.stats;
				showDashboardModal(payload.conversationId);
			}
		}
	});

	const host = window.__piWebUiHost;
	if (host && typeof host.onUiAction === "function") {
		host.onUiAction(ACTION_SHOW_DETAILS, () => {
			showDashboardModal();
		});
	}
}

if (typeof window !== "undefined") {
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init, { once: true });
	} else {
		init();
	}
}

export default {
	mount() {
		init();
		return () => {
			closeDashboardModal();
		};
	},
};
