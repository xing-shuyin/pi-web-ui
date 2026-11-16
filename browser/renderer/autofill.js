/**
 * 网页里的密码自动填充下拉（点账号框/密码框时出现在字段下方，点一条就填进去）。
 *
 * 和 `dock.js` 一样，这是被主进程 `executeJavaScript` 注进**普通网页**的脚本，所以：
 * - 只认 `window.__piAutofill` 这条窄桥（preload 暴露，见 `browser/preload.cts`）：拿候选只回
 *   `{ id, name, username }`，**永远拿不到明文密码**；点选只是让主进程去填，明文照旧不经过这里。
 * - 页面自己的脚本可能乱点我们的 UI：所以只认 `isTrusted` 的聚焦/点击，合成事件一律不填。
 * - 定位在 shadow DOM 里、样式全内联，页面 CSS 改不动它；任何一步出错都只是不显示下拉，不能把页面搞挂。
 */
(function () {
	if (window.__PI_AUTOFILL__) return;
	var api = window.__piAutofill;
	if (!api || api.version !== 1) return;
	if (location.protocol !== "https:" && location.protocol !== "http:") return;
	window.__PI_AUTOFILL__ = true;

	var HOST_ID = "pi-autofill-host";
	var host = null;
	var shadow = null;
	var card = null;
	var anchor = null;
	var rows = [];
	var items = [];
	var active = -1;
	var hideTimer = 0;

	function isLoginField(node) {
		if (!(node instanceof HTMLInputElement)) return false;
		if (node.disabled || node.readOnly) return false;
		var type = (node.type || "text").toLowerCase();
		if (type === "hidden" || type === "search" || type === "checkbox" || type === "radio") return false;
		if (type === "password" || type === "email") return true;
		if ((node.getAttribute("autocomplete") || "").toLowerCase() === "username") return true;
		return /user|login|email|account|mail|pass/i.test([node.name, node.id, node.getAttribute("aria-label")].join(" "));
	}

	function ensureHost() {
		if (host && host.isConnected) return;
		host = document.createElement("div");
		host.id = HOST_ID;
		host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
		shadow = host.attachShadow({ mode: "open" });
		var style = document.createElement("style");
		style.textContent = [
			":host{all:initial}",
			".card{position:absolute;pointer-events:auto;min-width:220px;max-width:320px;padding:4px;",
			"border-radius:10px;background:#1b1d24;border:1px solid rgba(255,255,255,.14);",
			"box-shadow:0 12px 32px rgba(0,0,0,.45);font:13px/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;",
			"color:#e6e8ee;overflow:hidden;}",
			".row{display:flex;flex-direction:column;gap:1px;padding:6px 8px;border-radius:7px;cursor:default;",
			"white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
			".row.on{background:rgba(91,140,255,.22);}",
			".name{font-weight:600;overflow:hidden;text-overflow:ellipsis;}",
			".user{color:#9aa1b1;font-size:12px;overflow:hidden;text-overflow:ellipsis;}",
		].join("");
		shadow.append(style);
		card = document.createElement("div");
		card.className = "card";
		card.style.display = "none";
		shadow.append(card);
		(document.body || document.documentElement).append(host);
	}

	var items = [];

	/**
	 * 只重建列表节点（`show()` 时一次），悬停/键盘切换只切 class。
	 * 不能在 mouseenter 里 `replaceChildren()`：重绘会把刚被按下的节点拆掉，mousedown 就丢了。
	 */
	function paint() {
		card.replaceChildren();
		items = [];
		rows.forEach(function (row, index) {
			var item = document.createElement("div");
			item.className = "row";
			var name = document.createElement("div");
			name.className = "name";
			name.textContent = row.name || row.username || "—";
			var user = document.createElement("div");
			user.className = "user";
			user.textContent = row.username || "—";
			item.append(name, user);
			// mousedown + preventDefault：先拿到点击，也不让页面把焦点抢走（否则下拉会被 focusout 收掉）
			item.addEventListener("mousedown", function (event) {
				if (!event.isTrusted) return;
				event.preventDefault();
				event.stopPropagation();
				commit(index);
			});
			item.addEventListener("mouseenter", function () {
				setActive(index);
			});
			card.append(item);
			items.push(item);
		});
		setActive(active);
	}

	function setActive(index) {
		active = index;
		items.forEach(function (item, position) {
			item.className = position === index ? "row on" : "row";
		});
	}

	function place(field) {
		var box = field.getBoundingClientRect();
		var width = Math.max(220, Math.min(320, box.width));
		var left = Math.min(Math.max(8, box.left), Math.max(8, window.innerWidth - width - 8));
		card.style.width = width + "px";
		card.style.left = left + "px";
		var below = box.bottom + 6;
		card.style.top = below + "px";
		card.style.display = "block";
		// 底下放不下就翻到字段上面
		var height = card.getBoundingClientRect().height;
		if (below + height > window.innerHeight - 8 && box.top - height - 6 > 8) {
			card.style.top = box.top - height - 6 + "px";
		}
	}

	function show(field, list) {
		try {
			ensureHost();
			// 先撤掉可能已排队的收起：点进字段那一刻上一个元素的 focusout 会排一个定时器，
			// 不撤的话下拉会“一闪就消失”。
			clearTimeout(hideTimer);
			anchor = field;
			rows = list.slice(0, 8);
			active = -1;
			paint();
			place(field);
		} catch (_) {
			hide();
		}
	}

	/** 页面滚动 / 窗口尺寸变化：还贴着同一个字段就重新定位，否则收起。 */
	function onViewportChange() {
		if (!card || card.style.display === "none") return;
		if (anchor && anchor.isConnected && isLoginField(document.activeElement)) place(anchor);
		else hide();
	}

	function hide() {
		clearTimeout(hideTimer);
		anchor = null;
		rows = [];
		items = [];
		setActive(-1);
		if (card) card.style.display = "none";
	}

	function fillLater() {
		clearTimeout(hideTimer);
		hideTimer = setTimeout(function () {
			// 焦点还在登录字段上（包括页面自己重设焦点）就不收
			if (isLoginField(document.activeElement)) return;
			hide();
		}, 180);
	}

	function commit(index) {
		var row = rows[index];
		if (!row) return;
		hide();
		try {
			Promise.resolve(api.pick(row.id)).catch(function () {});
		} catch (_) {}
	}

	document.addEventListener(
		"focusin",
		function (event) {
			if (!event.isTrusted || !isLoginField(event.target)) return;
			clearTimeout(hideTimer);
			var field = event.target;
			Promise.resolve(api.lookup())
				.then(function (list) {
					if (!Array.isArray(list) || !list.length) {
						hide();
						return;
					}
					if (document.activeElement !== field) return;
					show(field, list);
				})
				.catch(function () {});
		},
		true,
	);

	document.addEventListener(
		"focusout",
		function () {
			if (card && card.style.display !== "none") fillLater();
		},
		true,
	);

	document.addEventListener(
		"keydown",
		function (event) {
			if (!card || card.style.display === "none") return;
			if (event.key === "Escape") {
				event.preventDefault();
				hide();
				return;
			}
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				if (!rows.length) return;
				event.preventDefault();
				var delta = event.key === "ArrowDown" ? 1 : -1;
				setActive((active + delta + rows.length) % rows.length);
				return;
			}
			if (event.key === "Enter" && active >= 0) {
				event.preventDefault();
				commit(active);
			}
		},
		true,
	);

	document.addEventListener(
		"mousedown",
		function (event) {
			if (!card || card.style.display === "none") return;
			var path = event.composedPath ? event.composedPath() : [];
			if (path.indexOf(host) >= 0) return;
			if (event.target === anchor) return;
			hide();
		},
		true,
	);

	window.addEventListener("scroll", onViewportChange, true);
	window.addEventListener("resize", onViewportChange, true);
	window.addEventListener("blur", hide);
})();
