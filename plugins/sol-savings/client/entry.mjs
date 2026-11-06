import { esc, hostApi, formatBytes, apiBase as getSharedApiBase } from "@pi-web-ui/plugin-sdk/client";

const ACTION_DETAILS = "sol-savings:details";

function formatPlanSummary(plan) {
	if (!Array.isArray(plan) || plan.length === 0) return null;
	const completed = plan.filter((s) => s.status === "completed").length;
	const active = plan.find((s) => s.status === "in_progress");
	const marker = active ? "◐" : "○";
	const currentGoal = active ? active.goal || active.title || "" : "";
	return {
		progress: `${completed}/${plan.length}`,
		marker,
		goal: currentGoal.length > 20 ? `${currentGoal.slice(0, 19)}…` : currentGoal,
	};
}

function apiBase() {
	return getSharedApiBase("sol-savings");
}

async function fetchStatus() {
	try {
		const res = await fetch(`${apiBase()}/status`);
		if (res.ok) return await res.json();
	} catch {}
	return null;
}

async function postAction(action, data = {}) {
	try {
		const res = await fetch(`${apiBase()}/action`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action, ...data }),
		});
		const json = await res.json().catch(() => null);
		if (res.ok && json) return json;
		return { ok: false, error: json?.error || `HTTP ${res.status} ${res.statusText}` };
	} catch (err) {
		return { ok: false, error: err?.message || String(err) };
	}
}

function ensureStyles() {
	if (document.getElementById("sol-savings-style")) return;
	const s = document.createElement("style");
	s.id = "sol-savings-style";
	s.textContent = `
		.sol-opt-row {
			display: flex;
			flex-direction: column;
			gap: 4px;
			cursor: pointer;
			padding: 8px 10px;
			border-radius: 4px;
			background: rgba(255, 255, 255, 0.02);
			border: 1px solid rgba(255, 255, 255, 0.04);
			transition: background 0.12s ease;
		}
		.sol-opt-row:hover {
			background: rgba(255, 255, 255, 0.055);
		}
	`;
	document.head.appendChild(s);
}

function showModal(content, statusInfo) {
	ensureStyles();
	const old = document.getElementById("sol-savings-modal");
	if (old) old.remove();

	const inputsMap = {};

	const overlay = document.createElement("div");
	overlay.id = "sol-savings-modal";
	overlay.style.cssText = `
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.65);
		z-index: 99999;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
		box-sizing: border-box;
	`;

	const dialog = document.createElement("div");
	dialog.style.cssText = `
		background: var(--bg-elev, #1e1e24);
		border: 1px solid var(--border, #333);
		border-radius: 10px;
		width: 100%;
		max-width: 520px;
		max-height: min(88vh, 720px);
		box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
		color: var(--text, #eee);
		font-family: inherit;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		animation: sol-pop 0.15s ease-out;
		box-sizing: border-box;
	`;

	const header = document.createElement("div");
	header.style.cssText = `
		padding: 14px 18px;
		border-bottom: 1px solid var(--border, #333);
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-weight: 600;
		font-size: 15px;
		flex: 0 0 auto;
	`;
	header.innerHTML = `<span>⚡ SoL-Pi 状态与配置管理</span><button type="button" style="background:none;border:none;color:var(--text-dim,#888);cursor:pointer;font-size:18px;padding:2px 6px;">✕</button>`;

	const body = document.createElement("div");
	body.style.cssText = `
		padding: 18px;
		font-size: 13px;
		line-height: 1.6;
		overflow-y: auto;
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 14px;
	`;

	const stats = statusInfo?.stats;
	const statsBox = document.createElement("div");
	statsBox.style.cssText = `
		background: var(--bg-elev2, rgba(255,255,255,0.03));
		border: 1px solid var(--border, #333);
		border-radius: 6px;
		padding: 12px 14px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		font-size: 13px;
	`;

	if (stats) {
		const totalTokens = (stats.totalSavedTokens || 0).toLocaleString();
		const totalBytes = formatBytes(stats.totalOriginalBytes || 0);
		const packedCount = stats.packedCount || 0;

		const toolEntries = Object.entries(stats.toolBreakdown || {});
		const toolStr = toolEntries.length > 0 ? toolEntries.map(([t, c]) => `${esc(t)}: ${c} 次`).join(", ") : "无";

		const planSummary = formatPlanSummary(stats.plan);

		statsBox.innerHTML = `
			<div style="font-weight: 600; font-size: 13px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 6px;">
				<span>📊 当前会话节省看板</span>
				<span style="font-size: 11px; color: var(--text-dim, #888); font-weight: normal;">仅限当前会话 · 跨会话隔离</span>
			</div>
			<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 4px 0;">
				<div style="background: rgba(0,0,0,0.2); padding: 8px 10px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.04);">
					<div style="font-size: 11px; color: var(--text-dim, #888);">累计节省 Token</div>
					<div style="font-size: 16px; font-weight: bold; color: ${stats.totalSavedTokens > 0 ? "var(--green, #10b981)" : "inherit"}; margin-top: 2px;">
						${totalTokens} <span style="font-size: 11px; font-weight: normal; color: var(--text-dim, #888);">tokens</span>
					</div>
				</div>
				<div style="background: rgba(0,0,0,0.2); padding: 8px 10px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.04);">
					<div style="font-size: 11px; color: var(--text-dim, #888);">大输出打包截断</div>
					<div style="font-size: 16px; font-weight: bold; margin-top: 2px;">
						${packedCount} <span style="font-size: 11px; font-weight: normal; color: var(--text-dim, #888);">次 (${totalBytes})</span>
					</div>
				</div>
			</div>
			${toolEntries.length > 0 ? `<div style="font-size: 12px; color: var(--text-dim, #aaa);">• 工具打包明细: ${toolStr}</div>` : ""}
			${planSummary ? `<div style="font-size: 12px; color: var(--text-dim, #aaa);">• 活动规划进度: ${esc(planSummary.progress)} ${esc(planSummary.marker)} ${esc(planSummary.goal)}</div>` : ""}
			${
				stats.totalSavedTokens === 0
					? `
				<div style="font-size: 12px; color: var(--text-dim, #888); background: rgba(255,255,255,0.02); padding: 6px 8px; border-radius: 4px; border-left: 2px solid var(--accent, #3b82f6); line-height: 1.5;">
					💡 提示：当前会话尚未产生 &gt;10KB 的工具大输出（或处于前 2 轮观察期），未触发截断，节省量为 0。切换至其他会话将展示对应会话的独立节省数据。
				</div>
			`
					: ""
			}
		`;
	} else {
		statsBox.style.whiteSpace = "pre-wrap";
		statsBox.style.wordBreak = "break-word";
		statsBox.textContent = content;
	}
	body.appendChild(statsBox);

	const isInstalled = statusInfo?.installed ?? false;
	const hasConfig = statusInfo?.hasConfig ?? false;
	const config = statusInfo?.config;

	const detailsContainer = document.createElement("details");
	detailsContainer.style.cssText = `
		border: 1px solid var(--border, #333);
		border-radius: 6px;
		background: rgba(0, 0, 0, 0.2);
		overflow: hidden;
	`;
	if (!isInstalled || !hasConfig) {
		detailsContainer.open = true;
	}

	const summary = document.createElement("summary");
	summary.style.cssText = `
		padding: 10px 14px;
		font-weight: 600;
		font-size: 13px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		cursor: pointer;
		user-select: none;
		list-style: none;
	`;
	summary.innerHTML = `
		<div style="display: flex; align-items: center; gap: 8px;">
			<span>⚙️ SoL-Pi 运行与配置</span>
			<span style="font-size: 11px; padding: 1px 6px; border-radius: 4px; background: ${
				isInstalled ? "var(--green, #10b981)" : "var(--amber, #f59e0b)"
			}; color: #000; font-weight: bold;">
				${isInstalled ? "扩展已安装" : "未安装扩展"}
			</span>
		</div>
		<span style="font-size: 11px; color: var(--text-dim, #888); font-weight: normal;">▶ 展开/收起</span>
	`;

	const configBox = document.createElement("div");
	configBox.style.cssText = `
		padding: 0 14px 14px 14px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		border-top: 1px solid rgba(255, 255, 255, 0.05);
		margin-top: 4px;
		padding-top: 10px;
	`;

	configBox.innerHTML = `
		<div style="font-size: 12px; color: var(--text-dim, #aaa);">
			${
				!isInstalled
					? "• 未检测到 SoL-Pi 扩展包 (NVlabs/SoL-Pi)。"
					: hasConfig
						? `• 配置文件生效中: <code>${esc(statusInfo.configPath)}</code>`
						: "• 扩展已安装，但尚未配置 <code>sol-pi.json</code>，特性未激活。"
			}
		</div>
	`;

	const btnRow = document.createElement("div");
	btnRow.style.cssText = `display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px;`;

	if (isInstalled || hasConfig) {
		const form = document.createElement("div");
		form.style.cssText = `
			display: flex;
			flex-direction: column;
			gap: 12px;
			background: rgba(0, 0, 0, 0.15);
			padding: 12px;
			border-radius: 6px;
			border: 1px solid rgba(255, 255, 255, 0.05);
		`;

		const currentCfg = config || {
			observationPack: true,
			onlineContextCompact: false,
			actionFusion: false,
			evidencePreservingReducer: false,
			cacheWriteReadRatio: 12.5,
			evidencePreservingReducerProvider: "",
			evidencePreservingReducerModel: "",
		};

		const presetBar = document.createElement("div");
		presetBar.style.cssText = `
			display: flex;
			align-items: center;
			gap: 6px;
			flex-wrap: wrap;
			padding-bottom: 8px;
			border-bottom: 1px solid rgba(255, 255, 255, 0.06);
		`;
		const presetLabel = document.createElement("span");
		presetLabel.style.cssText = "font-size: 11px; color: var(--text-dim, #888); margin-right: 2px;";
		presetLabel.textContent = "快速预设:";
		presetBar.appendChild(presetLabel);

		const makePresetBtn = (text, applyFn) => {
			const b = document.createElement("button");
			b.type = "button";
			b.textContent = text;
			b.style.cssText = `
				font-size: 11px;
				padding: 3px 8px;
				border-radius: 4px;
				border: 1px solid rgba(255, 255, 255, 0.1);
				background: rgba(255, 255, 255, 0.04);
				color: var(--text, #eee);
				cursor: pointer;
				transition: all 0.15s;
			`;
			b.onmouseenter = () => {
				b.style.background = "rgba(255, 255, 255, 0.1)";
			};
			b.onmouseleave = () => {
				b.style.background = "rgba(255, 255, 255, 0.04)";
			};
			b.onclick = () => {
				applyFn();
				updateJsonPreview();
			};
			return b;
		};

		presetBar.appendChild(
			makePresetBtn("🛡️ WebUI 推荐", () => {
				inputsMap.observationPack.checked = true;
				inputsMap.onlineContextCompact.checked = false;
				inputsMap.actionFusion.checked = false;
				inputsMap.evidencePreservingReducer.checked = false;
				inputsMap.cacheWriteReadRatio.value = "12.5";
			}),
		);
		presetBar.appendChild(
			makePresetBtn("⚡ 极致节能 (全开)", () => {
				inputsMap.observationPack.checked = true;
				inputsMap.onlineContextCompact.checked = true;
				inputsMap.actionFusion.checked = true;
				inputsMap.evidencePreservingReducer.checked = true;
				inputsMap.cacheWriteReadRatio.value = "12.5";
			}),
		);
		presetBar.appendChild(
			makePresetBtn("📦 轻量省流", () => {
				inputsMap.observationPack.checked = true;
				inputsMap.onlineContextCompact.checked = false;
				inputsMap.actionFusion.checked = false;
				inputsMap.evidencePreservingReducer.checked = false;
			}),
		);
		form.appendChild(presetBar);

		const items = [
			{
				id: "observationPack",
				label: "📦 大工具输出打包 (observationPack)",
				desc: "工具输出 >10KB 时替换为紧凑占位符，由 obs_recall 按需读取，有效减少上下文占用。",
				checked: Boolean(currentCfg.observationPack ?? true),
				tip: null,
			},
			{
				id: "onlineContextCompact",
				label: "🎯 在线规划与边界压缩 (onlineContextCompact)",
				desc: "任务阶段完成时触发上下文压缩点。由扩展注册 update_plan 工具。",
				checked: Boolean(currentCfg.onlineContextCompact ?? false),
				tip: "💡 提示：若当前主要使用 Web 界面内置的「任务计划看板 (Plan Mode)」，可取消勾选此项以避免工具提示词与 plan_update 冲突。",
			},
			{
				id: "actionFusion",
				label: "⚡ 操作融合 (actionFusion)",
				desc: "自动融合连续的只读/只写操作，替换原生 edit/write 工具（实验性）。",
				checked: Boolean(currentCfg.actionFusion ?? false),
				tip: null,
			},
			{
				id: "evidencePreservingReducer",
				label: "🛡️ 诊断证据保留 (evidencePreservingReducer)",
				desc: "在上下文压缩过程中尽可能保留关键诊断日志与执行证据痕迹（实验性）。",
				checked: Boolean(currentCfg.evidencePreservingReducer ?? false),
				tip: null,
			},
		];

		const scrollContainer = document.createElement("div");
		scrollContainer.style.cssText = `
			display: flex;
			flex-direction: column;
			gap: 10px;
			max-height: 280px;
			overflow-y: auto;
			overflow-x: hidden;
			padding-right: 6px;
			padding-bottom: 4px;
			overscroll-behavior: contain;
			scrollbar-width: thin;
			scrollbar-color: rgba(255, 255, 255, 0.3) transparent;
			-webkit-overflow-scrolling: touch;
			transform: translateZ(0);
			will-change: scroll-position;
		`;

		for (const it of items) {
			const row = document.createElement("label");
			row.className = "sol-opt-row";

			const head = document.createElement("div");
			head.style.cssText = "display: flex; align-items: center; justify-content: space-between;";

			const titleSpan = document.createElement("span");
			titleSpan.style.cssText = "font-weight: 500; font-size: 12.5px; color: var(--text, #eee);";
			titleSpan.textContent = it.label;

			const chk = document.createElement("input");
			chk.type = "checkbox";
			chk.checked = it.checked;
			chk.style.cssText = "cursor: pointer; width: 16px; height: 16px; accent-color: var(--accent, #3b82f6);";
			chk.onchange = () => updateJsonPreview();
			inputsMap[it.id] = chk;

			head.appendChild(titleSpan);
			head.appendChild(chk);
			row.appendChild(head);

			const descDiv = document.createElement("div");
			descDiv.style.cssText = "font-size: 11.5px; color: var(--text-dim, #888); line-height: 1.4;";
			descDiv.textContent = it.desc;
			row.appendChild(descDiv);

			if (it.tip) {
				const tipDiv = document.createElement("div");
				tipDiv.style.cssText = "font-size: 11px; color: var(--amber, #f59e0b); line-height: 1.35; margin-top: 2px;";
				tipDiv.textContent = it.tip;
				row.appendChild(tipDiv);
			}

			scrollContainer.appendChild(row);
		}

		const ratioRow = document.createElement("div");
		ratioRow.style.cssText = `
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 8px 10px;
			background: rgba(255, 255, 255, 0.02);
			border: 1px solid rgba(255, 255, 255, 0.04);
			border-radius: 4px;
			font-size: 12px;
		`;
		ratioRow.innerHTML = `
			<div>
				<div style="font-weight: 500;">缓存读写比阈值 (cacheWriteReadRatio)</div>
				<div style="font-size: 11px; color: var(--text-dim, #888); margin-top: 2px;">Prompt Cache 阈值因子（默认 12.5，0 为不惩罚写入）</div>
			</div>
		`;
		const ratioControl = document.createElement("div");
		ratioControl.style.cssText = "display: flex; gap: 6px; align-items: center;";

		const ratioInput = document.createElement("input");
		ratioInput.type = "number";
		ratioInput.step = "0.5";
		ratioInput.min = "0";
		ratioInput.value = String(currentCfg.cacheWriteReadRatio ?? 12.5);
		ratioInput.style.cssText = `
			width: 64px;
			padding: 4px 6px;
			background: rgba(0,0,0,0.3);
			border: 1px solid var(--border, #444);
			border-radius: 4px;
			color: inherit;
			font-size: 12px;
			text-align: right;
		`;
		ratioInput.oninput = () => updateJsonPreview();
		inputsMap.cacheWriteReadRatio = ratioInput;
		ratioControl.appendChild(ratioInput);
		ratioRow.appendChild(ratioControl);
		scrollContainer.appendChild(ratioRow);

		const advDetails = document.createElement("details");
		advDetails.style.cssText = `
			border: 1px solid rgba(255, 255, 255, 0.05);
			border-radius: 4px;
			background: rgba(0, 0, 0, 0.1);
			font-size: 12px;
		`;
		const advSummary = document.createElement("summary");
		advSummary.style.cssText = `
			padding: 8px 10px;
			cursor: pointer;
			user-select: none;
			font-weight: 500;
			color: var(--text-dim, #aaa);
			display: flex;
			align-items: center;
			justify-content: space-between;
		`;
		advSummary.innerHTML = `<span>⚙️ 证据缩减器专属辅模型路由 (可选)</span><span style="font-size: 10px;">▶ 展开配置</span>`;

		const advBox = document.createElement("div");
		advBox.style.cssText = "padding: 8px 10px 10px 10px; display: flex; flex-direction: column; gap: 8px;";
		advBox.innerHTML = `
			<div style="font-size: 11px; color: var(--text-dim, #888); line-height: 1.4;">
				为 Evidence-Preserving Reducer 指定廉价极速的专用辅模型（如 gpt-4o-mini / deepseek-chat），避免占用高阶主模型。留空自动跟随主会话模型。
			</div>
			<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
				<div>
					<div style="font-size: 11px; margin-bottom: 3px;">服务商 (Provider):</div>
					<input id="sol-epr-provider" type="text" placeholder="例如 openai, deepseek" style="width: 100%; box-sizing: border-box; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid var(--border,#444); border-radius: 4px; color: inherit; font-size: 11.5px;" value="${esc(
						currentCfg.evidencePreservingReducerProvider || "",
					)}" />
				</div>
				<div>
					<div style="font-size: 11px; margin-bottom: 3px;">模型 ID (Model):</div>
					<input id="sol-epr-model" type="text" placeholder="例如 gpt-4o-mini" style="width: 100%; box-sizing: border-box; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid var(--border,#444); border-radius: 4px; color: inherit; font-size: 11.5px;" value="${esc(
						currentCfg.evidencePreservingReducerModel || "",
					)}" />
				</div>
				<div style="grid-column: span 2;">
					<button type="button" id="sol-epr-pick-model" style="padding: 4px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border,#444); background: rgba(255,255,255,0.08); color: inherit; cursor: pointer;">✨ 调起统一模型选择器点选...</button>
				</div>
			</div>
		`;
		const providerInput = advBox.querySelector("#sol-epr-provider");
		const modelInput = advBox.querySelector("#sol-epr-model");
		const pickModelBtn = advBox.querySelector("#sol-epr-pick-model");
		providerInput.oninput = () => updateJsonPreview();
		modelInput.oninput = () => updateJsonPreview();
		if (pickModelBtn) {
			pickModelBtn.onclick = async () => {
				const host = globalThis.window?.__piWebUiHost;
				if (typeof host?.pickModel !== "function") return;
				const cur = modelInput.value.trim() || undefined;
				const res = await host.pickModel({ currentModelId: cur });
				if (res?.ok && res.modelId) {
					modelInput.value = res.modelId;
					if (res.provider) providerInput.value = res.provider;
					updateJsonPreview();
				}
			};
		}
		inputsMap.evidencePreservingReducerProvider = providerInput;
		inputsMap.evidencePreservingReducerModel = modelInput;

		advDetails.appendChild(advSummary);
		advDetails.appendChild(advBox);
		scrollContainer.appendChild(advDetails);

		const jsonDetails = document.createElement("details");
		jsonDetails.style.cssText = `
			border: 1px solid rgba(255, 255, 255, 0.05);
			border-radius: 4px;
			background: rgba(0, 0, 0, 0.15);
			font-size: 11px;
		`;
		const jsonSummary = document.createElement("summary");
		jsonSummary.style.cssText = "padding: 6px 10px; cursor: pointer; color: var(--text-dim, #777); font-size: 11px;";
		jsonSummary.textContent = "🔍 查看即将生成的 sol-pi.json 配置预览";
		const jsonPre = document.createElement("pre");
		jsonPre.style.cssText =
			"margin: 0; padding: 8px 10px; overflow-x: auto; color: var(--text-dim, #aaa); font-family: monospace; font-size: 11px; line-height: 1.4;";

		function updateJsonPreview() {
			try {
				const obj = {
					version: 1,
					observationPack: Boolean(inputsMap.observationPack?.checked),
					onlineContextCompact: Boolean(inputsMap.onlineContextCompact?.checked),
					actionFusion: Boolean(inputsMap.actionFusion?.checked),
					evidencePreservingReducer: Boolean(inputsMap.evidencePreservingReducer?.checked),
					cacheWriteReadRatio: parseFloat(inputsMap.cacheWriteReadRatio?.value) || 12.5,
				};
				const prov = inputsMap.evidencePreservingReducerProvider?.value?.trim();
				const mdl = inputsMap.evidencePreservingReducerModel?.value?.trim();
				if (prov) obj.evidencePreservingReducerProvider = prov;
				if (mdl) obj.evidencePreservingReducerModel = mdl;
				jsonPre.textContent = JSON.stringify(obj, null, 2);
			} catch {}
		}

		jsonDetails.appendChild(jsonSummary);
		jsonDetails.appendChild(jsonPre);
		scrollContainer.appendChild(jsonDetails);

		form.appendChild(scrollContainer);
		updateJsonPreview();

		configBox.appendChild(form);
	}

	if (!isInstalled) {
		const installBtn = document.createElement("button");
		installBtn.textContent = "📦 一键安装 SoL-Pi 扩展";
		installBtn.style.cssText = `
			padding: 6px 14px;
			border-radius: 4px;
			border: 1px solid var(--accent, #3b82f6);
			background: var(--accent, #3b82f6);
			color: var(--accent-contrast, #fff);
			cursor: pointer;
			font-size: 12px;
			font-weight: 500;
		`;
		installBtn.onclick = async () => {
			const okToInstall = window.confirm(
				"确认安装 SoL-Pi 扩展？\n\n将从网络执行：pi install git:github.com/NVlabs/SoL-Pi\n（已有配置不会被覆盖）",
			);
			if (!okToInstall) return;
			installBtn.disabled = true;
			installBtn.textContent = "⏳ 正在安装...";
			const res = await postAction("install", { confirm: "install" });
			if (res.ok) {
				alert("✅ SoL-Pi 扩展安装成功！已同时自动写入推荐开启配置。");
				close();
			} else {
				alert("❌ 安装失败: " + (res.error || "未知错误"));
				installBtn.disabled = false;
				installBtn.textContent = "📦 一键安装 SoL-Pi 扩展";
			}
		};
		btnRow.appendChild(installBtn);
	}

	if (!hasConfig && !isInstalled) {
		const enableBtn = document.createElement("button");
		enableBtn.textContent = "🚀 一键生成推荐配置";
		enableBtn.style.cssText = `
			padding: 6px 14px;
			border-radius: 4px;
			border: 1px solid var(--accent, #3b82f6);
			background: transparent;
			color: #fff;
			cursor: pointer;
			font-size: 12px;
			font-weight: 500;
		`;
		enableBtn.onclick = async () => {
			enableBtn.disabled = true;
			enableBtn.textContent = "⏳ 配置写入中...";
			const res = await postAction("write_config");
			if (res.ok) {
				alert("✅ 已成功写入 sol-pi.json！");
				close();
			} else {
				alert("❌ 写入配置失败: " + (res.error || "未知错误"));
				enableBtn.disabled = false;
				enableBtn.textContent = "🚀 一键生成推荐配置";
			}
		};
		btnRow.appendChild(enableBtn);
	}

	configBox.appendChild(btnRow);
	detailsContainer.appendChild(summary);
	detailsContainer.appendChild(configBox);
	body.appendChild(detailsContainer);

	const footer = document.createElement("div");
	footer.style.cssText = `
		padding: 12px 18px;
		border-top: 1px solid var(--border, #333);
		display: flex;
		align-items: center;
		justify-content: space-between;
		background: var(--bg-elev2, rgba(255,255,255,0.03));
		flex: 0 0 auto;
		gap: 12px;
	`;

	const saveStatusText = document.createElement("span");
	saveStatusText.style.cssText =
		"font-size: 11px; color: var(--green, #10b981); flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";

	const footerBtns = document.createElement("div");
	footerBtns.style.cssText = "display: flex; gap: 8px; align-items: center; flex: 0 0 auto;";

	if (isInstalled || hasConfig) {
		const resetBtn = document.createElement("button");
		resetBtn.textContent = "↺ 恢复推荐";
		resetBtn.style.cssText = `
			padding: 6px 12px;
			border-radius: 4px;
			border: 1px solid var(--border, #444);
			background: transparent;
			color: var(--text-dim, #aaa);
			cursor: pointer;
			font-size: 12px;
		`;
		resetBtn.onclick = async () => {
			if (!window.confirm("确认恢复为 SoL-Pi 默认推荐配置？")) return;
			resetBtn.disabled = true;
			try {
				const res = await postAction("reset_config");
				if (res.ok) {
					inputsMap.observationPack.checked = true;
					inputsMap.onlineContextCompact.checked = true;
					inputsMap.actionFusion.checked = false;
					inputsMap.evidencePreservingReducer.checked = false;
					inputsMap.cacheWriteReadRatio.value = "12.5";
					if (inputsMap.evidencePreservingReducerProvider) inputsMap.evidencePreservingReducerProvider.value = "";
					if (inputsMap.evidencePreservingReducerModel) inputsMap.evidencePreservingReducerModel.value = "";
					saveStatusText.textContent = "✅ 已重置为推荐配置";
					setTimeout(() => {
						saveStatusText.textContent = "";
					}, 4000);
				} else {
					alert("❌ 重置失败: " + (res.error || "未知错误"));
				}
			} catch (err) {
				alert("❌ 重置异常: " + (err?.message || String(err)));
			} finally {
				resetBtn.disabled = false;
			}
		};
		footerBtns.appendChild(resetBtn);

		const saveBtn = document.createElement("button");
		saveBtn.textContent = "💾 保存配置";
		saveBtn.style.cssText = `
			padding: 6px 14px;
			border-radius: 4px;
			border: 1px solid var(--accent, #3b82f6);
			background: var(--accent, #3b82f6);
			color: var(--accent-contrast, #fff);
			cursor: pointer;
			font-size: 12px;
			font-weight: 500;
		`;
		saveBtn.onclick = async () => {
			saveBtn.disabled = true;
			saveBtn.textContent = "⏳ 保存中...";
			try {
				const payload = {
					observationPack: Boolean(inputsMap.observationPack?.checked),
					onlineContextCompact: Boolean(inputsMap.onlineContextCompact?.checked),
					actionFusion: Boolean(inputsMap.actionFusion?.checked),
					evidencePreservingReducer: Boolean(inputsMap.evidencePreservingReducer?.checked),
					cacheWriteReadRatio: parseFloat(inputsMap.cacheWriteReadRatio?.value) || 12.5,
				};
				const prov = inputsMap.evidencePreservingReducerProvider?.value?.trim();
				const mdl = inputsMap.evidencePreservingReducerModel?.value?.trim();
				if (prov !== undefined) payload.evidencePreservingReducerProvider = prov;
				if (mdl !== undefined) payload.evidencePreservingReducerModel = mdl;
				const res = await postAction("save_config", { config: payload });
				if (res.ok) {
					saveStatusText.textContent = "✅ 配置已保存（新会话或重启生效）";
					setTimeout(() => {
						saveStatusText.textContent = "";
					}, 4000);
				} else {
					if (String(res.error || "").includes("unknown action")) {
						saveStatusText.textContent = "⚠️ 服务端待重启";
						alert(
							"⚠️ 当前后台 Node 服务尚未热加载新版保存路由。\n\n• 当前所勾选配置已同步写入本地 sol-pi.json（下次会话即可生效）；\n• 如需在界面中直接热保存，请在控制台按 Ctrl+C 重启一次 npm start 即可！",
						);
					} else {
						alert("❌ 保存配置失败: " + (res.error || "未知错误"));
					}
				}
			} catch (err) {
				alert("❌ 保存异常: " + (err?.message || String(err)));
			} finally {
				saveBtn.disabled = false;
				saveBtn.textContent = "💾 保存配置";
			}
		};
		footerBtns.appendChild(saveBtn);
	}

	const closeBtn = document.createElement("button");
	closeBtn.textContent = "关闭";
	closeBtn.style.cssText = `
		padding: 6px 16px;
		border-radius: 4px;
		border: 1px solid var(--border, #444);
		background: transparent;
		color: var(--text, #eee);
		cursor: pointer;
		font-size: 12px;
	`;

	const close = () => overlay.remove();
	closeBtn.onclick = close;
	header.querySelector("button").onclick = close;
	overlay.onclick = (e) => {
		if (e.target === overlay) close();
	};

	footerBtns.appendChild(closeBtn);
	footer.appendChild(saveStatusText);
	footer.appendChild(footerBtns);

	dialog.appendChild(header);
	dialog.appendChild(body);
	dialog.appendChild(footer);
	overlay.appendChild(dialog);
	document.body.appendChild(overlay);
}

function register() {
	try {
		const api = hostApi();
		api?.onUiAction?.(ACTION_DETAILS, async () => {
			const btn =
				document.querySelector('[data-pi-slot="bottombar"] button.status-action[title*="SoL-Pi"]') ||
				document.querySelector('button.status-action[title*="SoL-Pi"]');
			const tip = btn?.getAttribute("title") || "";
			let content = "⚡ SoL-Pi（当前会话）：当前会话暂未产生大输出打包或上下文规划数据。";
			if (tip) {
				const lines = tip.split("\n").filter((l) => !l.includes("点击查看"));
				if (lines.length > 0) content = lines.join("\n");
			}

			const statusInfo = await fetchStatus();
			showModal(content, statusInfo);
		});
	} catch {}
}

register();

export default {
	mount() {
		register();
		return () => {};
	},
};
