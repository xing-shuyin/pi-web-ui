/**
 * 浏览器翻译内容脚本（注入到所有 http(s) 网页，纯 JS，无构建步骤）。
 *
 * 职责：① 划词浮层（主进程右键菜单触发 __PI_TRANSLATE__.showSelection）
 *       ② 全页翻译（DOM 文本节点 → 分段 → 批量调桥 → 回填 → 显示原文）
 * 只通过 __piTranslate 窄桥拿到译文字符串；不碰 DOM 之外的任何能力。
 * 幂等：dom-ready / did-finish-load 都注入，靠 window.__PI_TRANSLATE__ 占位避免重复。
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
	// 小步快跑：段越小、首屏回填越快；3 路并发保证总耗时不涨，翻完一段立刻写回一段。
	var BATCH_CHARS = 1200;
	var BATCH_CONCURRENCY = 3;
	var root = document.documentElement;
	var originals = new WeakMap();
	var translatedNodes = [];
	var currentTarget = "auto";
	var pageState = "original";
	var selectionBubble = null;
	var progress = { done: 0, total: 0, failed: 0 };
	var lastModel = "";
	var activeRun = null;
	var stateListeners = [];

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
			if (current.length && length + value.length > BATCH_CHARS) {
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

	function translateNodes(nodes, target) {
		var texts = nodes.map(function (node) {
			return (node.nodeValue || "").trim();
		});
		return callBridge(texts, target).then(function (result) {
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
		for (var i = 0; i < translatedNodes.length; i++) {
			var node = translatedNodes[i];
			var original = originals.get(node);
			if (original !== undefined) node.nodeValue = original;
		}
		translatedNodes = [];
		progress = { done: 0, total: 0, failed: 0 };
		pageState = "original";
		notify();
	}

	function translatePage(target) {
		var nodes = [];
		collectTextNodes(root, nodes);
		var segments = groupIntoSegments(nodes);
		progress = { done: 0, total: segments.length, failed: 0 };
		pageState = "translating";
		notify();
		if (!segments.length) {
			pageState = "original";
			notify();
			return Promise.resolve();
		}
		var next = 0;
		function pump() {
			if (next >= segments.length) return Promise.resolve();
			var segment = segments[next];
			next += 1;
			return translateNodes(segment, target)
				.then(
					function (result) {
						if (result && result.model) lastModel = result.model;
						progress.done += 1;
						notify();
					},
					function (err) {
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
})();
