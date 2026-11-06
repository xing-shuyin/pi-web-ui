const W_DEFAULT = 260;
const W_MIN = 180;
const W_MAX = 560;

const CSS = `
/* ===== 标题导航侧栏（插在页面原有 style 末尾，故可覆盖同名规则） =====
 * 注意：本段里绝不能出现 style/script 的结束标签字面量 —— 那会提前结束宿主元素，
 * 后面的 CSS 会变成页面正文（单测里有回归护栏）。 */
:root{--pmt-w:${W_DEFAULT}px;--pmt-bg:#1a1a1a;--pmt-fg:#c9c9c9;--pmt-line:#333;--pmt-accent:#6cb6ff}
body{max-width:none;margin:0;padding:0;display:flex;align-items:flex-start}
#pmt-main{flex:1 1 0;min-width:0;display:block}
#pmt-inner{max-width:860px;margin:0 auto;padding:24px}
#pmt{flex:0 0 var(--pmt-w);width:var(--pmt-w);position:sticky;top:0;height:100vh;overflow:auto;box-sizing:border-box;padding:52px 10px 28px 16px;background:var(--pmt-bg);border-right:1px solid var(--pmt-line);font:13px/1.55 system-ui,sans-serif;color:var(--pmt-fg);overscroll-behavior:contain}
#pmt-toggle{position:fixed;top:12px;left:12px;z-index:31;box-sizing:border-box;width:30px;height:28px;color:var(--pmt-fg);background:#0000;border:1px solid var(--pmt-line);border-radius:6px;cursor:pointer;font:14px/1 system-ui,sans-serif;padding:0}
#pmt-title{position:fixed;top:12px;left:52px;z-index:31;font:600 12px/28px system-ui,sans-serif;color:#8a8a8a;letter-spacing:.06em}
#pmt-toggle:hover{color:#fff;border-color:var(--pmt-accent)}
#pmt-drag{flex:0 0 6px;width:6px;align-self:stretch;position:sticky;top:0;height:100vh;cursor:col-resize;touch-action:none;background:#0000}
#pmt-drag:hover,#pmt-drag.dragging{background:#6cb6ff66}
#pmt-nav a{display:block;color:inherit;text-decoration:none;border-radius:4px;padding:3px 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-left:2px solid #0000}
#pmt-nav a:hover{background:#ffffff12;color:#fff}
#pmt-nav a.on{color:var(--pmt-accent);background:#6cb6ff1a;border-left-color:var(--pmt-accent)}
#pmt-nav a.l1{font-weight:600;font-size:13.5px;margin-top:2px}
#pmt-nav a.l2{padding-left:16px}
#pmt-nav a.l3{padding-left:28px}
#pmt-nav a.l4{padding-left:40px;font-size:12.5px}
#pmt-nav a.l5{padding-left:52px;font-size:12.5px}
#pmt-nav a.l6{padding-left:64px;font-size:12.5px;color:#9a9a9a}
body.pmt-hidden #pmt,body.pmt-hidden #pmt-drag{display:none}
body.pmt-hidden #pmt-title{display:none}
h1,h2,h3,h4,h5,h6{scroll-margin-top:16px}
@media print{#pmt,#pmt-drag,#pmt-toggle,#pmt-title{display:none}}
@media (max-width:900px){
  #pmt{position:fixed;left:0;top:0;bottom:0;height:100%;max-width:78vw;z-index:30;box-shadow:0 0 26px #000c}
  #pmt-drag{display:none;flex:0 0 0;width:0}
  #pmt-inner{max-width:none;padding:24px 18px}
  /* 窄屏正文从左边开始，开关让到右上角避免压住标题；「目录」标签由抽屉自己承担 */
  #pmt-toggle{left:auto;right:12px}
  #pmt-title{display:none}
}
`;

const CLIENT_JS = `
(function(){
  var KEY='pi-live-preview-toc', DEF={hidden:false,width:${W_DEFAULT}}, MIN=${W_MIN}, MAX=${W_MAX};
  var body=document.body, root=document.documentElement;
  var aside=document.getElementById('pmt'), drag=document.getElementById('pmt-drag'), btn=document.getElementById('pmt-toggle');
  var nav=document.getElementById('pmt-nav'), main=document.getElementById('pmt-main');
  if(!aside||!drag||!btn||!nav) return;
  var narrow=window.matchMedia('(max-width:900px)');
  var st=null; try{st=JSON.parse(localStorage.getItem(KEY)||'null');}catch(e){}
  if(!st||typeof st!=='object') st={};
  var width=Math.min(MAX,Math.max(MIN,Number(st.width)||DEF.width));
  var hidden=(typeof st.hidden==='boolean')?st.hidden:(narrow.matches?true:DEF.hidden);
  var links=[].slice.call(nav.querySelectorAll('a[data-t]'));
  var targets=links.map(function(a){return document.getElementById(a.getAttribute('data-t'));});
  function save(){try{localStorage.setItem(KEY,JSON.stringify({hidden:hidden,width:width}));}catch(e){}}
  function apply(){
    root.style.setProperty('--pmt-w',width+'px');
    body.classList.toggle('pmt-hidden',!!hidden);
    btn.textContent=hidden?'\\u2630':'\\u2039';
    btn.title=(hidden?'显示标题导航':'隐藏标题导航')+' （Ctrl/Cmd+\\\\）';
    btn.setAttribute('aria-expanded',String(!hidden));
    btn.setAttribute('aria-controls','pmt');
  }
  function markActive(a,keep){
    for(var i=0;i<links.length;i++){ links[i].classList.toggle('on',links[i]===a); }
    if(!a||keep) return;
    if(a.offsetTop<aside.scrollTop||a.offsetTop+a.offsetHeight>aside.scrollTop+aside.clientHeight)
      aside.scrollTop=Math.max(0,a.offsetTop-aside.clientHeight/2);
  }
  function spy(){
    var y=window.innerHeight*0.2, idx=0;
    for(var i=0;i<targets.length;i++){ var t=targets[i]; if(!t) continue; if(t.getBoundingClientRect().top-y<=0) idx=i; else break; }
    markActive(links[idx]);
  }
  var ticking=false;
  function onScroll(){ if(ticking) return; ticking=true; requestAnimationFrame(function(){ticking=false;spy();}); }
  function jump(a){
    var t=document.getElementById(a.getAttribute('data-t')); if(!t) return;
    history.replaceState(null,'','#'+encodeURIComponent(t.id));
    t.scrollIntoView({behavior:'smooth',block:'start'});
    markActive(a);
    if(narrow.matches){ hidden=true; apply(); save(); }
  }
  nav.addEventListener('click',function(e){
    var a=e.target.closest?e.target.closest('a[data-t]'):null; if(!a) return;
    e.preventDefault(); jump(a);
  });
  btn.addEventListener('click',function(){ hidden=!hidden; apply(); save(); });
  document.addEventListener('keydown',function(e){
    if((e.ctrlKey||e.metaKey)&&(e.key==='\\\\'||e.key==='|')){ e.preventDefault(); hidden=!hidden; apply(); save(); }
  });
  drag.addEventListener('pointerdown',function(e){
    e.preventDefault(); drag.classList.add('dragging');
    var sx=e.clientX, sw=width, id=e.pointerId;
    try{ drag.setPointerCapture(id); }catch(_){}
    function mv(ev){ width=Math.min(MAX,Math.max(MIN,sw+(ev.clientX-sx))); apply(); }
    function up(){ drag.classList.remove('dragging');
      drag.removeEventListener('pointermove',mv); drag.removeEventListener('pointerup',up); drag.removeEventListener('pointercancel',up); save(); }
    drag.addEventListener('pointermove',mv); drag.addEventListener('pointerup',up); drag.addEventListener('pointercancel',up);
  });
  drag.addEventListener('dblclick',function(){ width=DEF.width; apply(); save(); });
  var rz=null;
  if(narrow.addEventListener) narrow.addEventListener('change',function(){
    if(rz) clearTimeout(rz); rz=setTimeout(function(){ var s=null; try{s=JSON.parse(localStorage.getItem(KEY)||'null');}catch(e){}
      if(!s||typeof s.hidden!=='boolean'){ hidden=narrow.matches; apply(); } },150);
  });
  apply();
  var h=''; try{ h=decodeURIComponent(String(location.hash||'').replace(/^#/,'')); }catch(e){ h=String(location.hash||'').replace(/^#/,''); }
  if(h){ for(var i=0;i<links.length;i++){ if(links[i].getAttribute('data-t')===h){ markActive(links[i],true); break; } } }
  window.addEventListener('scroll',onScroll,{passive:true});
  spy();
})();
`;

function escapeEndTags(s) {
	return String(s).replace(/<\/(style|script)/gi, "<\\/$1");
}

function escAttr(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function labelOf(inner) {
	const t = String(inner)
		.replace(/<[^>]*>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return t || "未命名章节";
}

function slugOf(label) {
	const decoded = String(label)
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
	const s = decoded
		.replace(/[\s\u3000]+/g, "-")
		.replace(/[^\p{L}\p{N}_-]+/gu, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return s || "section";
}

/**
 * 给一份已生成的 markdown HTML 加上标题 id 与左侧导航。
 * 找不到注入锚点（或标题不足 2 个）时原样返回。
 * @param {string} html renderMarkdown() 的产物
 * @returns {string}
 */
export function enhanceMarkdownHtml(html) {
	const src = String(html ?? "");
	if (!src) return src;
	if (src.includes('id="pmt"')) return src;
	if (/<h[1-6][^>]*\sid\s*=/.test(src)) return src;

	const heads = [];
	const used = new Map();
	const out = src.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g, (full, lv, attrs, inner) => {
		const level = Number(lv);
		const label = labelOf(inner);
		const existing = /\sid\s*=\s*"([^"]*)"/.exec(attrs);
		let id;
		if (existing) {
			id = existing[1];
			used.set(id, (used.get(id) ?? 0) + 1);
		} else {
			const base = slugOf(label);
			const n = (used.get(base) ?? 0) + 1;
			used.set(base, n);
			id = n === 1 ? base : `${base}-${n}`;
		}
		heads.push({ level, id, label });
		const rest = existing ? attrs : ` id="${escAttr(id)}"`;
		return `<h${level}${rest}>${inner}</h${level}>`;
	});

	if (heads.length < 2) return src;

	const navItems = heads
		.map(
			(h) =>
				`<a class="l${h.level}" data-t="${escAttr(h.id)}" href="#${escAttr(encodeURIComponent(h.id))}" title="${escAttr(h.label)}">${h.label}</a>`,
		)
		.join("");
	const aside = `<aside id="pmt"><nav id="pmt-nav" aria-label="标题导航">${navItems}</nav></aside>`;
	const chrome =
		`<div id="pmt-title">目录</div><button id="pmt-toggle" type="button" aria-controls="pmt"></button>` +
		aside +
		`<div id="pmt-drag" role="separator" aria-orientation="vertical" aria-label="调整导航栏宽度" title="拖动调整宽度（双击复位）"></div>` +
		`<main id="pmt-main"><div id="pmt-inner">`;

	const styleAt = out.indexOf("</style>");
	const headBodyAt = out.indexOf("</head><body>");
	const bodyEndAt = out.lastIndexOf("</body></html>");
	if (styleAt < 0 || headBodyAt < 0 || bodyEndAt < 0) return src;

	let res = out.slice(0, styleAt) + escapeEndTags(CSS) + out.slice(styleAt);
	res = res.replace("</head><body>", `</head><body>${chrome}`);
	res = res.replace("</body></html>", `</div></main><script>${escapeEndTags(CLIENT_JS)}</script></body></html>`);
	return res;
}
