/**
 * 浏览器翻译内容脚本（注入到所有 http(s) 网页，纯 JS，无构建步骤）。
 *
 * 职责：① 划词浮层（主进程右键菜单触发 __PI_TRANSLATE__.showSelection）
 *       ② 全页翻译（DOM 文本节点 → 分段 → 批量调桥 → 回填 → 显示原文）
 *       ③ Edge 式状态胶囊：点一下就翻，翻译中实时报进度、翻完报告引擎，随时一点回原文
 * 只通过 __piTranslate 窄桥拿到译文字符串；不碰 DOM 之外的任何能力。
 * 幂等：dom-ready / did-finish-load 都注入，靠 window.__PI_TRANSLATE__ 占位避免重复。
 *
 * 节奏与 Edge 翻译对齐：
 * - **大段少次**：每段 5000 字、最多 60 个节点、最多 4 段并行，一页通常 2–4 个请求就翻完；
 * - **边翻边回填**：每段回来就写进 DOM，不等整页全部完成；
 * - **看得见**：页面顶部一颗状态胶囊（Shadow DOM，站点 CSS 碰不到），带「显示原文」按钮。
 */
(function () {
	if (location.protocol !== "https:" && location.protocol !== "http:") return;
	var bridge = window.__piTranslate;
	if (!bridge || typeof bridge.translate !== "function") return;

	var existing = window.__PI_TRANSLATE__;
	if (existing && existing.ready) {
		existing.showSelection();
		return;
	}
	window.__PI_TRANSLATE__ = { ready: false, showSelection: function () {}, togglePage: function () {} };

	var SKIP_TAGS = new Set(["SCRIPT", "STYLE", "CODE", "PRE", "TEXTAREA", "NOSCRIPT", "SVG", "CANVAS", "IFRAME"]);
	// 小步快跑：段越小、首屏回填越快；同时也不能太碎——每段越大，请求越少（一页 1–3 个请求）
	// 5000 也是主进程 TENCENT_MAX_CHARS：再大就会被腾讯整批 outOfLimit 拒掉
	var BATCH_CHARS = 5000;
	// 一段 = 一次请求；页面桥单请求上限 120 段，这里按 60 留一半余量
	var MAX_BATCH_NODES = 60;
	var BATCH_CONCURRENCY = 4;
	var root = document.documentElement;
	var originals = new WeakMap();
	var translatedNodes = [];
	var currentTarget = "auto";
	var pageState = "original";
	var selectionBubble = null;
	var progress = { done: 0, total: 0, failed: 0 };
	var lastModel = "";
	var activeRun = null;
	var runToken = 0;
	var stateListeners = [];
	// 主进程给的配置（目标语言 / 是否自动提示），异步到来不影响翻译本身
	var config = { target: "auto", autoPrompt: true };
	var offeredFor = "";

	function snapshot() {
		return {
			pageState: pageState,
			done: progress.done,
			total: progress.total,
			failed: progress.failed,
			target: currentTarget,
			model: lastModel,
		};
	}

	function notify() {
		paintPill();
		var state = snapshot();
		for (var i = 0; i < stateListeners.length; i++) {
			try {
				stateListeners[i](state);
			} catch (_) {}
		}
	}

	function onState(listener) {
		if (typeof listener !== "function") return function () {};
		stateListeners.push(listener);
		try {
			listener(snapshot());
		} catch (_) {}
		return function () {
			var index = stateListeners.indexOf(listener);
			if (index >= 0) stateListeners.splice(index, 1);
		};
	}

	function logError(err) {
		try {
			console.warn("[pi-translate]", err);
		} catch (_) {}
	}

	function callBridge(texts, target) {
		return bridge.translate(texts, target).then(function (result) {
			if (!result || !Array.isArray(result.translations)) throw new Error("Bad translation response");
			return result;
		});
	}

	function isVisible(el) {
		var style = getComputedStyle(el);
		return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0;
	}

	function collectTextNodes(node, out) {
		if (node.nodeType === Node.TEXT_NODE) {
			var text = node;
			var value = text.nodeValue || "";
			if (value.trim() && /[\u00C0-\uFFFFA-Za-z]/.test(value)) out.push(text);
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return;
		var el = node;
		if (SKIP_TAGS.has(el.tagName) || el.closest(".notranslate,[translate=no]")) return;
		if (!isVisible(el)) return;
		for (var i = 0; i < el.childNodes.length; i++) collectTextNodes(el.childNodes[i], out);
	}

	function groupIntoSegments(nodes) {
		var segments = [];
		var current = [];
		var length = 0;
		for (var i = 0; i < nodes.length; i++) {
			var node = nodes[i];
			var value = (node.nodeValue || "").trim();
			if (current.length && (length + value.length > BATCH_CHARS || current.length >= MAX_BATCH_NODES)) {
				segments.push(current);
				current = [];
				length = 0;
			}
			current.push(node);
			length += value.length;
		}
		if (current.length) segments.push(current);
		return segments;
	}

	function translateNodes(nodes, target, token) {
		var texts = nodes.map(function (node) {
			return (node.nodeValue || "").trim();
		});
		return callBridge(texts, target).then(function (result) {
			if (token !== runToken) return result;
			nodes.forEach(function (node, index) {
				var translated = result.translations[index];
				if (!translated || translated === texts[index]) return;
				if (!originals.has(node)) originals.set(node, node.nodeValue || "");
				node.nodeValue = (node.nodeValue || "").replace(texts[index], translated);
				translatedNodes.push(node);
			});
			return result;
		});
	}

	function restorePage() {
		// 作废当前这一轮：在途的批量回来也不再把译文写回去（“取消/显示原文”要立刻生效）
		runToken += 1;
		activeRun = null;
		for (var i = 0; i < translatedNodes.length; i++) {
			var node = translatedNodes[i];
			var original = originals.get(node);
			if (original !== undefined) node.nodeValue = original;
		}
		translatedNodes = [];
		progress = { done: 0, total: 0, failed: 0 };
		pageState = "original";
		hidePill();
		notify();
	}

	function translatePage(target) {
		var token = ++runToken;
		var nodes = [];
		collectTextNodes(root, nodes);
		var segments = groupIntoSegments(nodes);
		progress = { done: 0, total: segments.length, failed: 0 };
		pageState = "translating";
		if (segments.length) ensurePill();
		notify();
		if (!segments.length) {
			pageState = "original";
			notify();
			return Promise.resolve();
		}
		var next = 0;
		function pump() {
			if (next >= segments.length || token !== runToken) return Promise.resolve();
			var segment = segments[next];
			next += 1;
			return translateNodes(segment, target, token)
				.then(
					function (result) {
						if (token !== runToken) return;
						if (result && result.model) lastModel = result.model;
						progress.done += 1;
						notify();
					},
					function (err) {
						if (token !== runToken) return;
						progress.failed += 1;
						progress.done += 1;
						logError(err);
						notify();
					},
				)
				.then(pump);
		}
		var workers = [];
		var count = Math.min(BATCH_CONCURRENCY, segments.length);
		for (var i = 0; i < count; i++) workers.push(pump());
		return Promise.all(workers).then(function () {
			if (token !== runToken) return;
			pageState = progress.failed >= segments.length ? "original" : "translated";
			currentTarget = target;
			notify();
		});
	}

	function togglePage() {
		if (pageState === "translated") {
			restorePage();
			return Promise.resolve();
		}
		if (pageState === "translating") return activeRun || Promise.resolve();
		activeRun = translatePage(currentTarget).then(function () {
			activeRun = null;
		});
		return activeRun;
	}

	/** 已经翻过的节点（`originals` 里有记录）不再收：这是“跟翻新内容”的关键前提。 */
	function collectFreshNodes(node, out) {
		if (node.nodeType === Node.TEXT_NODE) {
			var text = node;
			var value = text.nodeValue || "";
			if (value.trim() && !originals.has(text) && /[\u00C0-\uFFFFA-Za-z]/.test(value)) out.push(text);
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return;
		var el = node;
		if (el.id === "pi-translate-pill-host") return;
		if (SKIP_TAGS.has(el.tagName) || el.closest(".notranslate,[translate=no]")) return;
		if (!isVisible(el)) return;
		for (var i = 0; i < el.childNodes.length; i++) collectFreshNodes(el.childNodes[i], out);
	}

	/**
	 * 跟翻后加载的内容（无限滚动 / SPA 换块）：页已经处于“已翻译”时，
	 * 新出现的文本节点排队补翻。我们自己的回填走 `characterData`，不在监听范围里，
	 * 所以不会自己触发自己；已翻过的节点记在 `originals` 里，也不会重复翻。
	 */
	var refreshTimer = null;
	function scheduleRefresh() {
		if (pageState !== "translated" || refreshTimer) return;
		refreshTimer = setTimeout(function () {
			refreshTimer = null;
			if (pageState !== "translated") return;
			var nodes = [];
			collectFreshNodes(root, nodes);
			if (!nodes.length) return;
			var segments = groupIntoSegments(nodes);
			var target = currentTarget;
			var token = runToken;
			var next = 0;
			progress.total += segments.length;
			function pump() {
				if (next >= segments.length || token !== runToken) return;
				translateNodes(segments[next++], target, token).then(
					function () {
						if (token !== runToken) return;
						progress.done += 1;
					},
					function (err) {
						if (token !== runToken) return;
						progress.done += 1;
						progress.failed += 1;
						logError(err);
					},
				).then(pump);
			}
			pump();
		}, 700);
	}

	if (typeof MutationObserver === "function") {
		new MutationObserver(scheduleRefresh).observe(document.documentElement, { childList: true, subtree: true });
	}

	function removeBubble() {
		if (selectionBubble && selectionBubble.parentNode) selectionBubble.parentNode.removeChild(selectionBubble);
		selectionBubble = null;
	}

	function showSelection() {
		var selection = window.getSelection();
		var text = selection ? String(selection).trim() : "";
		if (!text || !selection || selection.rangeCount === 0) return;
		removeBubble();
		var rect = selection.getRangeAt(0).getBoundingClientRect();
		var bubble = document.createElement("div");
		bubble.id = "pi-translate-bubble";
		bubble.innerHTML =
			'<div class="pi-tr-head"><span class="pi-tr-title">翻译</span><button class="pi-tr-close" type="button">×</button></div>' +
			'<div class="pi-tr-body"><div class="pi-tr-loading">翻译中…</div></div>' +
			'<div class="pi-tr-foot"><button class="pi-tr-copy" type="button">复制</button></div>';
		bubble.style.left = Math.max(8, Math.min(window.innerWidth - 320, rect.left + window.scrollX)) + "px";
		bubble.style.top = Math.max(8, rect.bottom + window.scrollY + 8) + "px";
		(document.body || root).appendChild(bubble);
		selectionBubble = bubble;
		var body = bubble.querySelector(".pi-tr-body");
		var copyBtn = bubble.querySelector(".pi-tr-copy");
		var closeBtn = bubble.querySelector(".pi-tr-close");
		copyBtn.disabled = true;
		closeBtn.addEventListener("click", removeBubble);
		copyBtn.addEventListener("click", function () {
			if (navigator.clipboard) void navigator.clipboard.writeText(body.textContent || "");
			copyBtn.textContent = "已复制";
		});
		callBridge([text], currentTarget)
			.then(function (result) {
				if (selectionBubble !== bubble) return;
				body.textContent = result.translations[0] || "(no translation)";
				copyBtn.disabled = false;
			})
			.catch(function (err) {
				if (selectionBubble !== bubble) return;
				body.textContent = "翻译失败：" + (err instanceof Error ? err.message : String(err));
			});
	}

	// ── Edge 式状态胶囊 ────────────────────────────────────────────
	// 一颗小胶囊：翻译中报 done/total、翻完报引擎并自动消失、随时一点回原文。
	// 它在 Shadow DOM 里，且只活几秒——比当年的悬浮球轻得多，也不会持续干扰页面。
	var pill = null;
	var pillHideTimer = null;

	function ensurePill() {
		if (pill && pill.host.isConnected) return pill;
		var host = document.createElement("div");
		host.id = "pi-translate-pill-host";
		host.style.cssText =
			"all:initial;position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483000;";
		var shadow = host.attachShadow({ mode: "open" });
		var style = document.createElement("style");
		style.textContent = [
			".pi-pill{display:flex;align-items:center;gap:8px;padding:7px 10px 7px 12px;border-radius:999px;",
			"background:#1d2027;color:#e6e8ee;border:1px solid rgba(255,255,255,.14);",
			"box-shadow:0 6px 22px rgba(0,0,0,.35);font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
			".pi-pill-text{white-space:nowrap}",
			".pi-pill button{border:0;cursor:pointer;font:inherit;border-radius:999px;padding:3px 9px}",
			".pi-pill-action{background:#2f6fed;color:#fff}",
			".pi-pill-action:hover{background:#3d7bf7}",
			".pi-pill-close{background:transparent;color:#9aa0b0;font-size:15px;padding:0 4px}",
		].join("");
		var box = document.createElement("div");
		box.className = "pi-pill";
		var text = document.createElement("span");
		text.className = "pi-pill-text";
		var action = document.createElement("button");
		action.className = "pi-pill-action";
		action.type = "button";
		var close = document.createElement("button");
		close.className = "pi-pill-close";
		close.type = "button";
		close.title = "关闭";
		close.textContent = "×";
		box.append(text, action, close);
		shadow.append(style, box);
		(document.body || root).appendChild(host);
		close.addEventListener("click", function () {
			hidePill();
		});
		pill = { host: host, text: text, action: action };
		return pill;
	}

	function clearPillTimer() {
		if (pillHideTimer) clearTimeout(pillHideTimer);
		pillHideTimer = null;
	}

	function hidePill() {
		clearPillTimer();
		if (pill && pill.host.parentNode) pill.host.parentNode.removeChild(pill.host);
		pill = null;
	}

	/** 胶囊内容完全由 state + progress 派生：一个地方写，状态一变就重画。 */
	function paintPill() {
		if (!pill) return;
		// “要不要翻译？”的提示不是进度，不能被进度重画盖掉（只有真正开始翻时才交出去）
		if (pill.offering && pageState === "original" && !progress.total) return;
		pill.offering = false;
		clearPillTimer();
		var action = pill.action;
		action.onclick = null;
		if (pageState === "translating") {
			pill.text.textContent = progress.total
				? "正在翻译 " + progress.done + "/" + progress.total + " 段…"
				: "正在翻译…";
			action.textContent = "显示原文";
			action.onclick = restorePage;
			return;
		}
		if (pageState === "translated") {
			pill.text.textContent =
				"已翻译" +
				(lastModel ? " · " + lastModel : "") +
				(progress.failed ? "（" + progress.failed + " 段保留原文）" : "");
			action.textContent = "显示原文";
			action.onclick = restorePage;
			pillHideTimer = setTimeout(hidePill, 7000);
			return;
		}
		if (progress.failed && progress.total) {
			pill.text.textContent = "翻译失败，已保留原文";
			action.textContent = "重试";
			action.onclick = function () {
				void togglePage();
			};
			pillHideTimer = setTimeout(hidePill, 8000);
			return;
		}
		hidePill();
	}

	function showPill(text, actionLabel, onAction) {
		var bar = ensurePill();
		bar.offering = true;
		clearPillTimer();
		bar.text.textContent = text;
		bar.action.textContent = actionLabel;
		bar.action.onclick = onAction;
		return bar;
	}

	/** 页面自己声明的语言（lang / content-language）。读不到就不猜——不乱弹提示。 */
	function detectLanguage() {
		var lang = String(document.documentElement.getAttribute("lang") || "").trim().toLowerCase();
		if (!lang) {
			var meta = document.querySelector('meta[http-equiv="content-language" i]');
			if (meta) lang = String(meta.getAttribute("content") || "").trim().toLowerCase();
		}
		if (!lang) return "";
		return lang.split(/[-_]/)[0];
	}

	function targetBase() {
		var target = String(config.target || "auto");
		return target === "auto" ? "zh" : target.split("-")[0].toLowerCase();
	}

	/**
	 * Edge 式提示：页面语言与目标语言不一致时，弹一颗「此页是英文 · 翻译」胶囊。
	 * 只提示一次/页，点「×」或翻译过就不再烦；读不到语言就什么都不做。
	 */
	function maybeOfferTranslation() {
		if (!config.autoPrompt || pageState !== "original") return;
		if (offeredFor === location.href) return;
		var detected = detectLanguage();
		if (!detected || detected === targetBase()) return;
		offeredFor = location.href;
		showPill("此页面是 " + detected.toUpperCase() + "，要翻译吗？", "翻译此页", function () {
			void togglePage();
		});
	}

	var style = document.createElement("style");
	style.id = "pi-translate-style";
	style.textContent = [
		"#pi-translate-bubble{position:absolute;z-index:2147483000;width:300px;max-height:320px;overflow:auto;",
		"background:#181a20;color:#e6e8ee;border:1px solid rgba(255,255,255,.14);border-radius:10px;",
		"box-shadow:0 8px 28px rgba(0,0,0,.45);font:13px/1.6 system-ui,sans-serif;padding:10px 12px}",
		"#pi-translate-bubble .pi-tr-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}",
		"#pi-translate-bubble .pi-tr-title{font-weight:600;color:#8ab0ff}",
		"#pi-translate-bubble .pi-tr-close{border:0;background:transparent;color:#9aa0b0;cursor:pointer;font-size:16px}",
		"#pi-translate-bubble .pi-tr-body{white-space:pre-wrap;word-break:break-word;min-height:24px}",
		"#pi-translate-bubble .pi-tr-loading{color:#8b90a0}",
		"#pi-translate-bubble .pi-tr-foot{display:flex;justify-content:flex-end;margin-top:8px}",
		"#pi-translate-bubble .pi-tr-copy{border:1px solid rgba(255,255,255,.16);background:#2b3040;color:#e6e8ee;",
		"border-radius:6px;padding:3px 10px;cursor:pointer}",
		"#pi-translate-bubble .pi-tr-copy:disabled{opacity:.45;cursor:default}",
	].join("");
	(document.head || root).appendChild(style);

	document.addEventListener("mousedown", function (event) {
		if (selectionBubble && !selectionBubble.contains(event.target)) removeBubble();
	});

	window.__PI_TRANSLATE__ = {
		ready: true,
		showSelection: showSelection,
		togglePage: togglePage,
		restore: restorePage,
		getState: snapshot,
		onState: onState,
	};

	// 主进程给的配置（目标语言 / 自动提示开关）：拿不到也不影响手动翻译
	function loadConfig() {
		if (typeof bridge.config !== "function") return;
		bridge
			.config()
			.then(function (next) {
				if (!next || typeof next !== "object") return;
				if (typeof next.target === "string" && next.target) {
					config.target = next.target;
					if (currentTarget === "auto") currentTarget = next.target;
				}
				config.autoPrompt = next.autoPrompt !== false;
				// 等页首屏静一下再提示：dom-ready 就弹会盖在还在跑的加载动画上
				setTimeout(maybeOfferTranslation, 900);
			})
			.catch(function () {});
	}
	loadConfig();
})();
