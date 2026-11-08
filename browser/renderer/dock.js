/**
 * AI Browser - B3 右下角悬浮展开圆钮 (FAB Dock)
 * 集成：刷新、后退、前进、收藏弹窗选择目录、复制 Markdown 与自由拖动
 * 移植自 E:\ai-browser\src\dock.js
 */
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
	style.textContent = `
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
    .dock-container:hover {
      opacity: 1;
    }
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
    .dock-main-btn:hover {
      background: #353945;
      transform: scale(1.08);
    }
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
    .dock-container:hover .dock-expanded-menu {
      max-height: 180px;
      opacity: 1;
      pointer-events: auto;
    }
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
    .dock-sub-btn:hover {
      background: #5b8cff;
      color: #ffffff;
      transform: scale(1.12);
    }
    .dock-sub-btn.star:hover {
      background: #f59e0b;
      color: #ffffff;
      box-shadow: 0 0 10px rgba(245, 158, 11, 0.6);
    }
    .dock-sub-btn.starred {
      color: #f59e0b;
      border-color: #f59e0b;
    }

    /* 优雅轻量提示条 (Toast) */
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
    .toast-box.show {
      opacity: 1;
      transform: translateY(0);
    }

    /* 收藏弹窗 (Bookmark Modal) 样式 */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2147483646;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    }
    .modal-backdrop.show {
      opacity: 1;
      pointer-events: auto;
    }
    .modal-dialog {
      width: 400px;
      max-width: 92vw;
      background: #181a20;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 14px;
      box-shadow: 0 20px 55px rgba(0, 0, 0, 0.7);
      padding: 22px;
      transform: scale(0.94) translateY(12px);
      transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
      display: flex;
      flex-direction: column;
      gap: 16px;
      color: #e6e8ee;
      font-size: 13px;
    }
    .modal-backdrop.show .modal-dialog {
      transform: scale(1) translateY(0);
    }
    .modal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding-bottom: 12px;
    }
    .modal-title {
      font-size: 15px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
      color: #ffffff;
    }
    .modal-close-btn {
      background: transparent;
      border: none;
      color: #8b90a0;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      width: 24px;
      height: 24px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
    }
    .modal-close-btn:hover {
      color: #ffffff;
      background: rgba(255, 255, 255, 0.12);
    }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .form-label-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .form-label {
      font-size: 12px;
      color: #8b90a0;
      font-weight: 500;
    }
    .form-btn-link {
      background: transparent;
      border: none;
      color: #5b8cff;
      font-size: 12px;
      cursor: pointer;
      padding: 0;
      transition: color 0.15s ease;
    }
    .form-btn-link:hover {
      color: #8ab0ff;
      text-decoration: underline;
    }
    .form-input, .form-select {
      background: #111216;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      padding: 9px 12px;
      color: #ffffff;
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
      font-family: inherit;
      width: 100%;
    }
    .form-input:focus, .form-select:focus {
      border-color: #5b8cff;
      box-shadow: 0 0 0 2px rgba(91, 140, 255, 0.25);
    }
    .form-input[readonly] {
      color: #8b90a0;
      background: rgba(255, 255, 255, 0.03);
      cursor: default;
    }
    .form-select option {
      background: #181a20;
      color: #e6e8ee;
      padding: 6px;
    }
    .new-folder-inline {
      display: flex;
      gap: 8px;
      margin-top: 6px;
      padding: 8px;
      background: rgba(255, 255, 255, 0.04);
      border-radius: 8px;
      border: 1px dashed rgba(255, 255, 255, 0.15);
    }
    .btn {
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 12.5px;
      cursor: pointer;
      border: none;
      transition: all 0.15s ease;
      font-family: inherit;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      white-space: nowrap;
    }
    .btn-primary {
      background: #5b8cff;
      color: #ffffff;
      font-weight: 500;
    }
    .btn-primary:hover {
      background: #4a7ae8;
    }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: #e6e8ee;
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.14);
    }
    .btn-danger {
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.25);
      color: #ef4444;
    }
    .btn-danger:hover {
      background: rgba(239, 68, 68, 0.22);
      color: #ff6b6b;
    }
    .btn-ghost {
      background: transparent;
      color: #8b90a0;
    }
    .btn-ghost:hover {
      color: #ffffff;
      background: rgba(255, 255, 255, 0.06);
    }
    .modal-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 4px;
    }
    .modal-actions-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }
  `;

	// 1. 构建悬浮圆钮 Dock 容器
	const dock = document.createElement("div");
	dock.className = "dock-container";
	dock.style.right = "28px";
	dock.style.bottom = "28px";

	dock.innerHTML = `
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
      <button id="btn-star" class="dock-sub-btn star" title="收藏此页面 (Ctrl+D)">
        <svg id="star-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
      </button>
    </div>
    <button id="btn-main" class="dock-main-btn" title="刷新页面 / 展开导航 (按住可拖动)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
    </button>
  `;

	// 2. 构建优雅提示条 Toast
	const toast = document.createElement("div");
	toast.className = "toast-box";
	toast.id = "dock-toast";

	// 3. 构建收藏选择弹窗 Modal
	const modal = document.createElement("div");
	modal.className = "modal-backdrop";
	modal.id = "bm-modal";
	modal.innerHTML = `
    <div class="modal-dialog">
      <div class="modal-head">
        <div class="modal-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="#f59e0b" stroke="#f59e0b" stroke-width="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
          <span id="bm-dialog-title">添加收藏</span>
        </div>
        <button class="modal-close-btn" id="bm-btn-close" title="关闭 (Esc)">&times;</button>
      </div>

      <div class="form-group">
        <label class="form-label" for="bm-input-name">名称</label>
        <input type="text" id="bm-input-name" class="form-input" placeholder="网页标题" spellcheck="false" />
      </div>

      <div class="form-group">
        <label class="form-label" for="bm-input-url">网址</label>
        <input type="text" id="bm-input-url" class="form-input" readonly spellcheck="false" />
      </div>

      <div class="form-group">
        <div class="form-label-row">
          <label class="form-label" for="bm-select-folder">保存位置 (文件夹)</label>
          <button type="button" class="form-btn-link" id="bm-btn-show-new-folder">+ 新建文件夹</button>
        </div>
        <select id="bm-select-folder" class="form-select">
          <option value='["全部收藏"]'>📁 全部收藏</option>
        </select>
        
        <div class="new-folder-inline" id="bm-new-folder-wrap" style="display: none;">
          <input type="text" id="bm-input-new-folder" class="form-input" placeholder="输入文件夹名称…" style="flex:1;" />
          <button type="button" class="btn btn-secondary" id="bm-btn-confirm-new-folder">创建</button>
          <button type="button" class="btn btn-ghost" id="bm-btn-cancel-new-folder">取消</button>
        </div>
      </div>

      <div class="modal-actions">
        <div>
          <button type="button" class="btn btn-danger" id="bm-btn-remove" style="display: none;">移除收藏</button>
        </div>
        <div class="modal-actions-right">
          <button type="button" class="btn btn-ghost" id="bm-btn-cancel">取消</button>
          <button type="button" class="btn btn-primary" id="bm-btn-save">完成</button>
        </div>
      </div>
    </div>
  `;

	shadow.appendChild(style);
	shadow.appendChild(dock);
	shadow.appendChild(toast);
	shadow.appendChild(modal);

	let toastTimer = null;
	function showToast(msg) {
		toast.textContent = msg;
		toast.classList.add("show");
		if (toastTimer) clearTimeout(toastTimer);
		toastTimer = setTimeout(() => {
			toast.classList.remove("show");
		}, 2400);
	}

	function mount() {
		if (!document.body) {
			window.addEventListener("DOMContentLoaded", mount);
			return;
		}
		document.body.appendChild(host);
	}
	mount();

	// 恢复拖动位置
	try {
		const saved = localStorage.getItem("__aib_dock_pos");
		if (saved) {
			const { right, bottom } = JSON.parse(saved);
			dock.style.right = right + "px";
			dock.style.bottom = bottom + "px";
			toast.style.right = right + "px";
			toast.style.bottom = bottom + 46 + "px";
		}
	} catch (_) {}

	// 中心化书签能力与状态管理
	const starBtn = shadow.getElementById("btn-star");
	const starIcon = shadow.getElementById("star-icon");

	function setStarStatus(isStarred) {
		if (isStarred) {
			starBtn.classList.add("starred");
			starIcon.setAttribute("fill", "currentColor");
		} else {
			starBtn.classList.remove("starred");
			starIcon.setAttribute("fill", "none");
		}
	}

	async function refreshBookmarkState() {
		const url = location.href;
		if (!url || url.startsWith("file://") || url.startsWith("about:")) {
			setStarStatus(false);
			return;
		}
		try {
			const saved = localStorage.getItem("__aib_stars");
			if (saved) {
				const list = JSON.parse(saved);
				setStarStatus(Array.isArray(list) && list.some((item) => item.url === url));
			}
		} catch (_) {}
	}
	refreshBookmarkState();

	// 收藏弹窗交互逻辑
	const dialogTitle = shadow.getElementById("bm-dialog-title");
	const inputName = shadow.getElementById("bm-input-name");
	const inputUrl = shadow.getElementById("bm-input-url");
	const selectFolder = shadow.getElementById("bm-select-folder");
	const btnRemove = shadow.getElementById("bm-btn-remove");
	const btnSave = shadow.getElementById("bm-btn-save");
	const btnClose = shadow.getElementById("bm-btn-close");
	const btnCancel = shadow.getElementById("bm-btn-cancel");
	const btnShowNewFolder = shadow.getElementById("bm-btn-show-new-folder");
	const newFolderWrap = shadow.getElementById("bm-new-folder-wrap");
	const inputNewFolder = shadow.getElementById("bm-input-new-folder");
	const btnConfirmNewFolder = shadow.getElementById("bm-btn-confirm-new-folder");
	const btnCancelNewFolder = shadow.getElementById("bm-btn-cancel-new-folder");

	let currentFolders = [{ name: "全部收藏", path: ["全部收藏"], pathStr: "全部收藏", level: 1 }];
	let isEditing = false;

	async function openBookmarkModal() {
		const url = location.href;
		if (!url || url.startsWith("file://") || url.startsWith("about:")) {
			showToast("⚠️ 当前页面无需收藏");
			return;
		}

		const currentTitle = document.title || location.hostname || "未命名网页";
		inputUrl.value = url;
		inputName.value = currentTitle;

		newFolderWrap.style.display = "none";
		inputNewFolder.value = "";

		try {
			const savedFolders = localStorage.getItem("__aib_folders");
			if (savedFolders) currentFolders = JSON.parse(savedFolders);
		} catch (_) {}

		let found = false;
		try {
			const saved = localStorage.getItem("__aib_stars");
			if (saved) {
				const list = JSON.parse(saved);
				const existing = list.find((item) => item.url === url);
				if (existing) {
					found = true;
					if (existing.name) inputName.value = existing.name;
				}
			}
		} catch (_) {}

		isEditing = found;
		dialogTitle.textContent = isEditing ? "编辑收藏" : "添加收藏";
		btnRemove.style.display = isEditing ? "inline-flex" : "none";

		renderFolderOptions();
		modal.classList.add("show");
		setTimeout(() => {
			inputName.focus();
			inputName.select();
		}, 100);
	}

	function renderFolderOptions() {
		selectFolder.innerHTML = "";
		currentFolders.forEach((f) => {
			const opt = document.createElement("option");
			opt.value = JSON.stringify(f.path || [f.name]);
			const indent = "\u00A0\u00A0".repeat(Math.max(0, (f.level || 1) - 1));
			opt.textContent = `${indent}📁 ${f.name}`;
			selectFolder.appendChild(opt);
		});
	}

	function closeBookmarkModal() {
		modal.classList.remove("show");
	}

	async function handleSaveBookmark() {
		const url = inputUrl.value.trim();
		const name = inputName.value.trim() || document.title || "网页";
		let folderPath = ["全部收藏"];
		try {
			folderPath = JSON.parse(selectFolder.value);
		} catch (_) {}

		try {
			const saved = localStorage.getItem("__aib_stars") || "[]";
			let list = JSON.parse(saved);
			list = list.filter((item) => item.url !== url);
			list.push({ url, name, folder: folderPath, time: Date.now() });
			localStorage.setItem("__aib_stars", JSON.stringify(list));
		} catch (_) {}

		closeBookmarkModal();
		setStarStatus(true);
		showToast("★ 收藏成功！");
	}

	async function handleRemoveBookmark() {
		const url = inputUrl.value.trim();
		try {
			const saved = localStorage.getItem("__aib_stars") || "[]";
			const list = JSON.parse(saved).filter((item) => item.url !== url);
			localStorage.setItem("__aib_stars", JSON.stringify(list));
		} catch (_) {}
		closeBookmarkModal();
		setStarStatus(false);
		showToast("已从收藏夹移除");
	}

	btnShowNewFolder.addEventListener("click", () => {
		newFolderWrap.style.display = "flex";
		inputNewFolder.value = "";
		inputNewFolder.focus();
	});

	btnCancelNewFolder.addEventListener("click", () => {
		newFolderWrap.style.display = "none";
	});

	btnConfirmNewFolder.addEventListener("click", () => {
		const folderName = inputNewFolder.value.trim();
		if (!folderName) {
			inputNewFolder.focus();
			return;
		}
		currentFolders.push({ name: folderName, path: [folderName], pathStr: folderName, level: 1 });
		try {
			localStorage.setItem("__aib_folders", JSON.stringify(currentFolders));
		} catch (_) {}
		renderFolderOptions();
		newFolderWrap.style.display = "none";
		showToast(`📁 文件夹「${folderName}」已创建`);
	});

	inputNewFolder.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			btnConfirmNewFolder.click();
		} else if (e.key === "Escape") {
			newFolderWrap.style.display = "none";
		}
	});

	btnClose.addEventListener("click", closeBookmarkModal);
	btnCancel.addEventListener("click", closeBookmarkModal);
	btnSave.addEventListener("click", handleSaveBookmark);
	btnRemove.addEventListener("click", handleRemoveBookmark);

	modal.addEventListener("click", (e) => {
		if (e.target === modal) closeBookmarkModal();
	});

	modal.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			closeBookmarkModal();
		} else if (e.key === "Enter" && e.target !== inputNewFolder) {
			e.preventDefault();
			handleSaveBookmark();
		}
	});

	// 基础按钮交互
	shadow.getElementById("btn-back")?.addEventListener("click", () => history.back());
	shadow.getElementById("btn-fwd")?.addEventListener("click", () => history.forward());
	shadow.getElementById("btn-star")?.addEventListener("click", openBookmarkModal);

	shadow.getElementById("btn-md")?.addEventListener("click", async () => {
		let md = "";
		try {
			md = `# ${document.title}\n\n来源：${location.href}\n\n${(document.body ? document.body.innerText : "").slice(0, 30000)}`;
			await navigator.clipboard.writeText(md);
			showToast("📝 已成功复制正文 Markdown！");
		} catch (_) {
			showToast("⚠️ 复制 Markdown 失败");
		}
	});

	// 拖动与刷新：拖动不触发刷新，单击触发刷新
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
		toast.style.bottom = b + 46 + "px";
		try {
			localStorage.setItem("__aib_dock_pos", JSON.stringify({ right: r, bottom: b }));
		} catch (_) {}
	});

	window.addEventListener("mouseup", () => {
		isDragging = false;
	});

	shadow.getElementById("btn-main")?.addEventListener("click", (e) => {
		if (hasMoved) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		location.reload();
	});
})();
