/**
 * wechat-ilink 客户端视图 —— 状态/扫码/配对/收件箱/手动发送/根目录联动。
 * 约定同 demo-mailbox：mount(container, ctx) → cleanup；ctx.send 上行，ctx.onData 订阅。
 *
 * 二维码是本地生成的：官方 `qrcode_img_content` 是个 JS 跳转页（非图片，
 * 且 X-Frame-Options 禁止 framing），扫的内容就是该 URL 本身（与官方 CLI
 * 用 qrcode-terminal 渲染的一致），编码器是自带的 vendor/qrcode.js（MIT）。
 */

const ACTION_SET_WORKSPACE = "wechat-ilink:set-workspace";

/** 当前挂载面板的上行发送器（null = 面板尚未挂载）。 */
let panelSendSink = null;
/** 面板尚未挂载时由右键菜单触发的待应用根目录。 */
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
	} catch {
		/* 忽略旧宿主桥 */
	}
});

/** 按需加载二维码编码器（与服务端版本解耦：缺失时只显示官方链接）。 */
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

function esc(s) {
	return String(s ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
}

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
			background: var(--accent, #7c5cff); color: #fff; border: 0;
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
			<button data-ref="ws-save">设为根目录</button>
			<button class="ghost" data-ref="ws-use-cwd">设为当前项目</button>
			<button class="ghost" data-ref="ws-open-project">把项目改为此根目录</button>
			<button class="ghost" data-ref="ws-clear">清空固定</button>
		</div>
	</section>
	<section data-ref="sec-login"><h3>登录</h3><div data-ref="login"></div></section>
	<section data-ref="sec-pair" style="display:none"><h3>待配对</h3><ul data-ref="pending"></ul></section>
	<section><h3>收件箱</h3><ul data-ref="inbox"><li style="opacity:.5">暂无消息</li></ul></section>
	<section><h3>手动发送</h3>
		<div class="row">
			<input data-ref="to" placeholder="微信用户 ID" style="flex:1;min-width:140px" />
			<input data-ref="text" placeholder="文本内容" style="flex:2;min-width:180px" />
			<button data-ref="send">发送</button>
		</div>
		<div class="err" data-ref="err" style="margin-top:6px"></div>
	</section>
</div>`;

		const $ = (k) => container.querySelector(`[data-ref="${k}"]`);
		const pill = $("pill"),
			wsStatusEl = $("ws-status"),
			wsInputEl = $("ws-input"),
			wsUseCwdBtn = $("ws-use-cwd"),
			wsOpenProjBtn = $("ws-open-project"),
			wsClearBtn = $("ws-clear"),
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
			} catch {
				/* 忽略 */
			}
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
<li><div class="meta"><b>${m.dir === "in" ? "←" : "→"} ${esc(m.peer)}</b><span>${esc(timeStr(m.at))}</span></div>
<div style="white-space:pre-wrap">${esc(m.text)}</div></li>`,
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
		$("send").addEventListener("click", () => {
			errEl.textContent = "";
			ctx.send({ action: "send", peer: $("to").value.trim(), text: $("text").value.trim() });
			$("text").value = "";
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
