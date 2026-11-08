import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const SCROLLBAR_CSS = `
::-webkit-scrollbar {
  width: 4px !important;
  height: 4px !important;
}
::-webkit-scrollbar-track {
  background: transparent !important;
}
::-webkit-scrollbar-thumb {
  background: rgba(91, 140, 255, 0.45) !important;
  border-radius: 4px !important;
  transition: all 0.2s ease !important;
}
::-webkit-scrollbar-thumb:hover {
  background: #5b8cff !important;
  box-shadow: 0 0 6px rgba(91, 140, 255, 0.8) !important;
}
::-webkit-scrollbar-corner {
  background: transparent !important;
}
`;

export function getDockScript(): string {
	const candidates = [
		path.join(here, "..", "renderer", "dock.js"),
		path.join(here, "..", "..", "browser", "renderer", "dock.js"),
		path.join(here, "dock.js"),
	];
	for (const p of candidates) {
		try {
			if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
		} catch {}
	}
	return INLINE_DOCK_SCRIPT;
}

const INLINE_DOCK_SCRIPT = `
(function () {
  if (window.__AIB_DOCK__) return;
  if (location.protocol === "file:" && location.pathname.includes("newtab.html")) return;
  if (location.pathname.includes("shell.html")) return;
  window.__AIB_DOCK__ = true;

  const host = document.createElement("div");
  host.id = "ai-browser-dock-host";
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = \`
    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
    .dock-container {
      position: absolute;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      pointer-events: auto;
      opacity: 0.35;
      transition: opacity 0.25s ease;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    }
    .dock-container:hover { opacity: 1; }
    .dock-main-btn {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #2a2d36;
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: #e6e8ee;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
      transition: transform 0.15s ease, background 0.15s ease;
    }
    .dock-main-btn:hover { background: #353945; transform: scale(1.08); }
    .dock-expanded-menu {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      max-height: 0;
      opacity: 0;
      overflow: hidden;
      pointer-events: none;
      transition: max-height 0.32s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.2s ease;
    }
    .dock-container:hover .dock-expanded-menu { max-height: 180px; opacity: 1; pointer-events: auto; }
    .dock-sub-btn {
      width: 26px;
      height: 26px;
      border-radius: 50%;
      background: #2a2d36;
      border: 1px solid rgba(255, 255, 255, 0.10);
      color: #8b90a0;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .dock-sub-btn:hover { background: #5b8cff; color: #ffffff; transform: scale(1.12); }
    .dock-sub-btn.star:hover { background: #f59e0b; color: #ffffff; box-shadow: 0 0 10px rgba(245, 158, 11, 0.6); }
    .dock-sub-btn.starred { color: #f59e0b; border-color: #f59e0b; }
    .toast-box {
      position: fixed;
      bottom: 74px;
      right: 28px;
      background: rgba(30, 32, 38, 0.95);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: #e6e8ee;
      padding: 8px 16px;
      border-radius: 10px;
      font-size: 13px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      pointer-events: none;
      opacity: 0;
      transform: translateY(8px);
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      display: flex;
      align-items: center;
      gap: 8px;
      z-index: 2147483647;
    }
    .toast-box.show { opacity: 1; transform: translateY(0); }
  \`;

  const dock = document.createElement("div");
  dock.className = "dock-container";
  dock.style.right = "28px";
  dock.style.bottom = "28px";
  dock.innerHTML = \`
    <div class="dock-expanded-menu">
      <button id="btn-md" class="dock-sub-btn" title="复制当前页面 Markdown (Ctrl+Shift+C)">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
      </button>
      <button id="btn-fwd" class="dock-sub-btn" title="前进 (Alt+→)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
      <button id="btn-back" class="dock-sub-btn" title="后退 (Alt+←)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
    </div>
    <button id="btn-main" class="dock-main-btn" title="刷新页面 / 展开导航 (按住可拖动)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
    </button>
  \`;

  const toast = document.createElement("div");
  toast.className = "toast-box";
  toast.id = "dock-toast";

  shadow.appendChild(style);
  shadow.appendChild(dock);
  shadow.appendChild(toast);

  let toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.classList.remove("show"); }, 2400);
  }

  function mount() {
    if (!document.body) { window.addEventListener("DOMContentLoaded", mount); return; }
    document.body.appendChild(host);
  }
  mount();

  try {
    const saved = localStorage.getItem("__aib_dock_pos");
    if (saved) {
      const { right, bottom } = JSON.parse(saved);
      dock.style.right = right + "px";
      dock.style.bottom = bottom + "px";
      toast.style.right = right + "px";
      toast.style.bottom = (bottom + 46) + "px";
    }
  } catch (_) {}

  shadow.getElementById("btn-back")?.addEventListener("click", () => history.back());
  shadow.getElementById("btn-fwd")?.addEventListener("click", () => history.forward());

  shadow.getElementById("btn-md")?.addEventListener("click", async () => {
    try {
      const md = "# " + document.title + "\\n\\n来源：" + location.href + "\\n\\n" + ((document.body ? document.body.innerText : "")).slice(0, 30000);
      await navigator.clipboard.writeText(md);
      showToast("📝 已成功复制正文 Markdown！");
    } catch (_) {
      showToast("⚠️ 复制 Markdown 失败");
    }
  });

  let isDragging = false;
  let hasMoved = false;
  let startX = 0;
  let startY = 0;
  let initialRight = 28;
  let initialBottom = 28;

  shadow.getElementById("btn-main")?.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    hasMoved = false;
    startX = e.clientX;
    startY = e.clientY;
    const s = window.getComputedStyle(dock);
    initialRight = parseInt(s.right, 10) || 28;
    initialBottom = parseInt(s.bottom, 10) || 28;
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
    const r = Math.max(12, Math.min(window.innerWidth - 44, initialRight - dx));
    const b = Math.max(12, Math.min(window.innerHeight - 44, initialBottom - dy));
    dock.style.right = r + "px";
    dock.style.bottom = b + "px";
    toast.style.right = r + "px";
    toast.style.bottom = (b + 46) + "px";
    try {
      localStorage.setItem("__aib_dock_pos", JSON.stringify({ right: r, bottom: b }));
    } catch (_) {}
  });

  window.addEventListener("mouseup", () => { isDragging = false; });

  shadow.getElementById("btn-main")?.addEventListener("click", (e) => {
    if (hasMoved) { e.preventDefault(); e.stopPropagation(); return; }
    location.reload();
  });
})();
`;

export const DOCK_SCRIPT = getDockScript();
