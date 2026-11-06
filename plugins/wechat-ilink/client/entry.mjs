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
	<h2>💬 微信通道 <span class="pill off" data-ref="pill">未连接</span></h2>
	<p class="hint">扫码登录后，微信里直接指挥 agent（出站长轮询，无需公网）。陌生人先配对，白名单在 ⚙ 设置里。</p>
	<section data-ref="sec-workspace">
		<h3>工作空间根目录（项目）</h3>
		<div class="ws-status" data-ref="ws-status">读取中…</div>
		<div class="row">
			<input data-ref="ws-input" placeholder="留空 = 跟随当前网页项目根目录" style="flex:1;min-width:220px" />
			<select data-ref="ws-select" style="min-width:140px;background:var(--bg-elev,#16161d);color:inherit;border:1px solid var(--border,#333);border-radius:6px;padding:6px 8px;font:inherit;">
				<option value="">快速点选已有项目…</option>
			</select>
			<button class="ghost" data-ref="ws-browse">📂 浏览目录…</button>
			<button data-ref="ws-save">设为根目录</button>
			<button class="ghost" data-ref="ws-use-cwd">设为当前项目</button>
			<button class="ghost" data-ref="ws-open-project">把项目改为此根目录</button>
			<button class="ghost" data-ref="ws-clear">清空固定</button>
		</div>
	</section>
	<section data-ref="sec-model">
		<h3>AI 模型与思考强度</h3>
		<div class="row">
			<input data-ref="model-input" placeholder="留空 = 跟随全局默认模型（支持输入或选择）" style="flex:2;min-width:180px" />
			<button class="ghost" data-ref="model-browse">✨ 选择模型…</button>
			<select data-ref="thinking-select" style="min-width:120px;background:var(--bg-elev,#16161d);color:inherit;border:1px solid var(--border,#333);border-radius:6px;padding:6px 8px;font:inherit;">
				<option value="">思考强度：跟随全局</option>
				<option value="off">思考：关闭 (off)</option>
				<option value="low">思考：低 (low)</option>
				<option value="medium">思考：中 (medium)</option>
				<option value="high">思考：高 (high)</option>
				<option value="max">思考：最大 (max)</option>
			</select>
			<button data-ref="model-save">保存配置</button>
			<button class="ghost" data-ref="model-clear">恢复默认</button>
		</div>
		<div style="margin-top:8px">
			<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;opacity:.9">
				<input type="checkbox" data-ref="bind-active-check" />
				<span>💻📱 电脑手机消息同步：投递到网页当前打开的对话（大屏实时看流式思考与工具输出）</span>
			</label>
		</div>
	</section>
	<section data-ref="sec-login"><h3>登录</h3><div data-ref="login"></div></section>
	<section data-ref="sec-pair" style="display:none"><h3>待配对</h3><ul data-ref="pending"></ul></section>
	<section><h3>收件箱</h3><ul data-ref="inbox"><li style="opacity:.5">暂无消息</li></ul></section>
	<section><h3>手动发送</h3>
		<div class="row">
			<input data-ref="to" placeholder="微信用户 ID" style="flex:1;min-width:140px" />
			<input data-ref="text" placeholder="文本内容" style="flex:2;min-width:180px" />
			<input data-ref="media" placeholder="图片/文件路径或 URL（可选）" style="flex:2;min-width:180px" />
			<button data-ref="send">发送</button>
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
				const options = [{ label: "选择最近项目…", value: "" }];
				if (hostCwd) {
					const name =
						hostCwd
							.replace(/[\\/]+$/, "")
							.split(/[\\/]/)
							.pop() || hostCwd;
					options.push({ label: `当前网页项目：${name} (${hostCwd})`, value: hostCwd });
				}
				if (ws && ws !== hostCwd) {
					const name =
						ws
							.replace(/[\\/]+$/, "")
							.split(/[\\/]/)
							.pop() || ws;
					options.push({ label: `已固定根目录：${name} (${ws})`, value: ws });
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
						? ` <span style="opacity:.7">（当前网页项目：<code>${esc(hostCwd)}</code>）</span>`
						: "";
				wsStatusEl.innerHTML = `已固定微信根目录：<code>${esc(ws)}</code>${diffNote}`;
			} else {
				wsStatusEl.innerHTML = `未固定（默认跟随当前网页项目${hostCwd ? `：<code>${esc(hostCwd)}</code>` : ""}）`;
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
				? `已登录${s.botId ? ` · ${s.botId}` : ""}${s.polling ? " · 接收中" : ""}${s.paused ? " · 受限暂停" : ""}`
				: "未连接";
			pill.className = `pill ${s.loggedIn ? "on" : "off"}`;
			if (s.loggedIn) {
				loginEl.innerHTML = `<div class="row"><span style="opacity:.7">上次登录：${esc(timeStr(s.loginAt))}</span>
					<button class="ghost" data-act="logout">登出</button></div>
					${s.lastError ? `<div class="err">轮询：${esc(s.lastError)}</div>` : ""}`;
			} else if (s.qr) {
				const url = String(s.qr.image ?? s.qr.qrcode ?? "");
				loginEl.innerHTML = `<div class="qr"><div data-qr="1">生成二维码中…</div>
					<p style="opacity:.7">微信扫码确认登录（5 分钟有效，过期后重新点“扫码登录”）</p>
					<p style="opacity:.7">扫不上？<a href="${esc(url)}" target="_blank" rel="noopener">在新标签页打开官方扫码页</a></p>
					<div class="row"><button class="ghost" data-act="cancel">取消</button></div></div>`;
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
				loginEl.innerHTML = `<div class="row"><button data-act="login">扫码登录</button></div>`;
			}
			pendingSec.style.display = (s.pendingPeers ?? []).length ? "" : "none";
			pendingEl.innerHTML = (s.pendingPeers ?? [])
				.map(
					(p) => `
<li><div class="row"><b>${esc(p)}</b>
<button data-act="allow" data-peer="${esc(p)}">允许</button>
<button class="ghost" data-act="deny" data-peer="${esc(p)}">拒绝</button></div></li>`,
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
		<button class="ghost" data-act="open-session" style="padding:1px 8px;font-size:11px;margin-left:auto;height:22px;min-height:unset">在主界面打开对话流</button>
	</div>
	<div style="white-space:pre-wrap">${esc(m.text)}</div>
</li>`,
						)
						.join("")
				: `<li style="opacity:.5">暂无消息</li>`;
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
