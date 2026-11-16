const ACTION_SET_WORKSPACE = "wechat-ilink:set-workspace";

let panelSendSink = null;
let pendingWorkspace = null;

function requestSetWorkspace(path) {
	const clean = String(path ?? "").trim();
	if (!clean) return;
	if (panelSendSink) {
		panelSendSink({ action: "set_workspace", workspace: clean });
		return;
	}
	pendingWorkspace = clean;
}

function onSetWorkspaceAction(_itemId, _value, target) {
	const path = target?.id !== undefined && target?.id !== null ? String(target.id).trim() : "";
	if (!path) return;
	requestSetWorkspace(path);
}

function whenBridge(fn, tries = 40) {
	const bridge = globalThis.window?.__piWebUiHost;
	if (bridge && typeof bridge === "object") {
		fn(bridge);
		return;
	}
	if (tries <= 0) return;
	setTimeout(() => whenBridge(fn, tries - 1), 250);
}

whenBridge((bridge) => {
	try {
		bridge.onUiAction?.(ACTION_SET_WORKSPACE, onSetWorkspaceAction);
	} catch {}
});

let qrFactoryPromise = null;
function loadQrFactory() {
	if (!qrFactoryPromise) {
		qrFactoryPromise = import("./vendor/qrcode.js?v=1").then(
			(m) => m.default,
			() => null,
		);
	}
	return qrFactoryPromise;
}

import { esc } from "@pi-web-ui/plugin-sdk/client";
import { makeT } from "./i18n.mjs";

/** 面板文案：语言解析 / 回退 / 插值都在 SDK 里，这里只按当前界面语言取词。 */
const t = makeT();

function timeStr(at) {
	try {
		return new Date(at).toLocaleString();
	} catch {
		return "";
	}
}

export default {
	mount(container, ctx) {
		container.innerHTML = `
<div class="wx">
	<style>
		.wx { max-width: 760px; margin: 0 auto; font-size: 13px; }
		.wx h2 { margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }
		.wx .hint { opacity: .6; margin: 0 0 12px; }
		.wx .pill { display: inline-block; border-radius: 999px; padding: 2px 10px; font-size: 12px; border: 1px solid var(--border, #333); }
		.wx .pill.on { background: #1d5c2e; border-color: #1d5c2e; color: #fff; }
		.wx .pill.off { opacity: .7; }
		.wx section { border: 1px solid var(--border, #333); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
		.wx section h3 { margin: 0 0 8px; font-size: 13px; }
		.wx ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
		.wx li { border: 1px solid var(--border, #333); border-radius: 6px; padding: 6px 8px; }
		.wx .meta { display: flex; gap: 8px; opacity: .65; font-size: 12px; margin-bottom: 2px; flex-wrap: wrap; }
		.wx .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
		.wx .ws-status { font-size: 12px; opacity: .82; margin-bottom: 8px; word-break: break-all; }
		.wx .ws-status code { background: var(--bg-elev, #16161d); padding: 1px 6px; border-radius: 4px; }
		.wx input {
			background: var(--bg-elev, #16161d); color: inherit;
			border: 1px solid var(--border, #333); border-radius: 6px; padding: 6px 8px; font: inherit;
		}
		.wx button {
			background: var(--accent, #7c5cff); color: var(--accent-contrast, #fff); border: 0;
			border-radius: 6px; padding: 6px 14px; cursor: pointer; font: inherit;
		}
		.wx button.ghost { background: transparent; border: 1px solid var(--border, #333); color: inherit; }
		.wx button.danger { background: #8c2f2f; }
		.wx button:disabled { opacity: .45; cursor: not-allowed; }
		.wx .qr img { max-width: 220px; border-radius: 8px; background: #fff; }
		.wx .qr svg { width: 220px; height: auto; background: #fff; border-radius: 8px; }
		.wx .qr a { word-break: break-all; }
		.wx .qr pre { white-space: pre-wrap; word-break: break-all; font-size: 11px; opacity: .8; }
		.wx .err { color: #ff8080; }
		@media (max-width: 640px) {
			.wx input { font-size: 16px; }
			.wx button { min-height: 40px; }
		}
	</style>
	<h2>${t("title")} <span class="pill off" data-ref="pill">${t("statusDisconnected")}</span></h2>
	<p class="hint">${t("hint")}</p>
	<section data-ref="sec-workspace">
		<h3>${t("wsTitle")}</h3>
		<div class="ws-status" data-ref="ws-status">${t("reading")}</div>
		<div class="row">
			<input data-ref="ws-input" placeholder="${t("wsInputPlaceholder")}" style="flex:1;min-width:220px" />
			<select data-ref="ws-select" style="min-width:140px;background:var(--bg-elev,#16161d);color:inherit;border:1px solid var(--border,#333);border-radius:6px;padding:6px 8px;font:inherit;">
				<option value="">${t("wsQuickPick")}</option>
			</select>
			<button class="ghost" data-ref="ws-browse">${t("wsBrowse")}</button>
			<button data-ref="ws-save">${t("wsSave")}</button>
			<button class="ghost" data-ref="ws-use-cwd">${t("wsUseCwd")}</button>
			<button class="ghost" data-ref="ws-open-project">${t("wsOpenProject")}</button>
			<button class="ghost" data-ref="ws-clear">${t("wsClear")}</button>
		</div>
	</section>
	<section data-ref="sec-model">
		<h3>${t("modelTitle")}</h3>
		<div class="row">
			<input data-ref="model-input" placeholder="${t("modelInputPlaceholder")}" style="flex:2;min-width:180px" />
			<button class="ghost" data-ref="model-browse">${t("modelBrowse")}</button>
			<select data-ref="thinking-select" style="min-width:120px;background:var(--bg-elev,#16161d);color:inherit;border:1px solid var(--border,#333);border-radius:6px;padding:6px 8px;font:inherit;">
				<option value="">${t("thinkingFollowGlobal")}</option>
				<option value="off">${t("thinkingOff")}</option>
				<option value="low">${t("thinkingLow")}</option>
				<option value="medium">${t("thinkingMedium")}</option>
				<option value="high">${t("thinkingHigh")}</option>
				<option value="max">${t("thinkingMax")}</option>
			</select>
			<button data-ref="model-save">${t("modelSave")}</button>
			<button class="ghost" data-ref="model-clear">${t("modelClear")}</button>
		</div>
		<div style="margin-top:8px">
			<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;opacity:.9">
				<input type="checkbox" data-ref="bind-active-check" />
				<span>${t("bindActive")}</span>
			</label>
		</div>
	</section>
	<section data-ref="sec-login"><h3>${t("loginSection")}</h3><div data-ref="login"></div></section>
	<section data-ref="sec-pair" style="display:none"><h3>${t("pendingSection")}</h3><ul data-ref="pending"></ul></section>
	<section><h3>${t("inboxSection")}</h3><ul data-ref="inbox"><li style="opacity:.5">${t("inboxEmpty")}</li></ul></section>
	<section><h3>${t("sendSection")}</h3>
		<div class="row">
			<input data-ref="to" placeholder="${t("toPlaceholder")}" style="flex:1;min-width:140px" />
			<input data-ref="text" placeholder="${t("textPlaceholder")}" style="flex:2;min-width:180px" />
			<input data-ref="media" placeholder="${t("mediaPlaceholder")}" style="flex:2;min-width:180px" />
			<button data-ref="send">${t("sendBtn")}</button>
		</div>
		<div class="err" data-ref="err" style="margin-top:6px"></div>
	</section>
</div>`;

		const $ = (k) => container.querySelector(`[data-ref="${k}"]`);
		const pill = $("pill"),
			wsStatusEl = $("ws-status"),
			wsInputEl = $("ws-input"),
			wsSelectEl = $("ws-select"),
			wsUseCwdBtn = $("ws-use-cwd"),
			wsOpenProjBtn = $("ws-open-project"),
			wsClearBtn = $("ws-clear"),
			modelInputEl = $("model-input"),
			thinkingSelectEl = $("thinking-select"),
			modelSaveBtn = $("model-save"),
			modelClearBtn = $("model-clear"),
			bindActiveCheckEl = $("bind-active-check"),
			loginEl = $("login"),
			pendingSec = $("sec-pair"),
			pendingEl = $("pending"),
			inboxEl = $("inbox"),
			errEl = $("err");
		let lastInbox = [];
		let currentWorkspace = "";
		let currentHostCwd = "";

		panelSendSink = (payload) => ctx.send(payload);
		whenBridge((bridge) => {
			try {
				bridge.onUiAction?.(ACTION_SET_WORKSPACE, onSetWorkspaceAction);
			} catch {}
		});
		if (pendingWorkspace) {
			const next = pendingWorkspace;
			pendingWorkspace = null;
			ctx.send({ action: "set_workspace", workspace: next });
		}

		function renderWorkspace(s) {
			const ws = String(s.workspace ?? "").trim();
			const hostCwd = String(s.hostCwd ?? "").trim();
			currentWorkspace = ws;
			currentHostCwd = hostCwd;
			if (document.activeElement !== wsInputEl) {
				wsInputEl.value = ws;
			}

			if (wsSelectEl) {
				const currentVal = wsSelectEl.value;
				const options = [{ label: t("wsOptionRecent"), value: "" }];
				if (hostCwd) {
					const name =
						hostCwd
							.replace(/[\\/]+$/, "")
							.split(/[\\/]/)
							.pop() || hostCwd;
					options.push({ label: t("wsOptionHostProject", { name, path: hostCwd }), value: hostCwd });
				}
				if (ws && ws !== hostCwd) {
					const name =
						ws
							.replace(/[\\/]+$/, "")
							.split(/[\\/]/)
							.pop() || ws;
					options.push({ label: t("wsOptionPinned", { name, path: ws }), value: ws });
				}
				try {
					const hostProjects = globalThis.window?.__piWebUiHost?.listProjects?.() ?? [];
					for (const p of hostProjects) {
						if (p && !options.some((o) => o.value === p)) {
							const name =
								p
									.replace(/[\\/]+$/, "")
									.split(/[\\/]/)
									.pop() || p;
							options.push({ label: `${name} (${p})`, value: p });
						}
					}
				} catch {}
				wsSelectEl.innerHTML = options
					.map((opt) => `<option value="${esc(opt.value)}">${esc(opt.label)}</option>`)
					.join("");
				if (currentVal && options.some((o) => o.value === currentVal)) {
					wsSelectEl.value = currentVal;
				}
			}

			if (ws) {
				const diffNote =
					hostCwd && hostCwd !== ws
						? ` <span style="opacity:.7">${t("wsPinnedDiff", { path: `<code>${esc(hostCwd)}</code>` })}</span>`
						: "";
				wsStatusEl.innerHTML = `${t("wsPinned", { path: `<code>${esc(ws)}</code>` })}${diffNote}`;
			} else {
				wsStatusEl.innerHTML = hostCwd
					? t("wsUnpinnedWithHost", { path: `<code>${esc(hostCwd)}</code>` })
					: t("wsUnpinned");
			}
			if (wsUseCwdBtn) {
				wsUseCwdBtn.disabled = !hostCwd || ws === hostCwd;
			}
			if (wsOpenProjBtn) {
				wsOpenProjBtn.disabled = !ws || ws === hostCwd;
			}
			if (wsClearBtn) {
				wsClearBtn.disabled = !ws;
			}
		}

		function renderState(s) {
			if (!s || s.kind !== "state") return;
			renderWorkspace(s);

			if (modelInputEl && document.activeElement !== modelInputEl) {
				modelInputEl.value = s.model || "";
			}
			if (thinkingSelectEl) {
				thinkingSelectEl.value = s.thinkingLevel || "";
			}
			if (bindActiveCheckEl) {
				bindActiveCheckEl.checked = s.bindActive === true;
			}

			pill.textContent = s.loggedIn
				? `${t("statusLoggedIn")}${s.botId ? ` · ${s.botId}` : ""}${s.polling ? t("statusReceiving") : ""}${s.paused ? t("statusPaused") : ""}`
				: t("statusDisconnected");
			pill.className = `pill ${s.loggedIn ? "on" : "off"}`;
			if (s.loggedIn) {
				loginEl.innerHTML = `<div class="row"><span style="opacity:.7">${t("lastLogin", { time: esc(timeStr(s.loginAt)) })}</span>
					<button class="ghost" data-act="logout">${t("logout")}</button></div>
					${s.lastError ? `<div class="err">${t("pollError", { error: esc(s.lastError) })}</div>` : ""}`;
			} else if (s.qr) {
				const url = String(s.qr.image ?? s.qr.qrcode ?? "");
				loginEl.innerHTML = `<div class="qr"><div data-qr="1">${t("qrGenerating")}</div>
					<p style="opacity:.7">${t("qrHint")}</p>
					<p style="opacity:.7">${t("qrCantScan")}<a href="${esc(url)}" target="_blank" rel="noopener">${t("qrOpenOfficial")}</a></p>
					<div class="row"><button class="ghost" data-act="cancel">${t("cancel")}</button></div></div>`;
				const slot = loginEl.querySelector('[data-qr="1"]');
				if (url && slot) {
					loadQrFactory().then((factory) => {
						if (!slot.isConnected) return;
						try {
							if (!factory) throw new Error("no encoder");
							const qr = factory(0, "M");
							qr.addData(url);
							qr.make();
							slot.innerHTML = qr.createSvgTag(5, 1);
						} catch {
							slot.innerHTML = `<pre>${esc(url)}</pre>`;
						}
					});
				}
			} else {
				loginEl.innerHTML = `<div class="row"><button data-act="login">${t("loginBtn")}</button></div>`;
			}
			pendingSec.style.display = (s.pendingPeers ?? []).length ? "" : "none";
			pendingEl.innerHTML = (s.pendingPeers ?? [])
				.map(
					(p) => `
<li><div class="row"><b>${esc(p)}</b>
<button data-act="allow" data-peer="${esc(p)}">${t("allow")}</button>
<button class="ghost" data-act="deny" data-peer="${esc(p)}">${t("deny")}</button></div></li>`,
				)
				.join("");
			renderInbox(s.inbox ?? []);
		}

		function renderInbox(items) {
			lastInbox = items;
			inboxEl.innerHTML = items.length
				? items
						.slice()
						.reverse()
						.map(
							(m) => `
<li>
	<div class="meta">
		<b>${m.dir === "in" ? "←" : "→"} ${esc(m.peer)}</b>
		<span>${esc(timeStr(m.at))}</span>
		<button class="ghost" data-act="open-session" style="padding:1px 8px;font-size:11px;margin-left:auto;height:22px;min-height:unset">${t("openSession")}</button>
	</div>
	<div style="white-space:pre-wrap">${esc(m.text)}</div>
</li>`,
						)
						.join("")
				: `<li style="opacity:.5">${t("inboxEmpty")}</li>`;
		}

		container.addEventListener("click", (e) => {
			const btn = e.target.closest("[data-act]");
			if (!btn) return;
			const act = btn.dataset.act;
			if (act === "login") ctx.send({ action: "login" });
			else if (act === "cancel") ctx.send({ action: "login_cancel" });
			else if (act === "logout") ctx.send({ action: "logout" });
			else if (act === "allow") ctx.send({ action: "allow", peer: btn.dataset.peer });
			else if (act === "deny") ctx.send({ action: "deny", peer: btn.dataset.peer });
			else if (act === "open-session") {
				const target = currentWorkspace || currentHostCwd;
				if (target) {
					void globalThis.window?.__piWebUiHost?.openSession?.({ cwd: target, newChat: false });
				}
			}
		});
		$("ws-save").addEventListener("click", () => {
			ctx.send({ action: "set_workspace", workspace: wsInputEl.value.trim() });
		});
		wsInputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				ctx.send({ action: "set_workspace", workspace: wsInputEl.value.trim() });
			}
		});
		wsUseCwdBtn.addEventListener("click", () => {
			if (!currentHostCwd) return;
			wsInputEl.value = currentHostCwd;
			ctx.send({ action: "set_workspace", workspace: currentHostCwd });
		});
		wsOpenProjBtn.addEventListener("click", () => {
			const target = wsInputEl.value.trim() || currentWorkspace;
			if (!target) return;
			void globalThis.window?.__piWebUiHost?.openSession?.({ cwd: target, newChat: false });
		});
		wsClearBtn.addEventListener("click", () => {
			wsInputEl.value = "";
			ctx.send({ action: "set_workspace", workspace: "" });
		});
		if (wsSelectEl) {
			wsSelectEl.addEventListener("focus", () => {
				renderWorkspace({ workspace: currentWorkspace, hostCwd: currentHostCwd });
			});
			wsSelectEl.addEventListener("change", () => {
				const val = wsSelectEl.value.trim();
				if (!val) return;
				wsInputEl.value = val;
				ctx.send({ action: "set_workspace", workspace: val });
			});
		}
		const wsBrowseBtn = $("ws-browse");
		if (wsBrowseBtn) {
			wsBrowseBtn.addEventListener("click", async () => {
				const host = globalThis.window?.__piWebUiHost;
				if (typeof host?.pickDirectory !== "function") return;
				const res = await host.pickDirectory({
					initialPath: wsInputEl.value.trim() || currentWorkspace || currentHostCwd,
				});
				if (res?.ok && res.path) {
					wsInputEl.value = res.path;
					ctx.send({ action: "set_workspace", workspace: res.path });
				}
			});
		}
		const modelBrowseBtn = $("model-browse");
		if (modelBrowseBtn) {
			modelBrowseBtn.addEventListener("click", async () => {
				const host = globalThis.window?.__piWebUiHost;
				if (typeof host?.pickModel !== "function") return;
				const res = await host.pickModel({
					currentModelId: modelInputEl?.value?.trim() || undefined,
				});
				if (res?.ok && res.modelId) {
					if (modelInputEl) modelInputEl.value = res.modelId;
					ctx.send({
						action: "set_model",
						model: res.modelId,
						thinkingLevel: thinkingSelectEl?.value ?? "",
					});
				}
			});
		}
		if (modelSaveBtn) {
			modelSaveBtn.addEventListener("click", () => {
				ctx.send({
					action: "set_model",
					model: modelInputEl?.value?.trim() ?? "",
					thinkingLevel: thinkingSelectEl?.value ?? "",
				});
			});
		}
		if (modelClearBtn) {
			modelClearBtn.addEventListener("click", () => {
				if (modelInputEl) modelInputEl.value = "";
				if (thinkingSelectEl) thinkingSelectEl.value = "";
				ctx.send({ action: "set_model", model: "", thinkingLevel: "" });
			});
		}
		if (bindActiveCheckEl) {
			bindActiveCheckEl.addEventListener("change", () => {
				ctx.send({ action: "set_bind_active", bindActive: bindActiveCheckEl.checked });
			});
		}
		$("send").addEventListener("click", () => {
			errEl.textContent = "";
			ctx.send({
				action: "send",
				peer: $("to").value.trim(),
				text: $("text").value.trim(),
				media: $("media").value.trim(),
			});
			$("text").value = "";
			$("media").value = "";
		});

		const off = ctx.onData((p) => {
			if (!p || typeof p !== "object") return;
			if (p.kind === "state") renderState(p);
			else if (p.kind === "inbox" && p.entry) renderInbox([...lastInbox, p.entry].slice(-30));
			else if (p.kind === "error") errEl.textContent = String(p.error ?? "");
		});
		ctx.send({ action: "state" });

		return () => {
			if (panelSendSink) panelSendSink = null;
			off();
			container.querySelector(".wx")?.remove();
		};
	},
};
