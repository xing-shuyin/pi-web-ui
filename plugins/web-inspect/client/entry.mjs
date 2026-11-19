import { defineView, esc } from "./sdk/client.mjs";
import { t } from "./i18n.mjs";

/**
 * 书签源码（__EP__/__MSK__ 构建时替换）：无依赖，Image 信标 = GET 无预检，
 * 任意站免 CORS 回传；文案按 navigator.language 中英切换。
 */
const BOOKMARKLET_SRC = `(()=>{const EP='__EP__';const MSK='__MSK__'==='1';const ZH=(navigator.language||'').toLowerCase().indexOf('zh')===0;const B=o=>{new Image().src=EP+'/collect?d='+encodeURIComponent(JSON.stringify(o)).slice(0,7000)};const css=e=>{if(e.id)return '#'+e.id;const p=[];let n=e;for(let d=0;n&&n.nodeType===1&&d<5;n=n.parentNode,d++){let s=n.tagName.toLowerCase();if(n.className&&typeof n.className==='string'){const c=n.className.trim().split(/\\s+/).slice(0,2).join('.');if(c)s+='.'+c}const sib=[... (n.parentNode?.children||[])].filter(x=>x.tagName===n.tagName);if(sib.length>1)s+=':nth-of-type('+(sib.indexOf(n)+1)+')';p.unshift(s)}return p.join('>')};const txt=e=>{if(MSK&&(e.type==='password'||e.getAttribute?.('type')==='password'))return ZH?'（已输入，已脱敏）':'(typed, masked)';return (e.innerText||e.value||e.placeholder||e.getAttribute('aria-label')||'').trim().replace(/\\s+/g,' ').slice(0,80)};const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.right>0};const els=[...document.querySelectorAll('a,button,input,select,textarea,[role=button],[onclick]')].filter(vis).slice(0,60).map((e,i)=>({i,tag:e.tagName.toLowerCase(),text:txt(e),sel:css(e),href:e.href?.slice(0,300),name:e.name,type:e.type}));B({type:'snapshot',url:location.href,title:document.title,count:els.length,elements:els});if(!window.__WI_LOGGED){window.__WI_LOGGED=1;for(const[ev,fn]of[['click',e=>txt(e.target)],['input',e=>e.target.name||e.target.placeholder||txt(e.target)],['submit',e=>txt(e.target)],['change',e=>e.target.name||txt(e.target)]])document.addEventListener(ev,e=>{const tgt=e.target.closest('a,button,input,select,textarea,[role=button]');B({type:'event',ev,url:location.href,text:fn(e).slice(0,120),sel:tgt?css(tgt):''})},true)}if(window.__WI_PICK)return;window.__WI_PICK=1;const box=document.createElement('div');box.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #f00;background:#f002';document.body.appendChild(box);const mv=e=>{const tgt=e.target.closest('a,button,input,select,textarea,[role=button],div,span,li,td,h1,h2,h3,p');if(!tgt)return;window.__WI_T=tgt;const r=tgt.getBoundingClientRect();Object.assign(box.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'})};const done=e=>{if(e.key==='Escape'){cleanup()}};const pick=e=>{e.preventDefault();e.stopPropagation();const tgt=window.__WI_T||e.target;const md='['+tgt.tagName.toLowerCase()+'] '+txt(tgt)+'\\n sel: '+css(tgt)+'\\n @ '+location.href;B({type:'pick',url:location.href,tag:tgt.tagName.toLowerCase(),text:txt(tgt),sel:css(tgt),path:css(tgt)});try{navigator.clipboard.writeText(md)}catch{}cleanup();alert((ZH?'已回传 pi-web-ui ✅\\n':'Sent back to pi-web-ui ✅\\n')+md)};function cleanup(){window.__WI_PICK=0;document.removeEventListener('mousemove',mv,true);document.removeEventListener('click',pick,true);document.removeEventListener('keydown',done,true);box.remove()}document.addEventListener('mousemove',mv,true);document.addEventListener('click',pick,true);document.addEventListener('keydown',done,true);})()`;

function apiBase() {
	try {
		const u = new URL(import.meta.url);
		const i = u.pathname.indexOf("/plugins/");
		const root = i > 0 ? u.pathname.slice(0, i) : "";
		return root + "/plugins-api/web-inspect";
	} catch {
		return "/plugins-api/web-inspect";
	}
}

function mdOf(s, task) {
	const out = [];
	if (task) out.push(`${t("mdTask")}: ${task}\n`);
	out.push(`${t("mdPage")}: ${(s.page && `${s.page.title || "(untitled)"} <${s.page.url}>`) || t("mdNoSnap")}`);
	if (s.picked) out.push(`${t("mdPicked")}: [${s.picked.tag}] ${s.picked.text}\n  sel: ${s.picked.sel}`);
	if (s.steps?.length) {
		out.push(`${t("mdSteps")}:`);
		for (const st of s.steps.slice(-100)) out.push(`${st.n}. [${st.kind}] ${st.label}${st.sel ? `\n   sel: ${st.sel}` : ""}`);
	}
	return out.join("\n");
}

const CSS = `.wi{font:13px/1.6 system-ui,sans-serif;height:100%;display:flex;flex-direction:column;color:var(--text,inherit);min-height:0}.wi-bar{display:flex;gap:6px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--border,#8883)}.wi-bar input{flex:1;min-width:0;background:var(--bg-elev2,#8881);color:var(--text,inherit);border:1px solid var(--border,#8884);border-radius:6px;padding:4px 8px;font-size:12px}.wi button{border:1px solid var(--border,#8886);border-radius:7px;padding:3px 12px;background:transparent;color:var(--text,inherit);font-size:12px;cursor:pointer;white-space:nowrap}.wi button:hover{background:var(--accent-soft,#8882)}.wi button.primary{color:var(--accent-contrast,#fff);background:var(--accent,#4a7dff);border-color:var(--accent,#4a7dff)}.wi-main{flex:1;display:flex;min-height:0}.wi-browser{flex:1;min-width:0;display:flex;flex-direction:column}.wi-browser iframe{flex:1;width:100%;border:0;background:#fff}.wi-framed{font-size:11px;color:var(--text-dim,#999);padding:2px 10px}.wi-grip{flex:none;width:8px;cursor:col-resize;background:transparent}.wi-grip:hover,.wi-grip.on{background:var(--accent-soft,#8883)}.wi-side{flex:none;overflow-y:auto;padding:10px;border-left:1px solid var(--border,#8883);display:flex;flex-direction:column;gap:8px}.wi .dim{color:var(--text-dim,#999);font-size:11.5px}.wi .card{border:1px solid var(--border,#8884);border-radius:10px;padding:8px 10px;background:var(--bg-elev,transparent)}.wi ol.steps{margin:6px 0;padding-left:20px;font-size:12px;max-height:260px;overflow-y:auto}.wi ol.steps li{margin:2px 0}.wi code{font-size:11px;word-break:break-all}.wi textarea{width:100%;box-sizing:border-box;background:var(--bg-elev2,#8881);color:var(--text,inherit);border:1px solid var(--border,#8884);border-radius:6px;padding:5px 8px;font-size:12px;resize:vertical}.wi a.bm{display:inline-block;margin:4px 0;padding:4px 12px;border:1px dashed var(--accent,#4a7dff);border-radius:8px;text-decoration:none;color:var(--accent,#4a7dff);font-size:12px}.wi-flash{font-size:12px;color:var(--accent,#4a7dff)}.wi pre{white-space:pre-wrap;font-size:11px;max-height:160px;overflow:auto;background:var(--bg-elev2,#8881);border-radius:6px;padding:6px 8px}`;

function cssPath(e) {
	if (e.id) return "#" + e.id;
	const p = [];
	let n = e;
	for (let d = 0; n && n.nodeType === 1 && d < 5; n = n.parentNode, d++) {
		let s = n.tagName.toLowerCase();
		if (n.className && typeof n.className === "string") {
			const c = n.className.trim().split(/\s+/).slice(0, 2).join(".");
			if (c) s += "." + c;
		}
		const sib = [...(n.parentNode?.children || [])].filter((x) => x.tagName === n.tagName);
		if (sib.length > 1) s += ":nth-of-type(" + (sib.indexOf(n) + 1) + ")";
		p.unshift(s);
	}
	return p.join(">");
}

function elText(e, masked) {
	if (masked && (e.type === "password" || e.getAttribute?.("type") === "password")) return t("masked");
	return ((e.innerText || e.value || e.placeholder || e.getAttribute("aria-label") || "") + "").trim().replace(/\s+/g, " ").slice(0, 80);
}

export default defineView({
	mount(el, ctx) {
		const API = apiBase();
		let state = { page: null, snapshot: null, picked: null, log: [], steps: [] };
		let settings = { sidebarWidth: 320, maskPasswords: true, autoSnapshot: true, maxSteps: 100 };
		let sideW = Number(localStorage.getItem("web-inspect:sideW")) || settings.sidebarWidth;
		let browserUrl = "";
		let pickArmed = false;
		let flash = "";

		const root = document.createElement("div");
		root.className = "wi";
		const style = document.createElement("style");
		style.textContent = CSS;
		root.appendChild(style);
		el.appendChild(root);

		const sameDoc = () => {
			try {
				const doc = frame?.contentDocument;
				if (doc && doc.documentElement) return doc;
			} catch {}
			return null;
		};

		const sendStep = (step) => ctx.send({ action: "step", step });

		const collectSnapshot = (doc, url) => {
			const vis = (e) => {
				const r = e.getBoundingClientRect();
				return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0;
			};
			const els = [...doc.querySelectorAll("a,button,input,select,textarea,[role=button],[onclick]")]
				.filter(vis)
				.slice(0, 60)
				.map((e, i) => ({
					i,
					tag: e.tagName.toLowerCase(),
					text: elText(e, settings.maskPasswords),
					sel: cssPath(e),
					href: e.href?.slice(0, 300),
					name: e.name,
					type: e.type,
				}));
			return { type: "snapshot", url, title: doc.title, count: els.length, elements: els };
		};

		const postCollect = async (obj) => {
			try {
				const r = await fetch(`${API}/collect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
				if (r.ok) refresh();
			} catch {}
		};

		let frame;
		let pickCleanup = null;

		const armPick = () => {
			disarmPick();
			const doc = sameDoc();
			if (!doc) {
				flash = t("xorigin");
				render();
				return;
			}
			pickArmed = true;
			const box = doc.createElement("div");
			box.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #f00;background:#f002";
			doc.body.appendChild(box);
			const mv = (e) => {
				const tgt = e.target.closest("a,button,input,select,textarea,[role=button],div,span,li,td,h1,h2,h3,p");
				if (!tgt) return;
				window.__WI_T = tgt;
				const r = tgt.getBoundingClientRect();
				Object.assign(box.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
			};
			const done = (e) => {
				if (e.key === "Escape") disarmPick();
			};
			const pick = (e) => {
				e.preventDefault();
				e.stopPropagation();
				const tgt = window.__WI_T || e.target;
				disarmPick();
				void postCollect({ type: "pick", url: browserUrl, tag: tgt.tagName.toLowerCase(), text: elText(tgt, settings.maskPasswords), sel: cssPath(tgt), path: cssPath(tgt) });
			};
			doc.addEventListener("mousemove", mv, true);
			doc.addEventListener("click", pick, true);
			doc.addEventListener("keydown", done, true);
			pickCleanup = () => {
				doc.removeEventListener("mousemove", mv, true);
				doc.removeEventListener("click", pick, true);
				doc.removeEventListener("keydown", done, true);
				box.remove();
			};
			flash = t("armed");
			render();
		};

		const disarmPick = () => {
			pickArmed = false;
			try {
				pickCleanup?.();
			} catch {}
			pickCleanup = null;
		};

		const attachFrameListeners = () => {
			const doc = sameDoc();
			if (!doc || doc.__WI_WIRED) return;
			doc.__WI_WIRED = 1;
			const sel = (e) => {
				const tgt = e.target.closest?.("a,button,input,select,textarea,[role=button]");
				return tgt ? cssPath(tgt) : "";
			};
			const val = (e) => {
				const tgt = e.target;
				if (settings.maskPasswords && (tgt.type === "password" || tgt.getAttribute?.("type") === "password")) return t("masked");
				return ((tgt.name || tgt.placeholder || tgt.innerText || "") + "").trim().replace(/\s+/g, " ").slice(0, 120);
			};
			for (const [ev] of [["click"], ["input"], ["submit"], ["change"]]) {
				doc.addEventListener(
					ev,
					(e) => sendStep({ kind: ev === "submit" ? "click" : ev === "change" ? "input" : ev, label: `${ev}: ${val(e)}`.slice(0, 140), sel: sel(e), url: browserUrl }),
					true,
				);
			}
		};

		const visit = (url) => {
			url = (url || "").trim();
			if (!url) return;
			if (!/^https?:\/\//i.test(url)) url = "https://" + url;
			browserUrl = url;
			disarmPick();
			sendStep({ kind: "visit", label: `${t("stepVisit")}: ${url}`, url });
			frame.src = url;
		};

		const render = () => {
			root.querySelectorAll(".wi-bar,.wi-main").forEach((n) => n.remove());
			const bar = document.createElement("div");
			bar.className = "wi-bar";
			bar.innerHTML = `<input data-a="url" placeholder="${esc(t("urlPh"))}" value="${esc(browserUrl)}"><button data-a="go">${esc(t("go"))}</button><button data-a="snap">${esc(t("snap"))}</button><button data-a="pick" class="${pickArmed ? "primary" : ""}">${esc(t("pick"))}</button>`;
			const main = document.createElement("div");
			main.className = "wi-main";
			main.innerHTML = `<div class="wi-browser"></div><div class="wi-grip" title="⇔"></div><div class="wi-side" style="width:${sideW}px"></div>`;
			root.append(bar, main);

			const browserPane = main.querySelector(".wi-browser");
			if (!frame) {
				frame = document.createElement("iframe");
				frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
				frame.addEventListener("load", () => {
					attachFrameListeners();
					if (settings.autoSnapshot) {
						const doc = sameDoc();
						if (doc && browserUrl) void postCollect(collectSnapshot(doc, browserUrl));
					}
				});
			}
			const hint = document.createElement("div");
			hint.className = "wi-framed";
			hint.textContent = t("framedHint");
			browserPane.append(frame, hint);

			const grip = main.querySelector(".wi-grip");
			grip.addEventListener("mousedown", (e) => {
				e.preventDefault();
				grip.classList.add("on");
				const x0 = e.clientX;
				const w0 = sideW;
				const mv = (ev) => {
					sideW = Math.max(200, Math.min(640, w0 - (ev.clientX - x0)));
					main.querySelector(".wi-side").style.width = sideW + "px";
				};
				const up = () => {
					grip.classList.remove("on");
					window.removeEventListener("mousemove", mv);
					window.removeEventListener("mouseup", up);
					try {
						localStorage.setItem("web-inspect:sideW", String(sideW));
					} catch {}
				};
				window.addEventListener("mousemove", mv);
				window.addEventListener("mouseup", up);
			});

			const side = main.querySelector(".wi-side");
			const steps = state.steps || [];
			const bm = `javascript:${encodeURIComponent(BOOKMARKLET_SRC.replace("__EP__", API.replace(/'/g, "")).replace("__MSK__", settings.maskPasswords ? "1" : "0"))}`;
			side.innerHTML = `
				<div class="card"><b>${esc(t("status"))}</b><div class="dim">${esc(state.page ? `${state.page.title || ""} — ${state.page.url}` : t("noPage"))}</div>
				${state.picked ? `<div><b>${esc(t("picked"))} [${esc(state.picked.tag)}]</b> ${esc(state.picked.text)}<br><code>${esc(state.picked.sel)}</code></div>` : ""}</div>
				<div class="card"><b>${esc(t("steps"))}</b>（${steps.length}）
				<ol class="steps">${steps.slice(-50).map((s) => `<li><b>${esc(s.kind)}</b> ${esc(s.label)}${s.sel ? `<br><code>${esc(s.sel)}</code>` : ""}</li>`).join("") || `<span class="dim">${esc(t("empty"))}</span>`}</ol>
				<button data-a="visit">${esc(t("visit"))}</button><button data-a="pick2">${esc(t("pickEl"))}</button><button data-a="note">${esc(t("addNote"))}</button><button data-a="clear">${esc(t("clear"))}</button></div>
				<div class="card"><a class="bm" href="${bm}">${esc(t("bmName"))}</a><div class="dim">${esc(t("bmHint"))}</div></div>
				<div class="card"><textarea data-a="task" rows="3" placeholder="${esc(t("taskPh"))}"></textarea><button data-a="final" class="primary">${esc(t("final"))}</button>
				${flash ? `<div class="wi-flash">${esc(flash)}</div>` : ""}</div>
				<details class="card"><summary class="dim">${esc(t("elements"))}（${state.snapshot ? state.snapshot.count : 0}）· ${esc(t("recentLog"))}（${state.log.length}）</summary>
				<pre>${esc((state.snapshot?.elements || []).slice(0, 20).map((e) => `[${e.i}] <${e.tag}> ${e.text || ""} :: ${e.sel}`).join("\n") || `(${t("empty")})`)}</pre></div>`;
			flash = "";

			const urlInput = bar.querySelector('[data-a="url"]');
			urlInput.addEventListener("keydown", (e) => {
				if (e.key === "Enter") visit(urlInput.value);
			});
			bar.querySelector('[data-a="go"]').addEventListener("click", () => visit(urlInput.value));
			bar.querySelector('[data-a="snap"]').addEventListener("click", () => {
				const doc = sameDoc();
				if (doc && browserUrl) void postCollect(collectSnapshot(doc, browserUrl));
				else {
					flash = t("xorigin");
					render();
				}
			});
			bar.querySelector('[data-a="pick"]').addEventListener("click", () => (pickArmed ? disarmPick() + render() : armPick()));
			side.querySelector('[data-a="visit"]').addEventListener("click", () => visit(urlInput.value));
			side.querySelector('[data-a="pick2"]').addEventListener("click", () => (pickArmed ? disarmPick() + render() : armPick()));
			side.querySelector('[data-a="note"]').addEventListener("click", () => {
				const v = prompt("note:");
				if (v?.trim()) ctx.send({ action: "note", text: v.trim() });
			});
			side.querySelector('[data-a="clear"]').addEventListener("click", () => ctx.send({ action: "clear" }));
			side.querySelector('[data-a="final"]').addEventListener("click", async () => {
				const ta = side.querySelector('[data-a="task"]');
				const task = (ta.value || "").trim();
				if (!task) {
					flash = t("needTask");
					render();
					side.querySelector('[data-a="task"]').value = "";
					return;
				}
				try {
					const r = await fetch(`${API}/report`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task }) });
					const j = await r.json();
					if (j.ok) {
						const host = window.__piWebUiHost;
						if (host && typeof host.compose === "function") {
							host.compose({
								text: `${t("askPrefix")}${task}\n(report: ${j.path})`,
								attachments: [{ path: j.path, name: j.path.split("/").pop(), mode: "reference" }],
							});
						}
						flash = t("sent");
					}
				} catch {}
				render();
			});
		};

		const refresh = async (withSettings) => {
			try {
				const r = await fetch(`${API}/state`);
				const j = await r.json();
				if (j.ok && j.state) state = j.state;
				if (withSettings) {
					const s = await fetch(`${API}/settings`);
					const sj = await s.json();
					if (sj.ok && sj.settings) {
						settings = { ...settings, ...sj.settings };
						if (!localStorage.getItem("web-inspect:sideW") && settings.sidebarWidth) sideW = settings.sidebarWidth;
					}
				}
			} catch {}
			render();
		};

		const off = ctx.onData((p) => {
			if (p && p.kind === "web-inspect" && p.state) {
				state = p.state;
				render();
			}
		});

		render();
		void refresh(true);
		return () => {
			try {
				off?.();
			} catch {}
			disarmPick();
			root.remove();
		};
	},
});
