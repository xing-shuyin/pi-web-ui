import { defineView, esc } from "./sdk/client.mjs";

/**
 * 书签源码（构建时把 __EP__ 换成绝对 /collect 地址）。
 * 单文件、无依赖：Image 信标 = GET 无预检，任意站免 CORS 回传。
 */
const BOOKMARKLET_SRC = `(()=>{const EP='__EP__';const B=o=>{new Image().src=EP+'/collect?d='+encodeURIComponent(JSON.stringify(o)).slice(0,7000)};const css=e=>{if(e.id)return '#'+e.id;const p=[];let n=e;for(let d=0;n&&n.nodeType===1&&d<5;n=n.parentNode,d++){let s=n.tagName.toLowerCase();if(n.className&&typeof n.className==='string'){const c=n.className.trim().split(/\\s+/).slice(0,2).join('.');if(c)s+='.'+c}const sib=[... (n.parentNode?.children||[])].filter(x=>x.tagName===n.tagName);if(sib.length>1)s+=':nth-of-type('+(sib.indexOf(n)+1)+')';p.unshift(s)}return p.join('>')};const txt=e=>(e.innerText||e.value||e.placeholder||e.getAttribute('aria-label')||'').trim().replace(/\\s+/g,' ').slice(0,80);const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.right>0};const els=[...document.querySelectorAll('a,button,input,select,textarea,[role=button],[onclick]')].filter(vis).slice(0,60).map((e,i)=>({i,tag:e.tagName.toLowerCase(),text:txt(e),sel:css(e),href:e.href?.slice(0,300),name:e.name,type:e.type}));B({type:'snapshot',url:location.href,title:document.title,count:els.length,elements:els});if(!window.__WI_LOGGED){window.__WI_LOGGED=1;for(const[ev,fn]of[['click',e=>txt(e.target)],['input',e=>e.target.name||e.target.placeholder||txt(e.target)],['submit',e=>txt(e.target)],['change',e=>e.target.name||txt(e.target)]])document.addEventListener(ev,e=>{const t=e.target.closest('a,button,input,select,textarea,[role=button]');B({type:'event',ev,url:location.href,text:fn(e).slice(0,120),sel:t?css(t):''})},true)}if(window.__WI_PICK)return;window.__WI_PICK=1;const box=document.createElement('div');box.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #f00;background:#f002';document.body.appendChild(box);const mv=e=>{const t=e.target.closest('a,button,input,select,textarea,[role=button],div,span,li,td,h1,h2,h3,p');if(!t)return;window.__WI_T=t;const r=t.getBoundingClientRect();Object.assign(box.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'})};const done=e=>{if(e.key==='Escape'){cleanup();return}};const pick=e=>{e.preventDefault();e.stopPropagation();const t=window.__WI_T||e.target;const md='['+t.tagName.toLowerCase()+'] '+txt(t)+'\\n sel: '+css(t)+'\\n @ '+location.href;B({type:'pick',url:location.href,tag:t.tagName.toLowerCase(),text:txt(t),sel:css(t),path:css(t)});try{navigator.clipboard.writeText(md)}catch{}cleanup();alert('已回传 pi-web-ui ✅\\n'+md)};function cleanup(){window.__WI_PICK=0;document.removeEventListener('mousemove',mv,true);document.removeEventListener('click',pick,true);document.removeEventListener('keydown',done,true);box.remove()}document.addEventListener('mousemove',mv,true);document.addEventListener('click',pick,true);document.addEventListener('keydown',done,true);})()`;

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

function mdOf(s) {
	const out = [`页面: ${(s.page && `${s.page.title || "(无标题)"} <${s.page.url}>`) || "(尚无快照)"}`];
	if (s.picked) out.push(`点选: [${s.picked.tag}] ${s.picked.text}\n  sel: ${s.picked.sel}`);
	if (s.snapshot?.elements?.length) {
		out.push(`元素 (共 ${s.snapshot.count}，列前 30):`);
		for (const el of s.snapshot.elements.slice(0, 30)) out.push(`- [${el.i}] <${el.tag}> ${el.text || ""} :: ${el.sel}`);
	}
	for (const l of s.log.slice(-20)) out.push(`- [${(l.t || "").slice(11, 19)}] ${l.kind}: ${l.text}`);
	return out.join("\n");
}

const CSS = `.wi{font:13px/1.7 system-ui,sans-serif;padding:16px;max-width:760px;color:var(--text,inherit)}.wi h2{margin:0 0 4px;font-size:16px}.wi .dim{color:var(--text-dim,#999)}.wi .card{border:1px solid var(--border,#8884);border-radius:10px;padding:10px 12px;margin:10px 0;background:var(--bg-elev,transparent)}.wi a.bm{display:inline-block;margin:4px 8px 4px 0;padding:4px 12px;border:1px dashed var(--accent,#4a7dff);border-radius:8px;text-decoration:none;color:var(--accent,#4a7dff)}.wi button{border:1px solid var(--border,#8886);border-radius:7px;padding:3px 12px;background:transparent;color:var(--text,inherit);font-size:12px;cursor:pointer;margin:2px 6px 2px 0}.wi button:hover{background:var(--accent-soft,#8882)}.wi pre{white-space:pre-wrap;font-size:11.5px;max-height:220px;overflow:auto;background:var(--bg-elev2,#8881);border-radius:8px;padding:8px 10px}.wi ol.log{max-height:220px;overflow:auto;margin:6px 0;padding-left:22px;font-size:12px}.wi input[type=text],.wi textarea{width:100%;box-sizing:border-box;background:var(--bg-elev2,#8881);color:var(--text,inherit);border:1px solid var(--border,#8884);border-radius:6px;padding:5px 8px;font-size:12px}.wi code{font-size:11px}`;

export default defineView({
	mount(el, ctx) {
		const API = apiBase();
		let state = { page: null, snapshot: null, picked: null, log: [] };
		const root = document.createElement("div");
		root.className = "wi";
		const style = document.createElement("style");
		style.textContent = CSS;
		root.appendChild(style);
		el.appendChild(root);

		const render = () => {
			const bm = `javascript:${encodeURIComponent(BOOKMARKLET_SRC.replace("__EP__", API.replace(/'/g, "")))}`;
			root.querySelectorAll(".body").forEach((n) => n.remove());
			const body = document.createElement("div");
			body.className = "body";
			const logRows = state.log
				.slice(-40)
				.reverse()
				.map((l) => `<li><span class="dim">${esc((l.t || "").slice(11, 19))}</span> <b>${esc(l.kind)}</b> ${esc(l.text)}</li>`)
				.join("");
			body.innerHTML = `
				<h2>🎯 Web Inspect</h2>
				<div class="dim">当前：${esc(state.page ? `${state.page.title || ""} — ${state.page.url}` : "尚无数据")}</div>
				<div class="card"><b>1. 拖书签到收藏夹 → 在目标站点击</b>（登录态天然可用，免装扩展）<br>
				<a class="bm" href="${bm}">WI-抓页+日志+点选</a>
				<span class="dim">点一次 = 快照 + 开始记点击/输入 + 进入点选（描红框，点中即回传；Esc 退出）</span></div>
				${state.picked ? `<div class="card"><b>点选 [${esc(state.picked.tag)}]</b> ${esc(state.picked.text)}<br><code>${esc(state.picked.sel)}</code><br><span class="dim">${esc(state.picked.url || "")}</span></div>` : ""}
				<div class="card"><b>日志</b>（${state.log.length}） <button data-a="copy">复制 Markdown</button><button data-a="chat">送入聊天</button><button data-a="clear">清空</button>
				<ol class="log">${logRows || "<li class='dim'>空</li>"}</ol>
				<input type="text" data-a="note" placeholder="回车追加一条备注…"></div>
				<details class="card"><summary><b>快照元素</b>（${state.snapshot ? state.snapshot.count : 0}）</summary><pre>${esc((state.snapshot?.elements || []).slice(0, 30).map((e) => `[${e.i}] <${e.tag}> ${e.text || ""} :: ${e.sel}`).join("\n") || "(无)")}</pre></details>
				<details class="card"><summary>手动粘贴快照 JSON（书签 URL 超长时用）</summary><textarea rows="3" data-a="paste" placeholder='{"type":"snapshot",…}'></textarea><br><button data-a="import">导入</button></details>`;
			root.appendChild(body);

			body.querySelector('[data-a="copy"]')?.addEventListener("click", async () => {
				try {
					await navigator.clipboard.writeText(mdOf(state));
				} catch {}
			});
			body.querySelector('[data-a="chat"]')?.addEventListener("click", () => {
				const host = window.__piWebUiHost;
				if (host && typeof host.compose === "function") host.compose({ text: `帮我看这个页面问题：\n${mdOf(state)}` });
			});
			body.querySelector('[data-a="clear"]')?.addEventListener("click", () => ctx.send({ action: "clear" }));
			body.querySelector('[data-a="note"]')?.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && e.target.value.trim()) {
					ctx.send({ action: "note", text: e.target.value.trim() });
					e.target.value = "";
				}
			});
			body.querySelector('[data-a="import"]')?.addEventListener("click", async () => {
				const ta = body.querySelector('[data-a="paste"]');
				try {
					const r = await fetch(`${API}/collect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: ta.value });
					if (r.ok) refresh();
				} catch {}
			});
		};

		const refresh = async () => {
			try {
				const r = await fetch(`${API}/state`);
				const j = await r.json();
				if (j.ok && j.state) state = j.state;
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
		void refresh();
		return () => {
			try {
				off?.();
			} catch {}
			root.remove();
		};
	},
});
