import { esc, hostApi, formatBytes, apiBase as getSharedApiBase } from "@pi-web-ui/plugin-sdk/client";
import { makeT } from "./i18n.mjs";

const ACTION_DETAILS = "sol-savings:details";
const t = makeT();

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
	header.innerHTML = `<span>${t("panelTitle")}</span><button type="button" style="background:none;border:none;color:var(--text-dim,#888);cursor:pointer;font-size:18px;padding:2px 6px;">✕</button>`;

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
		const toolStr =
			toolEntries.length > 0
				? toolEntries.map(([name, count]) => t("toolBreakdownItem", { name: esc(name), count })).join(", ")
				: t("toolBreakdownNone");

		const planSummary = formatPlanSummary(stats.plan);

		statsBox.innerHTML = `
			<div style="font-weight: 600; font-size: 13px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 6px;">
				<span>${t("savingsTitle")}</span>
				<span style="font-size: 11px; color: var(--text-dim, #888); font-weight: normal;">${t("savingsScope")}</span>
			</div>
			<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 4px 0;">
				<div style="background: rgba(0,0,0,0.2); padding: 8px 10px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.04);">
					<div style="font-size: 11px; color: var(--text-dim, #888);">${t("statTotalSaved")}</div>
					<div style="font-size: 16px; font-weight: bold; color: ${stats.totalSavedTokens > 0 ? "var(--green, #10b981)" : "inherit"}; margin-top: 2px;">
						${totalTokens} <span style="font-size: 11px; font-weight: normal; color: var(--text-dim, #888);">tokens</span>
					</div>
				</div>
				<div style="background: rgba(0,0,0,0.2); padding: 8px 10px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.04);">
					<div style="font-size: 11px; color: var(--text-dim, #888);">${t("statPacked")}</div>
					<div style="font-size: 16px; font-weight: bold; margin-top: 2px;">
						${packedCount} <span style="font-size: 11px; font-weight: normal; color: var(--text-dim, #888);">${t("statPackedUnit", { bytes: totalBytes })}</span>
					</div>
				</div>
			</div>
			${toolEntries.length > 0 ? `<div style="font-size: 12px; color: var(--text-dim, #aaa);">${t("toolBreakdown", { list: toolStr })}</div>` : ""}
			${planSummary ? `<div style="font-size: 12px; color: var(--text-dim, #aaa);">${t("planProgress", { progress: esc(planSummary.progress), marker: esc(planSummary.marker), goal: esc(planSummary.goal) })}</div>` : ""}
			${
				stats.totalSavedTokens === 0
					? `
				<div style="font-size: 12px; color: var(--text-dim, #888); background: rgba(255,255,255,0.02); padding: 6px 8px; border-radius: 4px; border-left: 2px solid var(--accent, #3b82f6); line-height: 1.5;">
					${t("emptyTip")}
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
			<span>${t("runtimeSection")}</span>
			<span style="font-size: 11px; padding: 1px 6px; border-radius: 4px; background: ${
				isInstalled ? "var(--green, #10b981)" : "var(--amber, #f59e0b)"
			}; color: #000; font-weight: bold;">
				${t(isInstalled ? "installed" : "notInstalled")}
			</span>
		</div>
		<span style="font-size: 11px; color: var(--text-dim, #888); font-weight: normal;">${t("expandCollapse")}</span>
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
					? t("statusMissingPkg")
					: hasConfig
						? t("statusConfigActive", { path: `<code>${esc(statusInfo.configPath)}</code>` })
						: t("statusConfigMissing")
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
		presetLabel.textContent = t("presetsLabel");
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
			makePresetBtn(t("presetWebui"), () => {
				inputsMap.observationPack.checked = true;
				inputsMap.onlineContextCompact.checked = false;
				inputsMap.actionFusion.checked = false;
				inputsMap.evidencePreservingReducer.checked = false;
				inputsMap.cacheWriteReadRatio.value = "12.5";
			}),
		);
		presetBar.appendChild(
			makePresetBtn(t("presetMax"), () => {
				inputsMap.observationPack.checked = true;
				inputsMap.onlineContextCompact.checked = true;
				inputsMap.actionFusion.checked = true;
				inputsMap.evidencePreservingReducer.checked = true;
				inputsMap.cacheWriteReadRatio.value = "12.5";
			}),
		);
		presetBar.appendChild(
			makePresetBtn(t("presetLight"), () => {
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
				label: t("optObservationPackLabel"),
				desc: t("optObservationPackDesc"),
				checked: Boolean(currentCfg.observationPack ?? true),
				tip: null,
			},
			{
				id: "onlineContextCompact",
				label: t("optOnlineCompactLabel"),
				desc: t("optOnlineCompactDesc"),
				checked: Boolean(currentCfg.onlineContextCompact ?? false),
				tip: t("optOnlineCompactTip"),
			},
			{
				id: "actionFusion",
				label: t("optActionFusionLabel"),
				desc: t("optActionFusionDesc"),
				checked: Boolean(currentCfg.actionFusion ?? false),
				tip: null,
			},
			{
				id: "evidencePreservingReducer",
				label: t("optEvidenceReducerLabel"),
				desc: t("optEvidenceReducerDesc"),
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
				<div style="font-weight: 500;">${t("ratioLabel")}</div>
				<div style="font-size: 11px; color: var(--text-dim, #888); margin-top: 2px;">${t("ratioDesc")}</div>
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
		advSummary.innerHTML = `<span>${t("advSummary")}</span><span style="font-size: 10px;">${t("advExpand")}</span>`;

		const advBox = document.createElement("div");
		advBox.style.cssText = "padding: 8px 10px 10px 10px; display: flex; flex-direction: column; gap: 8px;";
		advBox.innerHTML = `
			<div style="font-size: 11px; color: var(--text-dim, #888); line-height: 1.4;">
				${t("advDesc")}
			</div>
			<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
				<div>
					<div style="font-size: 11px; margin-bottom: 3px;">${t("providerLabel")}</div>
					<input id="sol-epr-provider" type="text" placeholder="${t("providerPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid var(--border,#444); border-radius: 4px; color: inherit; font-size: 11.5px;" value="${esc(
						currentCfg.evidencePreservingReducerProvider || "",
					)}" />
				</div>
				<div>
					<div style="font-size: 11px; margin-bottom: 3px;">${t("modelLabel")}</div>
					<input id="sol-epr-model" type="text" placeholder="${t("modelPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid var(--border,#444); border-radius: 4px; color: inherit; font-size: 11.5px;" value="${esc(
						currentCfg.evidencePreservingReducerModel || "",
					)}" />
				</div>
				<div style="grid-column: span 2;">
					<button type="button" id="sol-epr-pick-model" style="padding: 4px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border,#444); background: rgba(255,255,255,0.08); color: inherit; cursor: pointer;">${t("pickModel")}</button>
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
		jsonSummary.textContent = t("jsonPreview");
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
		installBtn.textContent = t("installBtn");
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
			const okToInstall = window.confirm(t("installConfirm"));
			if (!okToInstall) return;
			installBtn.disabled = true;
			installBtn.textContent = t("installing");
			const res = await postAction("install", { confirm: "install" });
			if (res.ok) {
				alert(t("installDone"));
				close();
			} else {
				alert(t("installFailed", { error: res.error || t("unknownError") }));
				installBtn.disabled = false;
				installBtn.textContent = t("installBtn");
			}
		};
		btnRow.appendChild(installBtn);
	}

	if (!hasConfig && !isInstalled) {
		const enableBtn = document.createElement("button");
		enableBtn.textContent = t("enableBtn");
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
			enableBtn.textContent = t("writingConfig");
			const res = await postAction("write_config");
			if (res.ok) {
				alert(t("writeDone"));
				close();
			} else {
				alert(t("writeFailed", { error: res.error || t("unknownError") }));
				enableBtn.disabled = false;
				enableBtn.textContent = t("enableBtn");
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
		resetBtn.textContent = t("resetBtn");
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
			if (!window.confirm(t("resetConfirm"))) return;
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
					saveStatusText.textContent = t("resetDone");
					setTimeout(() => {
						saveStatusText.textContent = "";
					}, 4000);
				} else {
					alert(t("resetFailed", { error: res.error || t("unknownError") }));
				}
			} catch (err) {
				alert(t("resetError", { error: err?.message || String(err) }));
			} finally {
				resetBtn.disabled = false;
			}
		};
		footerBtns.appendChild(resetBtn);

		const saveBtn = document.createElement("button");
		saveBtn.textContent = t("saveBtn");
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
			saveBtn.textContent = t("saving");
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
					saveStatusText.textContent = t("saveDone");
					setTimeout(() => {
						saveStatusText.textContent = "";
					}, 4000);
				} else {
					if (String(res.error || "").includes("unknown action")) {
						saveStatusText.textContent = t("serverRestart");
						alert(t("serverRestartAlert"));
					} else {
						alert(t("saveFailed", { error: res.error || t("unknownError") }));
					}
				}
			} catch (err) {
				alert(t("saveError", { error: err?.message || String(err) }));
			} finally {
				saveBtn.disabled = false;
				saveBtn.textContent = t("saveBtn");
			}
		};
		footerBtns.appendChild(saveBtn);
	}

	const closeBtn = document.createElement("button");
	closeBtn.textContent = t("close");
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
			let content = t("defaultContent");
			if (tip) {
				// 过滤条件对齐服务端生成的底栏 tooltip 文案（服务端文案非本次范围的 UI 字典）
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
