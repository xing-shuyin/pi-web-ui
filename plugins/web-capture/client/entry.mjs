import { defineView, esc } from "./sdk/client.mjs";
import { t } from "./i18n.mjs";

/** Bookmarklet source (__EP__/__MSK__ replaced at render): dependency-free, Image beacon = preflight-free GET, cross-origin safe. */
const BOOKMARKLET_SRC = `(()=>{const EP='__EP__';const MSK='__MSK__'==='1';const B=o=>{new Image().src=EP+'/collect?d='+encodeURIComponent(JSON.stringify(o)).slice(0,7000)};const css=e=>{if(e.id)return '#'+e.id;const p=[];let n=e;for(let d=0;n&&n.nodeType===1&&d<5;n=n.parentNode,d++){let s=n.tagName.toLowerCase();if(n.className&&typeof n.className==='string'){const c=n.className.trim().split(/\\s+/).slice(0,2).join('.');if(c)s+='.'+c}const sib=[... (n.parentNode?.children||[])].filter(x=>x.tagName===n.tagName);if(sib.length>1)s+=':nth-of-type('+(sib.indexOf(n)+1)+')';p.unshift(s)}return p.join('>')};const txt=e=>{if(MSK&&(e.type==='password'||e.getAttribute?.('type')==='password'))return '(typed, masked)';return (e.innerText||e.value||e.placeholder||e.getAttribute('aria-label')||'').trim().replace(/\\s+/g,' ').slice(0,80)};const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.right>0};const els=[...document.querySelectorAll('a,button,input,select,textarea,[role=button],[onclick]')].filter(vis).slice(0,60).map((e,i)=>({i,tag:e.tagName.toLowerCase(),text:txt(e),sel:css(e),href:e.href?.slice(0,300),name:e.name,type:e.type}));B({type:'snapshot',url:location.href,title:document.title,count:els.length,elements:els});if(!window.__WI_LOGGED){window.__WI_LOGGED=1;for(const[ev,fn]of[['click',e=>txt(e.target)],['input',e=>e.target.name||e.target.placeholder||txt(e.target)],['submit',e=>txt(e.target)],['change',e=>e.target.name||txt(e.target)]])document.addEventListener(ev,e=>{const tgt=e.target.closest('a,button,input,select,textarea,[role=button]');B({type:'event',ev,url:location.href,text:fn(e).slice(0,120),sel:tgt?css(tgt):''})},true)}if(window.__WI_PICK)return;window.__WI_PICK=1;const box=document.createElement('div');box.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #f00;background:#f002';document.body.appendChild(box);const mv=e=>{const tgt=e.target.closest('a,button,input,select,textarea,[role=button],div,span,li,td,h1,h2,h3,p');if(!tgt)return;window.__WI_T=tgt;const r=tgt.getBoundingClientRect();Object.assign(box.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'})};const done=e=>{if(e.key==='Escape'){cleanup()}};const pick=e=>{e.preventDefault();e.stopPropagation();const tgt=window.__WI_T||e.target;const md='['+tgt.tagName.toLowerCase()+'] '+txt(tgt)+'\\n sel: '+css(tgt)+'\\n @ '+location.href;B({type:'pick',url:location.href,tag:tgt.tagName.toLowerCase(),text:txt(tgt),sel:css(tgt),path:css(tgt)});try{navigator.clipboard.writeText(md)}catch{}cleanup();alert(('Sent back to pi-web-ui ✅\n')+md)};function cleanup(){window.__WI_PICK=0;document.removeEventListener('mousemove',mv,true);document.removeEventListener('click',pick,true);document.removeEventListener('keydown',done,true);box.remove()}document.addEventListener('mousemove',mv,true);document.addEventListener('click',pick,true);document.addEventListener('keydown',done,true);})()`;

function apiBase() {
	try {
		const u = new URL(import.meta.url);
		const i = u.pathname.indexOf("/plugins/");
		const root = i > 0 ? u.pathname.slice(0, i) : "";
		return root + "/plugins-api/web-capture";
	} catch {
		return "/plugins-api/web-capture";
	}
}

const IC = {
	go: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
	snap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
	pick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3l7 18 2.5-7.5L21 11z"/></svg>',
	note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>',
	clear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
	send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/></svg>',
	back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>',
	fwd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>',
	reload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v5h-5"/></svg>',
	reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
	open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/></svg>',
	cap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/></svg>',
	list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
};

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

const CSS = `.wi{font:13px/1.6 system-ui,sans-serif;height:100%;display:flex;flex-direction:column;color:var(--text,inherit);min-height:0}.wi-sidehead{flex:none;padding:8px 8px 0;font-size:11.5px;color:var(--text-dim,#999);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.wi-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:20px;background:var(--bg-elev2,#8881)}.wi-empty .urlrow{width:min(480px,90%)}.wi-empty h3{margin:0;font-size:15px}.ibtn{flex:none;width:32px;height:30px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border,#8886);border-radius:7px;background:transparent;color:var(--text,inherit);cursor:pointer;padding:0}.ibtn svg{width:16px;height:16px}.ibtn:hover{background:var(--accent-soft,#8882)}.ibtn.on{color:var(--accent-contrast,#fff);background:var(--accent,#4a7dff);border-color:var(--accent,#4a7dff)}.wi-main{flex:1;display:flex;min-height:0}.wi-browser{flex:1;min-width:0;display:flex;flex-direction:column}.wi-browser iframe{flex:1;width:100%;border:0;background:#fff;min-height:0}.wi-framed{font-size:11px;color:var(--text-dim,#999);padding:2px 10px}.pxbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;background:var(--accent-soft,#8882);border-bottom:1px solid var(--border,#8884);padding:6px 10px;font-size:12px}.wi-grip{flex:none;width:8px;cursor:col-resize}.wi-grip:hover,.wi-grip.on{background:var(--accent-soft,#8883)}.wi-grip{touch-action:none}@media (pointer:coarse){.wi-grip{width:14px}.ibtn{width:40px;height:36px}}.wi-side{flex:none;display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--border,#8883)}.stabs{flex:none;display:flex;gap:4px;padding:8px 8px 0}.stabs button{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;border:1px solid var(--border,#8884);border-bottom:0;border-radius:8px 8px 0 0;padding:6px 2px;background:transparent;color:var(--text-dim,#999);font-size:12px;cursor:pointer}.stabs button svg{width:14px;height:14px}.stabs button.on{color:var(--text-strong,var(--text,inherit));background:var(--bg-elev,transparent);border-color:var(--accent,#4a7dff);font-weight:600}.sbody{flex:1;min-height:0;overflow-y:auto;padding:8px;border-top:1px solid var(--border,#8884);display:flex;flex-direction:column;gap:8px}.sfoot{flex:none;padding:8px;border-top:1px solid var(--border,#8883)}.sfoot button{width:100%;padding:8px;font-size:13px;font-weight:600}.wi .dim{font-size:11.5px;color:var(--text-dim,#999)}.wi .card{border:1px solid var(--border,#8884);border-radius:10px;padding:8px 10px;background:var(--bg-elev,transparent)}.wi .guide{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}.wi .guide li{display:flex;gap:8px;align-items:flex-start}.wi .gn{flex:none;width:20px;height:20px;border-radius:50%;background:var(--accent,#4a7dff);color:var(--accent-contrast,#fff);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px}.wi input[type=text],.wi textarea{width:100%;box-sizing:border-box;background:var(--bg-elev2,#8881);color:var(--text,inherit);border:1px solid var(--border,#8884);border-radius:6px;padding:6px 8px;font-size:12px}.wi textarea{resize:vertical}.wi ol.steps{margin:6px 0;padding-left:20px;font-size:12px}.wi ol.steps li{margin:3px 0}.step-row{display:flex;align-items:flex-start;gap:6px}.step-row .sl{flex:1;min-width:0}.step-btns{margin-left:auto;flex:none;display:inline-flex;gap:4px}.wi code{font-size:11px;word-break:break-all}.wi a.bm{display:inline-block;margin:4px 0;padding:4px 12px;border:1px dashed var(--accent,#4a7dff);border-radius:8px;text-decoration:none;color:var(--accent,#4a7dff);font-size:12px}.wi-flash{font-size:12px;color:var(--accent,#4a7dff);margin-top:6px}.wi pre{white-space:pre-wrap;font-size:11px;max-height:160px;overflow:auto;background:var(--bg-elev2,#8881);border-radius:6px;padding:6px 8px}.urlrow{display:flex;gap:6px}.urlrow input{flex:1;min-width:0}.navrow{flex:none;display:flex;flex-direction:column;gap:6px;padding:8px 8px 0}.navrow .navbtns{display:flex;gap:4px;align-items:center}.navrow input{flex:1;min-width:0;background:var(--bg-elev2,#8881);color:var(--text,inherit);border:1px solid var(--border,#8884);border-radius:6px;padding:4px 8px;font-size:12px}.zoomrow{display:flex;gap:6px;align-items:center}.zoomrow .zv{min-width:44px;text-align:center;font-size:12px}`;

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
		let sideW = Number(localStorage.getItem("web-capture:sideW")) || settings.sidebarWidth;
		let mode = "capture";
		let browserUrl = "";
		let proxyMode = false;
		let bannerOff = false;
		let bannerOn = false;
		let pickArmed = false;
		let flash = "";
		let zoom = 1;
		let taskDraft = "";

		const root = document.createElement("div");
		root.className = "wi";
		root.appendChild(Object.assign(document.createElement("style"), { textContent: CSS }));
		el.appendChild(root);

		let frame = null;
		let pickCleanup = null;
		let pendingVisit = false;
		let shownBrowser = ""; // "" | "empty" | "frame" — never re-append the iframe

		// Skeleton: built ONCE. Re-appending an iframe reloads it, which used
		// to cause an infinite load→broadcast→render loop (frozen tabs).
		const main = document.createElement("div");
		main.className = "wi-main";
		main.innerHTML = `<div class="wi-browser"></div><div class="wi-grip" title="⇔"></div><div class="wi-side" style="width:${sideW}px"></div>`;
		root.append(main);
		const browserPane = main.querySelector(".wi-browser");
		const side = main.querySelector(".wi-side");
		const nav = document.createElement("div");
		nav.className = "navrow";
		nav.innerHTML = `<input data-a="navurl" placeholder="${esc(t("urlPh"))}"><div class="navbtns">${ibtn("back", "back", t("tipBack"))}${ibtn("fwd", "fwd", t("tipFwd"))}${ibtn("reload", "reload", t("tipReload"))}${ibtn("navgo", "go", t("tipGo"))}${ibtn("navopen", "open", t("tipOpenTab"))}</div>`;
		const zoomBox = document.createElement("details");
		zoomBox.className = "card";
		zoomBox.style.margin = "8px 8px 0";
		zoomBox.innerHTML = `<summary class="dim">${esc(t("zoom"))} <span data-a="zoomv">100%</span></summary><div class="zoomrow" style="margin-top:6px"><button data-a="zout">−</button><button data-a="zin">+</button><button data-a="zreset">${esc(t("tipZoomReset"))}</button></div>`;
		const tabs = document.createElement("div");
		tabs.className = "stabs";
		const body = document.createElement("div");
		body.className = "sbody";
		side.append(nav, zoomBox, tabs, body);
		const navInput = nav.querySelector('[data-a="navurl"]');
		navInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") visit(navInput.value);
		});
		nav.querySelector('[data-a="navgo"]').addEventListener("click", () => visit(navInput.value));
		nav.querySelector('[data-a="navopen"]').addEventListener("click", () => openRealTab(navInput.value || browserUrl));
		nav.querySelector('[data-a="back"]').addEventListener("click", () => {
			try { frame?.contentWindow?.history?.back(); } catch {}
			setTimeout(trackUrl, 400);
		});
		nav.querySelector('[data-a="fwd"]').addEventListener("click", () => {
			try { frame?.contentWindow?.history?.forward(); } catch {}
			setTimeout(trackUrl, 400);
		});
		nav.querySelector('[data-a="reload"]').addEventListener("click", () => {
			if (browserUrl) { pendingVisit = true; frame.src = proxyMode ? proxySrc(browserUrl) : browserUrl; }
		});
		zoomBox.querySelector('[data-a="zin"]').addEventListener("click", () => setZoom(zoom + 0.1));
		zoomBox.querySelector('[data-a="zout"]').addEventListener("click", () => setZoom(zoom - 0.1));
		zoomBox.querySelector('[data-a="zreset"]').addEventListener("click", () => setZoom(1));
		main.querySelector(".wi-grip").addEventListener("mousedown", (e) => {
			e.preventDefault();
			const grip = e.currentTarget;
			grip.classList.add("on");
			const veil = document.createElement("div");
			veil.style.cssText = "position:fixed;inset:0;z-index:2147483647;cursor:col-resize;user-select:none";
			document.body.appendChild(veil);
			const x0 = e.clientX;
			const w0 = sideW;
			let raf = 0;
			let nx = x0;
			const apply = () => {
				raf = 0;
				sideW = Math.max(200, Math.min(640, w0 - (nx - x0)));
				side.style.width = sideW + "px";
			};
			const mv = (ev) => {
				nx = ev.clientX;
				if (!raf) raf = requestAnimationFrame(apply);
			};
			const up = () => {
				if (raf) cancelAnimationFrame(raf);
				grip.classList.remove("on");
				veil.remove();
				window.removeEventListener("mousemove", mv);
				window.removeEventListener("mouseup", up);
				try {
					localStorage.setItem("web-capture:sideW", String(sideW));
				} catch {}
			};
			window.addEventListener("mousemove", mv);
			window.addEventListener("mouseup", up);
		});
		{
			const gripEl = main.querySelector(".wi-grip");
			gripEl.addEventListener("touchstart", (te) => {
				te.preventDefault();
				const tc0 = te.touches[0];
				const gx0 = tc0.clientX;
				const gw0 = sideW;
				const gm = (e2) => {
					const tc = e2.touches[0];
					sideW = Math.max(200, Math.min(640, gw0 - (tc.clientX - gx0)));
					side.style.width = sideW + "px";
				};
				const gu = () => {
					window.removeEventListener("touchmove", gm);
					window.removeEventListener("touchend", gu);
					try { localStorage.setItem("web-capture:sideW", String(sideW)); } catch {}
				};
				window.addEventListener("touchmove", gm, { passive: true });
				window.addEventListener("touchend", gu);
			}, { passive: false });
		}

		frame = document.createElement("iframe");
		frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
		frame.addEventListener("load", () => {
			trackUrl();
			attachFrameListeners();
			if (settings.autoSnapshot) {
				const doc = sameDoc();
				if (doc && browserUrl) void postCollect(collectSnapshot(doc, browserUrl));
			}
		});

		function sameDoc() {
			try {
				const doc = frame?.contentDocument;
				if (doc && doc.documentElement) return doc;
			} catch {}
			return null;
		}

		function sendStep(step) {
			const last = state.steps[state.steps.length - 1];
			if (last && last.kind === step.kind && (last.label || "") === (step.label || "") && (last.sel || "") === (step.sel || "") && (last.url || "") === (step.url || "")) return;
			ctx.send({ action: "step", step });
		}

		function syncSteps() {
			state.steps.forEach((s, i) => (s.n = i + 1));
			ctx.send({ action: "steps", steps: state.steps });
		}

		// Follow URL changes inside the iframe (link clicks, redirects).
		// Cross-origin reads throw → keep the last known URL instead of hanging.
		function sameOrigin(a, b) {
			try {
				return new URL(a).origin === new URL(b).origin;
			} catch {
				return true;
			}
		}

		function handleNewUrl(actual) {
			if (!actual || actual === browserUrl) return;
			if (browserUrl && !sameOrigin(actual, browserUrl)) {
				ctx.send({ action: "clear" });
				state.steps = [];
				state.picked = null;
				state.snapshot = null;
			}
			browserUrl = actual;
			sendStep({ kind: "nav", label: actual, url: actual });
			renderBrowser();
			renderSide();
		}

		function trackUrl() {
			let actual = "";
			try {
				actual = frame?.contentWindow?.location?.href || "";
				if (actual === "about:blank") actual = "";
			} catch {
				actual = "";
			}
			if (proxyMode) {
				pendingVisit = false;
				let stillProxied = false;
				try {
					stillProxied = !!actual && new URL(actual, location.href).pathname.indexOf(API + "/proxy") === 0;
				} catch {
					stillProxied = false;
				}
				if (stillProxied) return;
				// left the proxy (a link led out): back to direct mode
				proxyMode = false;
				bannerOff = false;
				ctx.send({ action: "clear" });
				state.steps = [];
				state.picked = null;
				state.snapshot = null;
			}
			if (pendingVisit) pendingVisit = false;
			else handleNewUrl(actual);
			renderBrowser();
			renderSide();
		}

		function collectSnapshot(doc, url) {
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
		}

		async function postCollect(obj) {
			try {
				const r = await fetch(`${API}/collect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
				if (r.ok) refresh();
			} catch {}
		}

		function disarmPick() {
			pickArmed = false;
			try {
				pickCleanup?.();
			} catch {}
			pickCleanup = null;
		}

		function armPick() {
			disarmPick();
			const doc = sameDoc();
			if (!doc) {
				mode = "capture";
				flash = t("xorigin");
				renderSide();
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
				if (e.key === "Escape") {
					disarmPick();
					renderSide();
				}
			};
			const pick = (e) => {
				e.preventDefault();
				e.stopPropagation();
				const tgt = window.__WI_T || e.target;
				disarmPick();
				void postCollect({ type: "pick", url: browserUrl, tag: tgt.tagName.toLowerCase(), text: elText(tgt, settings.maskPasswords), sel: cssPath(tgt), path: cssPath(tgt) });
			};
			const mvt = (e) => {
				const tc = e.touches?.[0];
				if (!tc) return;
				const tgt = doc.elementFromPoint(tc.clientX, tc.clientY)?.closest("a,button,input,select,textarea,[role=button],div,span,li,td,h1,h2,h3,p");
				if (!tgt) return;
				window.__WI_T = tgt;
				const r = tgt.getBoundingClientRect();
				Object.assign(box.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
			};
			const pickt = (e) => {
				const tc = e.touches?.[0];
				const tgt = (tc && doc.elementFromPoint(tc.clientX, tc.clientY)) || e.target;
				e.preventDefault();
				e.stopPropagation();
				disarmPick();
				if (tgt && tgt.tagName) void postCollect({ type: "pick", url: browserUrl, tag: tgt.tagName.toLowerCase(), text: elText(tgt, settings.maskPasswords), sel: cssPath(tgt), path: cssPath(tgt) });
			};
			doc.addEventListener("mousemove", mv, true);
			doc.addEventListener("click", pick, true);
			doc.addEventListener("touchmove", mvt, { capture: true, passive: true });
			doc.addEventListener("touchstart", pickt, { capture: true, passive: false });
			doc.addEventListener("keydown", done, true);
			pickCleanup = () => {
				doc.removeEventListener("mousemove", mv, true);
				doc.removeEventListener("click", pick, true);
				doc.removeEventListener("touchmove", mvt, true);
				doc.removeEventListener("touchstart", pickt, true);
				doc.removeEventListener("keydown", done, true);
				box.remove();
			};
			flash = t("armed");
			renderSide();
		}

		function attachFrameListeners() {
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
			for (const ev of ["click", "input", "submit", "change"]) {
				doc.addEventListener(
					ev,
					(e) => sendStep({ kind: ev === "submit" ? "click" : ev === "change" ? "input" : ev, label: `${val(e)}`.slice(0, 140) || ev, sel: sel(e), url: browserUrl }),
					true,
				);
			}
		}

		function proxySrc(target) {
			const absEp = new URL(API, location.href).href;
			return `${API}/proxy?url=${encodeURIComponent(target)}&ep=${encodeURIComponent(absEp)}&msk=${settings.maskPasswords ? "1" : "0"}`;
		}

		function visitProxy(target) {
			target = normUrl(target);
			if (!target) return;
			browserUrl = target;
			pendingVisit = true;
			proxyMode = true;
			bannerOff = true;
			bannerOn = false;
			disarmPick();
			sendStep({ kind: "visit", label: `${target} (proxied)`, url: target });
			frame.src = proxySrc(target);
			renderBrowser();
		}

		function normUrl(url) {
			url = (url || "").trim();
			if (!url) return "";
			if (!/^https?:\/\//i.test(url)) url = "http://" + url;
			return url;
		}

		function openRealTab(url) {
			url = normUrl(url);
			if (!url) return;
			try { window.open(url, "_blank", "noopener"); } catch {}
		}

		function visit(url) {
			// default: auto-proxy (same-origin => full auto record on any
			// site incl. mobile; login pages still need the bookmarklet)
			visitProxy(url);
		}

		function ibtn(a, icon, tip, on) {
			return `<button class="ibtn${on ? " on" : ""}" data-a="${a}" title="${esc(tip)}">${IC[icon]}</button>`;
		}

		function stepBtns(idx, total) {
			const b = (mv, ch, tip) =>
				`<button data-mv="${mv}" data-i="${idx}" title="${esc(tip)}" style="border:1px solid var(--border,#8886);border-radius:5px;background:transparent;color:var(--text-dim,#999);font-size:11px;padding:0 6px;cursor:pointer"${mv !== 0 && ((mv < 0 && idx === 0) || (mv > 0 && idx === total - 1)) ? " disabled style=\"opacity:.35;border:1px solid var(--border,#8886);border-radius:5px;background:transparent;color:var(--text-dim,#999);font-size:11px;padding:0 6px;cursor:default\"" : ""}>${ch}</button>`;
			return `<span class="step-btns">${b(-1, "↑", t("tipUp"))}${b(1, "↓", t("tipDown"))}<button data-del="${idx}" title="${esc(t("tipDel"))}" style="border:1px solid var(--border,#8886);border-radius:5px;background:transparent;color:var(--text-dim,#999);font-size:11px;padding:0 6px;cursor:pointer">×</button></span>`;
		}

		function setZoom(z) {
			zoom = Math.max(0.5, Math.min(2.5, Math.round(z * 10) / 10));
			try { frame.style.zoom = String(zoom); } catch {}
			const zv = zoomBox.querySelector('[data-a="zoomv"]');
			if (zv) zv.textContent = Math.round(zoom * 100) + "%";
		}

		function resetFlow() {
			disarmPick();
			ctx.send({ action: "clear" });
			browserUrl = "";
			pendingVisit = false;
			taskDraft = "";
			state = { page: null, snapshot: null, picked: null, log: [], steps: [] };
			mode = "capture";
			render();
		}

		function renderBrowser() {
			const want = browserUrl ? "frame" : "empty";
			if (want !== shownBrowser) {
				shownBrowser = want;
				browserPane.replaceChildren();
			if (!browserUrl) {
				const empty = document.createElement("div");
				empty.className = "wi-empty";
				empty.innerHTML = `<h3>${esc(t("mCapture"))}</h3><div class="urlrow"><input data-a="url0" placeholder="${esc(t("urlPh"))}">${ibtn("go0", "go", t("tipGo"))}${ibtn("open0", "open", t("tipOpenTab"))}</div><div class="dim">${esc(t("framedHint"))}</div>`;
				browserPane.append(empty);
				const url0 = empty.querySelector('[data-a="url0"]');
				url0.addEventListener("keydown", (e) => {
					if (e.key === "Enter") visit(url0.value);
				});
				empty.querySelector('[data-a="go0"]').addEventListener("click", () => visit(url0.value));
				empty.querySelector('[data-a="open0"]').addEventListener("click", () => openRealTab(url0.value || browserUrl));
			} else {
				browserPane.append(frame);
			}
			}
			browserPane.querySelectorAll(".pxbar").forEach((n) => n.remove());
			if (shownBrowser === "frame" && bannerOn && !proxyMode) {
				const bar = document.createElement("div");
				bar.className = "pxbar";
				bar.innerHTML = `<span>${esc(t("proxyBar"))}</span><button data-a="pxgo">${esc(t("useProxy"))}</button><button data-a="pxopen">${esc(t("openReal"))}</button><button data-a="pxx">${esc(t("dismiss"))}</button><span class="dim">${esc(t("proxyNote"))}</span>`;
				browserPane.append(bar);
				bar.querySelector('[data-a="pxgo"]').addEventListener("click", () => visitProxy(browserUrl));
				bar.querySelector('[data-a="pxopen"]').addEventListener("click", () => openRealTab(browserUrl));
				bar.querySelector('[data-a="pxx"]').addEventListener("click", () => { bannerOff = true; bannerOn = false; renderBrowser(); });
			}
		}

		function renderSide() {
			const steps = state.steps || [];
			const bm = `javascript:${encodeURIComponent(BOOKMARKLET_SRC.replace("__EP__", API.replace(/'/g, "")).replace("__MSK__", settings.maskPasswords ? "1" : "0"))}`;
			if (document.activeElement !== navInput) navInput.value = browserUrl;
			const zv = zoomBox.querySelector('[data-a="zoomv"]');
			if (zv) zv.textContent = Math.round(zoom * 100) + "%";
			tabs.innerHTML = `<button data-m="capture" class="${mode === "capture" ? "on" : ""}">${IC.cap}<span>${esc(t("mCapture"))}</span></button><button data-m="steps" class="${mode === "steps" ? "on" : ""}">${IC.list}<span>${esc(t("mSteps"))}(${steps.length})</span></button><button data-m="send" class="${mode === "send" ? "on" : ""}">${IC.send}<span>${esc(t("mSend"))}</span></button>`;
			tabs.querySelectorAll("[data-m]").forEach((b) =>
				b.addEventListener("click", () => {
					mode = b.dataset.m;
					renderSide();
				}),
			);

			if (mode === "capture") {
				if (body.querySelector('[data-a="url"]') === document.activeElement) return;
				body.innerHTML = `<ol class="guide">
					<li><span class="gn">1</span><div style="flex:1"><b>${esc(t("guide1"))}</b><div class="urlrow" style="margin-top:6px"><input data-a="url" placeholder="${esc(t("urlPh"))}" value="${esc(browserUrl)}">${ibtn("go2", "go", t("tipGo"))}${ibtn("open2", "open", t("tipOpenTab"))}</div></div></li>
					<li><span class="gn">2</span><div style="flex:1"><b>${esc(t("guide2"))}</b><div class="dim" data-a="pagemode" style="margin-top:4px"></div><div style="margin-top:6px;display:flex;gap:6px">${ibtn("pick2", "pick", t("tipPick"), pickArmed)}${ibtn("snap2", "snap", t("tipSnap"))}</div>
					<div data-a="pxcta" style="margin-top:6px;display:none;gap:6px;flex-wrap:wrap;align-items:center"><button data-a="pxgo2">${esc(t("useProxy"))}</button><button data-a="pxopen2">${esc(t("openReal"))}</button><div class="dim">${esc(t("proxyNote"))}</div></div>
					<details style="margin-top:6px"><summary class="dim">${esc(t("bmLogin"))}</summary><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:4px"><a class="bm" href="${bm}">${esc(t("bmName"))}</a><button data-a="copybm">${esc(t("copyBm"))}</button></div><div class="dim">${esc(t("bmHint"))}</div></details></div></li>
					<li><span class="gn">3</span><div><b>${esc(t("guide3"))}</b></div></li></ol>${flash ? `<div class="wi-flash">${esc(flash)}</div>` : ""}`;
				flash = "";
				const urlInput = body.querySelector('[data-a="url"]');
				urlInput.addEventListener("keydown", (e) => {
					if (e.key === "Enter") visit(urlInput.value);
				});
				body.querySelector('[data-a="go2"]').addEventListener("click", () => visit(urlInput.value));
				body.querySelector('[data-a="open2"]').addEventListener("click", () => openRealTab(urlInput.value || browserUrl));
				body.querySelector('[data-a="pick2"]').addEventListener("click", () => (pickArmed ? (disarmPick(), renderSide()) : armPick()));
				const pm = body.querySelector('[data-a="pagemode"]');
				const pxcta = body.querySelector('[data-a="pxcta"]');
				if (pm) {
					const readable = !!(browserUrl && sameDoc());
					pm.textContent = !browserUrl ? "" : readable ? "● " + t("modeAuto") : "○ " + t("modeProxy");
					if (pxcta) pxcta.style.display = browserUrl && !readable ? "flex" : "none";
				}
				const pxgo2 = body.querySelector('[data-a="pxgo2"]');
				if (pxgo2) pxgo2.addEventListener("click", () => visitProxy(browserUrl));
				const pxopen2 = body.querySelector('[data-a="pxopen2"]');
				if (pxopen2) pxopen2.addEventListener("click", () => openRealTab(browserUrl));
				body.querySelector('[data-a="copybm"]').addEventListener("click", async () => {
					try {
						await navigator.clipboard.writeText(`javascript:${encodeURIComponent(BOOKMARKLET_SRC.replace("__EP__", API.replace(/'/g, "")).replace("__MSK__", settings.maskPasswords ? "1" : "0"))}`);
						flash = t("copiedBm");
						renderSide();
					} catch {}
				});
				body.querySelector('[data-a="snap2"]').addEventListener("click", () => {
					const doc = sameDoc();
					if (doc && browserUrl) void postCollect(collectSnapshot(doc, browserUrl));
					else {
						flash = t("xorigin");
						renderSide();
					}
				});
			} else if (mode === "steps") {
				body.innerHTML = `<div class="card"><div style="display:flex;gap:6px;margin-bottom:6px">${ibtn("note", "note", t("tipNote"))}${ibtn("clear", "clear", t("tipClear"))}${ibtn("newflow", "reset", t("tipNewFlow"))}</div>
				<ol class="steps">${steps.map((s, idx) => `<li><div class="step-row"><div class="sl"><b>${esc(s.kind)}</b> ${esc(s.label)}${s.sel ? `<br><code>${esc(s.sel)}</code>` : ""}</div>${stepBtns(idx, steps.length)}</div></li>`).join("") || `<span class="dim">${esc(t("empty"))}</span>`}</ol></div>
				${state.picked ? `<div class="card"><b>${esc(t("picked"))} [${esc(state.picked.tag)}]</b> ${esc(state.picked.text)}<br><code>${esc(state.picked.sel)}</code></div>` : ""}
				<details class="card"><summary class="dim">${esc(t("elements"))}（${state.snapshot ? state.snapshot.count : 0}）· ${esc(t("recentLog"))}（${state.log.length}）</summary>
				<pre>${esc((state.snapshot?.elements || []).slice(0, 20).map((e) => `[${e.i}] <${e.tag}> ${e.text || ""} :: ${e.sel}`).join("\n") || `(${t("empty")})`)}

${esc((state.log || []).slice(-10).map((l) => `[${(l.t || "").slice(11, 19)}] ${l.kind}: ${l.text}`).join("\n"))}</pre></details>${flash ? `<div class="wi-flash">${esc(flash)}</div>` : ""}`;
				flash = "";
				body.querySelector('[data-a="note"]').addEventListener("click", () => {
					const v = prompt("note:");
					if (v?.trim()) ctx.send({ action: "note", text: v.trim() });
				});
				body.querySelector('[data-a="clear"]').addEventListener("click", () => ctx.send({ action: "clear" }));
				body.querySelector('[data-a="newflow"]').addEventListener("click", resetFlow);
				body.querySelectorAll("[data-mv]").forEach((b) =>
					b.addEventListener("click", () => {
						const i = Number(b.dataset.i);
						const d = Number(b.dataset.mv);
						const j = i + d;
						if (j < 0 || j >= state.steps.length) return;
						const [s] = state.steps.splice(i, 1);
						state.steps.splice(j, 0, s);
						syncSteps();
					}),
				);
				body.querySelectorAll("[data-del]").forEach((b) =>
					b.addEventListener("click", () => {
						const i = Number(b.dataset.del);
						state.steps.splice(i, 1);
						syncSteps();
					}),
				);
			} else {
				const wasEditing = body.querySelector('[data-a="task"]') === document.activeElement;
				body.innerHTML = `<div class="card"><div class="dim">${esc(t("status"))}: ${esc(state.page ? `${state.page.title || ""} — ${state.page.url}` : t("noPage"))}</div>
				<div class="dim">${esc(t("mSteps"))}: ${steps.length} · ${esc(t("elements"))}: ${state.snapshot ? state.snapshot.count : 0}</div></div>
				<div class="card"><textarea data-a="task" rows="5" placeholder="${esc(t("taskPh"))}">${esc(taskDraft)}</textarea>
				<button data-a="final" class="primary" style="width:100%;padding:8px;margin-top:8px;border:0;font-weight:600">${esc(t("final"))}</button>
				<button data-a="resetflow" style="width:100%;padding:6px;margin-top:6px">${esc(t("newFlow"))}</button>${flash ? `<div class="wi-flash">${esc(flash)}</div>` : ""}</div>`;
				flash = "";
				const ta = body.querySelector('[data-a="task"]');
				ta.addEventListener("input", () => { taskDraft = ta.value; });
				if (wasEditing) { ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {} }
				body.querySelector('[data-a="final"]').addEventListener("click", onFinal);
				body.querySelector('[data-a="resetflow"]').addEventListener("click", resetFlow);
			}
		}

		async function onFinal() {
			const ta = body.querySelector('[data-a="task"]');
			if (ta) taskDraft = ta.value || "";
			const task = (taskDraft || "").trim();
			if (!task) {
				flash = t("needTask");
				renderSide();
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
			renderSide();
		}

		function render() {
			renderBrowser();
			renderSide();
		}

		async function refresh(withSettings) {
			try {
				const r = await fetch(`${API}/state`);
				const j = await r.json();
				if (j.ok && j.state) state = j.state;
				if (withSettings) {
					const s = await fetch(`${API}/settings`);
					const sj = await s.json();
					if (sj.ok && sj.settings) {
						settings = { ...settings, ...sj.settings };
						if (!localStorage.getItem("web-capture:sideW") && settings.sidebarWidth) {
							sideW = settings.sidebarWidth;
							side.style.width = sideW + "px";
						}
					}
				}
			} catch {}
			render();
		}

		const pollTimer = setInterval(() => {
			if (!browserUrl || proxyMode || pickArmed) return;
			try {
				const href = frame?.contentWindow?.location?.href || "";
				if (href && href !== "about:blank" && sameDoc()) handleNewUrl(href);
			} catch {}
		}, 1500);

		const off = ctx.onData((p) => {
			if (p && p.kind === "web-capture" && p.state) {
				state = p.state;
				render();
			}
		});

		render();
		void refresh(true);
		return () => {
			try {
				clearInterval(pollTimer);
			} catch {}
			try {
				off?.();
			} catch {}
			disarmPick();
			root.remove();
		};
	},
});
