/**
 * AI Browser - 右下角悬浮展开圆钮 (FAB Dock)
 * 集成：刷新、后退、前进、收藏弹窗选择目录、复制 Markdown 与自由拖动
 * 移植自 E:\ai-browser\src\dock.js
 *
 * 「站点怎么折腾都得看得见」的六条底线：
 * 1. **挂在 top layer**（`popover="manual"` + `showPopover()`）：不参与页面的层叠上下文。
 *    站点的 z-index 战争、祖先的 `transform`/`filter`/`contain`（那会让 `position:fixed`
 *    退化成相对定位、跟着页面滚走）、`overflow: hidden` 的裁剪，统统影响不到它。
 * 2. **全屏之后重开一次**：`requestFullscreen` 把元素塞进顶层，`fullscreenchange` 里
 *    `hidePopover()` + `showPopover()` 让我们排在顶层最后一个 → 压在视频/全屏元素之上。
 * 3. **被摘掉就挂回去**：MutationObserver 盯 `documentElement` 与 `body` 的直接子节点，
 *    外加 1 秒一次的看门狗（SPA 清空 body、页面 `remove()` 宿主、改写宿主 inline 样式、
 *    主动 `hidePopover()`，都会在下一拍恢复）。
 * 4. **整段 DOM 只用 createElement 建，不碰 innerHTML**：Google 系站点开着
 *    `require-trusted-types-for 'script'` 且限制了 policy 名，`createPolicy` 也建不出来，
 *    旧实现 `setMarkup()` 一失败整个 dock 连按钮都没有——这才是「某些网站上看不见」
 *    最常见的原因。样式同理优先走 `adoptedStyleSheets`（构造式样式表不受页面 CSP
 *    `style-src` 管），拿不到才退回 `<style>`。
 * 5. **位置按当前视口夹一遍**：拖出来的坐标按 origin 存在 `localStorage` 里，宽窗口拖到右边、
 *    换窄窗口（分栏 / 小屏）恢复时就成了屏幕外——「只有某个站看不见」多半是这个，不是站点压住了。
 * 6. **一列钮一样大、悬停不放大、不被边缘切掉**：主钮 / 菜单钮 / 下载钮统一 32px，悬停只换底色；
 *    主钮贴在视口顶边时整列翻转（主钮在上、菜单往下长），窗口矮到装不下一列就把展开上限压小并可滚。
 *
 * 兜底：top layer 不支持 / 开不出来时退回 `position:fixed` + `z-index:2147483647`
 * （不比旧实现差），失败原因不抛给页面；看门狗还会查「到底在不在屏幕上」，
 * 被站点藏了就自己救回来。
 *
 * 插槽：`window.__AIB_DOCK__.slot(id)` 给同源的页面脚本（下载圆钮 `downloads.js`）留的位置，
 * 让它和刷新钮住在同一列、一起拖动。
 */
(function () {
	const existingDock = window.__AIB_DOCK__;
	if (existingDock && existingDock.ready && typeof existingDock.remount === "function") {
		existingDock.remount();
		return;
	}
	// 内部页（`file://` 的 shell.html / newtab.html）不注入。**必须连协议一起判**：只看 pathname
	// 会把 `https://github.com/<owner>/<repo>/blob/main/browser/renderer/shell.html` 这类正常网页
	// 当成内部页，整颗钮凭空消失。
	if (location.protocol === "file:" && /(?:^|\/)(?:shell|newtab)\.html$/i.test(location.pathname)) return;
	// dom-ready / did-finish-load 都会注入，先占位避免建出两个 Dock。
	window.__AIB_DOCK__ = {
		ready: false,
		remount() {},
		slot() {
			return null;
		},
	};

	const SVG_NS = "http://www.w3.org/2000/svg";

	/** 建元素：只认 tag/class/属性，绝不走 innerHTML（见文件头第 4 条）。 */
	function h(tag, className, props) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (props) {
			for (const key of Object.keys(props)) {
				const value = props[key];
				if (value === undefined || value === null) continue;
				if (key === "text") node.textContent = String(value);
				else node.setAttribute(key, String(value));
			}
		}
		return node;
	}

	/** 图标：`shapes` 是 `[标签, 属性表]` 列表，全走 createElementNS（SVG 不是 HTML 元素）。 */
	function icon(size, shapes, paint) {
		const root = document.createElementNS(SVG_NS, "svg");
		root.setAttribute("width", String(size));
		root.setAttribute("height", String(size));
		root.setAttribute("viewBox", "0 0 24 24");
		root.setAttribute("fill", (paint && paint.fill) || "none");
		root.setAttribute("stroke", (paint && paint.stroke) || "currentColor");
		root.setAttribute("stroke-width", "2");
		for (const entry of shapes) {
			const node = document.createElementNS(SVG_NS, entry[0]);
			const attrs = entry[1] || {};
			for (const key of Object.keys(attrs)) node.setAttribute(key, attrs[key]);
			root.appendChild(node);
		}
		return root;
	}

	const ICON = {
		markdown: [
			["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" }],
			["polyline", { points: "14 2 14 8 20 8" }],
			["line", { x1: "16", y1: "13", x2: "8", y2: "13" }],
			["line", { x1: "16", y1: "17", x2: "8", y2: "17" }],
			["polyline", { points: "10 9 9 9 8 9" }],
		],
		forward: [["polyline", { points: "9 18 15 12 9 6" }]],
		back: [["polyline", { points: "15 18 9 12 15 6" }]],
		star: [
			[
				"polygon",
				{ points: "12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" },
			],
		],
		reload: [["path", { d: "M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" }]],
		translate: [
			["path", { d: "M3 5h9" }],
			["path", { d: "M7.5 3v2c0 3.5-2 6.5-5 8" }],
			["path", { d: "M5 9c1.2 2.6 3.4 4.8 6.5 5.8" }],
			["path", { d: "m12.5 21 4.5-10 4.5 10" }],
			["path", { d: "M14.2 17.5h5.6" }],
		],
	};

	const CSS = `
    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
    .dock-container {
      position: absolute;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      pointer-events: auto;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    }
    /* 主钮贴在视口顶边、上方装不下整列时翻转：主钮还在原处，菜单改成往下长（见 place()） */
    .dock-container.dock-flip {
      flex-direction: column-reverse;
    }
    /* 刷新钮不透明：它是要被看见、被点的，不该跟着站点背景淡下去 */
    .dock-slot {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
    }
    .dock-slot-item {
      position: relative;
      display: flex;
      align-items: center;
    }
    .dock-slot-item:empty {
      display: none;
    }
    /* 一列钮一样大：主钮 / 菜单钮 / 插槽里的下载钮（.pi-dl-fab）统一 32px。
       整列走同一条尺寸与间距，悬停只换底色，任何钮都不放大、不“弹一下”。 */
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
      transition: background 0.15s ease;
    }
    .dock-main-btn:hover {
      background: #353945;
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
    /* 展开上限默认 230px（5 个 32px 钮 + 4 个 6px 间距 = 184px，够放）；
       窗口矮到装不下一列时由 place() 把 --dock-menu-max 压到真实空间并允许滚动，绝不切钮 */
    .dock-container:hover .dock-expanded-menu {
      max-height: var(--dock-menu-max, 230px);
      opacity: 1;
      pointer-events: auto;
    }
    .dock-sub-btn {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #2a2d36;
      border: 1px solid rgba(255, 255, 255, 0.10);
      color: #8b90a0;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .dock-sub-btn:hover {
      background: #5b8cff;
      color: #ffffff;
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
    .dock-sub-btn.translated {
      color: #5b8cff;
      border-color: #5b8cff;
    }
    .dock-sub-btn.busy {
      color: #5b8cff;
      border-color: #5b8cff;
      animation: dock-pulse 1.1s ease-in-out infinite;
    }
    /* 呼吸态也不缩放：只让边框/外发光一亮一暗，列宽一点不抖 */
    @keyframes dock-pulse {
      50% {
        border-color: rgba(91, 140, 255, 0.35);
        box-shadow: 0 0 0 3px rgba(91, 140, 255, 0.14);
      }
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

	// 宿主：全屏铺满、不吃指针事件，具体圆钮靠 .dock-container 自己开 pointer-events。
	// 每条都带 !important——站点的作者样式（含 !important）压不过 inline !important。
	const HOST_STYLE = [
		"position:fixed",
		"inset:0",
		"width:100%",
		"height:100%",
		"margin:0",
		"padding:0",
		"border:0",
		"background:transparent",
		"overflow:visible",
		"display:block",
		"visibility:visible",
		"opacity:1",
		"pointer-events:none",
		"transform:none",
		"z-index:2147483647",
	]
		.map((rule) => `${rule} !important`)
		.join(";");

	const host = document.createElement("div");
	host.id = "ai-browser-dock-host";
	host.style.cssText = HOST_STYLE;
	const shadow = host.attachShadow({ mode: "open" });

	// 样式：构造式样式表不走页面的 CSP style-src，站点把内联样式全禁了也照样有样子。
	let adopted = false;
	try {
		if (typeof CSSStyleSheet === "function" && "adoptedStyleSheets" in shadow) {
			const sheet = new CSSStyleSheet();
			sheet.replaceSync(CSS);
			shadow.adoptedStyleSheets = [sheet];
			adopted = true;
		}
	} catch (_) {}
	if (!adopted) {
		const style = document.createElement("style");
		style.textContent = CSS;
		shadow.appendChild(style);
	}

	// 1. 构建悬浮圆钮 Dock 容器
	const dock = h("div", "dock-container");
	dock.style.right = "28px";
	dock.style.bottom = "28px";

	// 一列钮一样大，图标也一个尺寸：不用再给每个钮单独挑大小
	const ICON_SIZE = 15;
	function subButton(id, title, shapes) {
		const btn = h("button", "dock-sub-btn", { id, type: "button", title });
		btn.appendChild(icon(ICON_SIZE, shapes));
		return btn;
	}

	const menu = h("div", "dock-expanded-menu");
	const btnMd = subButton("btn-md", "复制当前页面 Markdown (Ctrl+Shift+C)", ICON.markdown);
	const btnFwd = subButton("btn-fwd", "前进 (Alt+→)", ICON.forward);
	const btnBack = subButton("btn-back", "后退 (Alt+←)", ICON.back);
	const btnStar = subButton("btn-star", "收藏此页面 (Ctrl+D)", ICON.star);
	btnStar.classList.add("star");
	const starIcon = btnStar.firstChild;
	const btnTranslate = subButton("btn-translate", "翻译此页 / 显示原文", ICON.translate);
	menu.append(btnTranslate, btnMd, btnFwd, btnBack, btnStar);

	const btnMain = h("button", "dock-main-btn", {
		id: "btn-main",
		type: "button",
		title: "刷新页面 / 展开导航 (按住可拖动)",
	});
	btnMain.appendChild(icon(ICON_SIZE, ICON.reload));
	// 插槽在菜单与刷新钮之间：菜单收起时下载钮就紧贴在刷新钮上方（两个一起看见）
	const slotBox = h("div", "dock-slot");
	dock.append(menu, slotBox, btnMain);
	const slots = new Map();
	/**
	 * 给同源的页面脚本（下载圆钮）留的插槽：塞进来的东西跟着刷新钮一起摆、一起拖动。
	 * 只认一个 id，重复调用回同一个节点。
	 */
	function slot(id) {
		if (!id) return null;
		const key = String(id);
		let node = slots.get(key);
		if (node && node.isConnected) return node;
		node = h("div", "dock-slot-item", { "data-slot": key });
		slotBox.appendChild(node);
		slots.set(key, node);
		// 列里多了一颗钮 → 重摆一次：贴在顶边时该翻转就翻转，别让新钮冒到屏幕外
		reposition();
		return node;
	}

	// 2. 构建优雅提示条 Toast
	const toast = h("div", "toast-box", { id: "dock-toast" });

	// 3. 构建收藏选择弹窗 Modal
	const modal = h("div", "modal-backdrop", { id: "bm-modal" });
	const dialog = h("div", "modal-dialog");

	const modalHead = h("div", "modal-head");
	const modalTitle = h("div", "modal-title");
	modalTitle.append(
		icon(16, ICON.star, { fill: "#f59e0b", stroke: "#f59e0b" }),
		h("span", "", { id: "bm-dialog-title", text: "添加收藏" }),
	);
	modalHead.append(
		modalTitle,
		h("button", "modal-close-btn", { id: "bm-btn-close", type: "button", title: "关闭 (Esc)", text: "×" }),
	);

	const inputName = h("input", "form-input", {
		id: "bm-input-name",
		type: "text",
		placeholder: "网页标题",
		spellcheck: "false",
	});
	const nameGroup = h("div", "form-group");
	nameGroup.append(h("label", "form-label", { for: "bm-input-name", text: "名称" }), inputName);

	const inputUrl = h("input", "form-input", {
		id: "bm-input-url",
		type: "text",
		readonly: "readonly",
		spellcheck: "false",
	});
	const urlGroup = h("div", "form-group");
	urlGroup.append(h("label", "form-label", { for: "bm-input-url", text: "网址" }), inputUrl);

	const selectFolder = h("select", "form-select", { id: "bm-select-folder" });
	selectFolder.appendChild(h("option", "", { value: '["全部收藏"]', text: "📁 全部收藏" }));
	const btnShowNewFolder = h("button", "form-btn-link", {
		id: "bm-btn-show-new-folder",
		type: "button",
		text: "+ 新建文件夹",
	});
	const folderLabelRow = h("div", "form-label-row");
	folderLabelRow.append(
		h("label", "form-label", { for: "bm-select-folder", text: "保存位置 (文件夹)" }),
		btnShowNewFolder,
	);

	const inputNewFolder = h("input", "form-input", {
		id: "bm-input-new-folder",
		type: "text",
		placeholder: "输入文件夹名称…",
	});
	inputNewFolder.style.flex = "1";
	const newFolderWrap = h("div", "new-folder-inline", { id: "bm-new-folder-wrap" });
	newFolderWrap.style.display = "none";
	newFolderWrap.append(
		inputNewFolder,
		h("button", "btn btn-secondary", { id: "bm-btn-confirm-new-folder", type: "button", text: "创建" }),
		h("button", "btn btn-ghost", { id: "bm-btn-cancel-new-folder", type: "button", text: "取消" }),
	);

	const folderGroup = h("div", "form-group");
	folderGroup.append(folderLabelRow, selectFolder, newFolderWrap);

	const modalActions = h("div", "modal-actions");
	const actionsLeft = h("div", "");
	const btnRemove = h("button", "btn btn-danger", { id: "bm-btn-remove", type: "button", text: "移除收藏" });
	btnRemove.style.display = "none";
	actionsLeft.appendChild(btnRemove);
	const actionsRight = h("div", "modal-actions-right");
	actionsRight.append(
		h("button", "btn btn-ghost", { id: "bm-btn-cancel", type: "button", text: "取消" }),
		h("button", "btn btn-primary", { id: "bm-btn-save", type: "button", text: "完成" }),
	);
	modalActions.append(actionsLeft, actionsRight);

	dialog.append(modalHead, nameGroup, urlGroup, folderGroup, modalActions);
	modal.appendChild(dialog);

	shadow.append(dock, toast, modal);

	let toastTimer = null;
	function showToast(msg) {
		toast.textContent = msg;
		toast.classList.add("show");
		if (toastTimer) clearTimeout(toastTimer);
		toastTimer = setTimeout(() => {
			toast.classList.remove("show");
		}, 2400);
	}

	// 4. 顶层宿主：进 top layer → 站点压不住；失败就退回普通 fixed（不比旧实现差）
	let popoverBroken = false;
	function popoverOpen() {
		try {
			return host.matches(":popover-open");
		} catch (_) {
			return false;
		}
	}
	function enterTopLayer() {
		if (popoverBroken) return false;
		if (typeof host.showPopover !== "function") {
			popoverBroken = true;
			return false;
		}
		try {
			if (!host.hasAttribute("popover")) {
				host.setAttribute("popover", "manual");
				// popover 的 UA 样式（fit-content / margin:auto / overflow:auto / 边框底色）必须被盖回铺满
				host.style.cssText = HOST_STYLE;
			}
			if (!popoverOpen()) host.showPopover();
			if (popoverOpen()) return true;
		} catch (_) {}
		// 开不出来（宿主不可见 / 元素已在别的顶层容器里）：摘掉属性，否则 UA 的
		// `[popover]:not(:popover-open){display:none}` 反而会把整颗钮藏掉
		popoverBroken = true;
		try {
			host.removeAttribute("popover");
			host.style.cssText = HOST_STYLE;
		} catch (_) {}
		return false;
	}
	/** 重新排到顶层末尾：全屏元素 / 页面 `<dialog>` 进顶层之后，重开一次就压回它们上面。 */
	function raiseTopLayer() {
		if (popoverBroken) return;
		try {
			if (popoverOpen()) host.hidePopover();
		} catch (_) {}
		enterTopLayer();
	}

	function assertHostStyles() {
		if (
			host.style.getPropertyPriority("display") === "important" &&
			host.style.getPropertyValue("position") === "fixed"
		) {
			return;
		}
		host.style.cssText = HOST_STYLE;
	}

	// 站点 SPA（Gemini / X 之类）会清空 body，甚至换掉整个 body：host 掉了就重新挂回去。
	let watchedBody = null;
	const mountWatcher = typeof MutationObserver === "function" ? new MutationObserver(() => ensureMounted()) : null;
	function watchBody() {
		if (!mountWatcher || watchedBody === document.body) return;
		if (watchedBody) mountWatcher.unobserve(watchedBody);
		watchedBody = document.body;
		if (watchedBody) mountWatcher.observe(watchedBody, { childList: true });
	}
	function ensureMounted() {
		const parent = document.body || document.documentElement;
		if (!parent) return false;
		assertHostStyles();
		// 进过 popover 的节点一旦离树就会被关掉，回挂后必须重新 showPopover
		if (!host.isConnected || host.parentNode !== parent) parent.appendChild(host);
		watchBody();
		enterTopLayer();
		return true;
	}

	if (mountWatcher) mountWatcher.observe(document.documentElement, { childList: true });

	function mount() {
		if (!ensureMounted()) window.addEventListener("DOMContentLoaded", mount, { once: true });
	}
	mount();
	window.__AIB_DOCK__ = { ready: true, remount: ensureMounted, slot };

	// 看门狗：站点把宿主藏了 / 摘了 / 把 popover 关了，下一拍自己回来（后台标签页不烧 CPU）
	// 页面自己 `showModal()` 的 dialog 期间我们仍然画在它上面（截图可验），只是整条链路被 site
	// 设成 inert、点不动——这是 Chromium 的定了，页面注入赢不了，不在这里挣扎。
	const WATCH_MS = 1000;
	let lastFullscreen = Boolean(document.fullscreenElement);
	/**
	 * 宿主真的在屏幕上吗：在 DOM 里不够，站点把 `display:none` / 尺寸归零同样得算看不见。
	 * 这是「某些站整颗钮看不到」的最后一道兜底——看不见就自己救回来，不赌站点怎么改的。
	 */
	function onScreen() {
		try {
			if (!host.isConnected) return false;
			const rect = host.getBoundingClientRect();
			if (!(rect.width > 0) || !(rect.height > 0)) return false;
			const style = window.getComputedStyle(host);
			return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
		} catch (_) {
			return false;
		}
	}
	function watch() {
		if (document.hidden) return;
		// 页面吞掉 fullscreenchange（监听被抢 / 事件被 stop）时，这里补一次「排到顶层末尾」
		const fullscreen = Boolean(document.fullscreenElement);
		if (fullscreen !== lastFullscreen) {
			lastFullscreen = fullscreen;
			if (fullscreen) raiseTopLayer();
		}
		ensureMounted();
		if (onScreen()) return;
		// 还被藏着：先把 inline 样式整段写回（站点可能改了 visibility / opacity / 宽高），再重开 top layer
		try {
			host.style.cssText = HOST_STYLE;
		} catch (_) {}
		ensureMounted();
		if (onScreen() || popoverBroken) return;
		// 还不行就摘掉 popover 退回普通 fixed
		popoverBroken = true;
		try {
			host.removeAttribute("popover");
			host.style.cssText = HOST_STYLE;
		} catch (_) {}
		ensureMounted();
	}
	setInterval(watch, WATCH_MS);
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden) watch();
	});
	// 全屏是「马上要看见视频」的高频场景：不等看门狗那一拍，事件里直接重排
	document.addEventListener(
		"fullscreenchange",
		() => {
			lastFullscreen = Boolean(document.fullscreenElement);
			if (lastFullscreen) raiseTopLayer();
		},
		true,
	);

	// 拖动位置：恢复时必须按**当前**视口重新夹一遍。坐标是按 origin 存的，宽窗口里拖到右下、
	// 换成窄窗口（分栏 / 小屏）再恢复就成了屏幕外——这正是「只有某个站整颗钮看不见」的常见成因。
	const EDGE = 12; // 圆钮距视口边缘的最小留白：左右上下都不许贴到 0
	const DOCK_GAP = 6; // 与 .dock-container / .dock-expanded-menu 的 gap 一致
	const DOCK_BTN = 32; // 与 .dock-main-btn / .dock-sub-btn / .pi-dl-fab 一致（量不到时的兜底）
	let lastSpot = { right: 28, bottom: 28 };

	function mainSize() {
		const rect = btnMain.getBoundingClientRect();
		return rect.height > 0 ? rect.height : DOCK_BTN;
	}
	/** 一段竖列的实测高度：收起态（max-height:0）的 scrollHeight 仍是内容高度，量不到就按统一尺寸推。 */
	function stackHeight(box, count) {
		const measured = box ? box.scrollHeight : 0;
		if (measured > 0) return measured;
		return count > 0 ? count * DOCK_BTN + (count - 1) * DOCK_GAP : 0;
	}
	/** 展开态整列要占多高：菜单 + 插槽（下载钮）+ 主钮，含容器 gap。 */
	function expandedHeight() {
		const parts = [stackHeight(menu, menu.children.length), stackHeight(slotBox, slotBox.children.length), mainSize()];
		let total = 0;
		for (const part of parts) if (part > 0) total += (total > 0 ? DOCK_GAP : 0) + part;
		return total;
	}
	function clampPosition(right, bottom) {
		const size = mainSize();
		const maxRight = Math.max(EDGE, window.innerWidth - EDGE - size);
		const maxBottom = Math.max(EDGE, window.innerHeight - EDGE - size);
		return {
			right: Math.max(EDGE, Math.min(maxRight, Number(right) || 28)),
			bottom: Math.max(EDGE, Math.min(maxBottom, Number(bottom) || 28)),
		};
	}
	/**
	 * 摆位：横向按视口夹；纵向默认「主钮在下、菜单往上长」。主钮贴在视口顶边时上方装不下整列，
	 * 那就翻转成「主钮在上、菜单往下长」（`column-reverse` + 把锚点从 bottom 改成 top）——
	 * **不管摆在哪，展开的钮都不许被视口边缘切掉**。
	 */
	function place(right, bottom) {
		const spot = clampPosition(right, bottom);
		lastSpot = spot;
		dock.style.right = spot.right + "px";

		const size = mainSize();
		const menuFull = stackHeight(menu, menu.children.length);
		const mainTop = window.innerHeight - spot.bottom - size;
		// 主钮之外要摆的部分（菜单 / 插槽各自带一个 gap）
		const need = Math.max(0, expandedHeight() - size);
		const above = Math.max(0, mainTop - EDGE);
		const below = Math.max(0, window.innerHeight - (mainTop + size) - EDGE);
		const flip = need > above && below > above;
		const room = flip ? below : above;

		// 两边都放不下（窗口矮到装不下一列）：把展开上限压到真实空间并允许滚动，不把钮切掉
		if (need > room) {
			const cap = Math.max(size, Math.floor(room - (need - menuFull)));
			dock.style.setProperty("--dock-menu-max", cap + "px");
			menu.style.overflowY = "auto";
		} else {
			dock.style.removeProperty("--dock-menu-max");
			menu.style.overflowY = "";
		}

		dock.classList.toggle("dock-flip", flip);
		if (flip) {
			dock.style.top = mainTop + "px";
			dock.style.bottom = "auto";
		} else {
			dock.style.top = "auto";
			dock.style.bottom = spot.bottom + "px";
		}

		// toast 跟着主钮走：正常态贴主钮上方；翻转到顶边时改到主钮左侧，免得自己也跑到屏幕外
		toast.style.right = (flip ? spot.right + size + 8 : spot.right) + "px";
		toast.style.bottom = (flip ? spot.bottom : spot.bottom + 46) + "px";
		return spot;
	}
	/** 列的内容变了（下载钮冒出来 / 收起）重新摆一次：锚点仍用上一次的坐标。 */
	function reposition() {
		place(lastSpot.right, lastSpot.bottom);
	}
	// 启动就摆一次：没存过坐标也得跑一遍 place()，否则翻转 / 空间压缩要等第一次拖动才生效
	let savedSpot = null;
	try {
		savedSpot = JSON.parse(localStorage.getItem("__aib_dock_pos") || "null");
	} catch (_) {}
	place(savedSpot && savedSpot.right, savedSpot && savedSpot.bottom);
	// 窗口变小（分栏、还原、旋屏）之后重新夹：不然又落到屏幕外
	window.addEventListener("resize", () => {
		const current = place(lastSpot.right, lastSpot.bottom);
		try {
			localStorage.setItem("__aib_dock_pos", JSON.stringify(current));
		} catch (_) {}
	});

	// 中心化书签能力与状态管理
	function setStarStatus(isStarred) {
		if (isStarred) {
			btnStar.classList.add("starred");
			starIcon.setAttribute("fill", "currentColor");
		} else {
			btnStar.classList.remove("starred");
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
	const btnSave = shadow.getElementById("bm-btn-save");
	const btnClose = shadow.getElementById("bm-btn-close");
	const btnCancel = shadow.getElementById("bm-btn-cancel");
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
		selectFolder.replaceChildren();
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

	// 全文翻译入口：翻译脚本（translate.js）负责干活，Dock 只负责点火 + 进度反馈
	function translateBridge() {
		var bridge = window.__PI_TRANSLATE__;
		return bridge && bridge.ready ? bridge : null;
	}
	function shortTranslateModel(model) {
		var text = String(model || "");
		var slash = text.lastIndexOf("/");
		return slash >= 0 ? text.slice(slash + 1) : text;
	}
	var prevTranslatePage = "";
	function paintTranslateButton(state) {
		if (!state) {
			btnTranslate.classList.remove("busy");
			btnTranslate.classList.remove("translated");
			btnTranslate.setAttribute("title", "翻译此页 / 显示原文");
			return;
		}
		var busy = state.pageState === "translating";
		var done = state.pageState === "translated";
		btnTranslate.classList.toggle("busy", busy);
		btnTranslate.classList.toggle("translated", done);
		var title = "翻译此页 / 显示原文";
		if (busy) {
			title = state.total > 0 ? "正在翻译全文（" + state.done + "/" + state.total + "）…" : "正在翻译全文…";
		} else if (done) {
			title = state.model
				? "显示原文（已用 " + shortTranslateModel(state.model) + " 翻译，再点一次还原）"
				: "显示原文（再点一次还原）";
		}
		btnTranslate.setAttribute("title", title);
	}
	function onTranslateState(state) {
		if (!state) return;
		paintTranslateButton(state);
		if (state.pageState === "translating" && prevTranslatePage !== "translating") {
			showToast(state.total > 0 ? "🌐 正在翻译全文（共 " + state.total + " 段）…" : "🌐 正在翻译全文…");
		} else if (state.pageState === "translated" && prevTranslatePage !== "translated") {
			showToast(
				"🌐 翻译完成" +
					(state.model ? " · " + shortTranslateModel(state.model) : "") +
					(state.failed > 0 ? "（" + state.failed + " 段失败，已保留原文）" : "") +
					"，再点可显示原文",
			);
		} else if (state.pageState === "original" && prevTranslatePage === "translated") {
			showToast("🌐 已恢复原文");
		} else if (state.pageState === "original" && prevTranslatePage === "translating") {
			showToast("⚠️ 翻译失败，请重试");
		}
		prevTranslatePage = state.pageState;
	}
	var translateUnsubscribe = null;
	function ensureTranslateListener() {
		var bridge = translateBridge();
		if (!bridge || typeof bridge.onState !== "function" || translateUnsubscribe) return;
		try {
			translateUnsubscribe = bridge.onState(onTranslateState);
		} catch (_) {
			translateUnsubscribe = null;
		}
	}
	// 翻译脚本通常比 Dock 晚一步注入：现在订阅一次，800ms 后再补一次（用户点按钮时也会补）
	ensureTranslateListener();
	setTimeout(ensureTranslateListener, 800);

	btnTranslate.addEventListener("click", () => {
		var bridge = translateBridge();
		if (!bridge) {
			showToast("⚠️ 当前页面不支持全文翻译（仅 http/https 网站）");
			return;
		}
		ensureTranslateListener();
		var snapshot = null;
		try {
			snapshot = typeof bridge.getState === "function" ? bridge.getState() : null;
		} catch (_) {
			snapshot = null;
		}
		if (snapshot && snapshot.pageState === "translating") {
			showToast(
				snapshot.total > 0 ? "🌐 翻译进行中（" + snapshot.done + "/" + snapshot.total + "）…" : "🌐 翻译进行中…",
			);
			return;
		}
		try {
			paintTranslateButton({ pageState: "translating", done: 0, total: 0, failed: 0, model: "" });
			var run = bridge.togglePage();
			if (run && typeof run.catch === "function") run.catch(() => showToast("⚠️ 翻译失败，请重试"));
		} catch (_) {
			showToast("⚠️ 翻译启动失败，请重试");
		}
	});

	// 基础按钮交互
	btnBack.addEventListener("click", () => history.back());
	btnFwd.addEventListener("click", () => history.forward());
	btnStar.addEventListener("click", openBookmarkModal);

	btnMd.addEventListener("click", async () => {
		try {
			const md = `# ${document.title}\n\n来源：${location.href}\n\n${(document.body ? document.body.innerText : "").slice(0, 30000)}`;
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

	btnMain.addEventListener("mousedown", (e) => {
		if (e.button !== 0) return;
		isDragging = true;
		hasMoved = false;
		startX = e.clientX;
		startY = e.clientY;
		// 锚点只认 lastSpot：翻转态 inline 的 bottom 是 auto，读样式会把它当回 28
		initialRight = lastSpot.right;
		initialBottom = lastSpot.bottom;
		e.preventDefault();
	});

	window.addEventListener("mousemove", (e) => {
		if (!isDragging) return;
		const dx = e.clientX - startX;
		const dy = e.clientY - startY;
		if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
		const spot = place(initialRight - dx, initialBottom - dy);
		try {
			localStorage.setItem("__aib_dock_pos", JSON.stringify(spot));
		} catch (_) {}
	});

	window.addEventListener("mouseup", () => {
		isDragging = false;
	});

	btnMain.addEventListener("click", (e) => {
		if (hasMoved) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		location.reload();
	});
})();
