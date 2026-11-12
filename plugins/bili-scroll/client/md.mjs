/**
 * 详情右栏的极简 Markdown 渲染（纯函数，不依赖浏览器/宿主）。
 *
 * 只认 AI 总结文档与旧单篇笔记里真正会出现的语法：
 * 标题 / 段落 / 有序·无序列表 / 引用 / 分割线 / 表格降级 / 行内 code、
 * 粗体、链接，以及 `[mm:ss]` 时间戳 → 可点回看锚点。
 * 先转义再还原标记，任何视频字幕里的 HTML 都只能当文本。
 */

const escapeHtml = (s) =>
	String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const tsToSec = (label) =>
	String(label)
		.split(":")
		.reduce((acc, n) => acc * 60 + (Number(n) || 0), 0);

export function renderMiniMd(src, opts = {}) {
	const videoUrl = String(opts.url || "").replace(/[?#].*$/, "");
	const inline = (s) => {
		let out = escapeHtml(s);
		out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
		out = out.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
		out = out.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (m, label, href) => {
			const cls = /^\d{1,2}:\d{2}(?::\d{2})?$/.test(label) ? ' class="bili-ts"' : "";
			return `<a${cls} href="${href}" target="_blank" rel="noreferrer">${label}</a>`;
		});
		// 裸时间戳 [mm:ss] → 可点回看锚点
		out = out.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, (_m, label) => {
			if (!videoUrl) return `<span class="bili-ts">${label}</span>`;
			return `<a class="bili-ts" href="${videoUrl}?t=${tsToSec(label)}" target="_blank" rel="noreferrer" title="从 ${label} 开始看">${label}</a>`;
		});
		return out;
	};

	const lines = String(src || "").split(/\r?\n/);
	let html = "";
	let listTag = "";
	let quote = [];
	let para = [];
	const closeList = () => {
		if (listTag) {
			html += `</${listTag}>`;
			listTag = "";
		}
	};
	const flushQuote = () => {
		if (!quote.length) return;
		html += `<blockquote>${quote.map((l) => inline(l)).join("<br/>")}</blockquote>`;
		quote = [];
	};
	const flushPara = () => {
		if (!para.length) return;
		html += `<p>${para.map((l) => inline(l)).join("<br/>")}</p>`;
		para = [];
	};
	const flushAll = () => {
		flushPara();
		closeList();
		flushQuote();
	};

	for (const raw of lines) {
		const t = raw.trim();
		if (!t) {
			flushAll();
			continue;
		}
		if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
			flushAll();
			html += "<hr/>";
			continue;
		}
		const head = /^(#{1,6})\s+(.*)$/.exec(t);
		if (head) {
			flushAll();
			const tag = head[1].length <= 2 ? "h4" : "h5";
			html += `<${tag}>${inline(head[2])}</${tag}>`;
			continue;
		}
		const q = /^>\s?(.*)$/.exec(t);
		if (q) {
			flushPara();
			closeList();
			quote.push(q[1]);
			continue;
		}
		flushQuote();
		const ul = /^[-*+]\s+(.*)$/.exec(t);
		if (ul) {
			flushPara();
			if (listTag !== "ul") {
				closeList();
				html += "<ul>";
				listTag = "ul";
			}
			html += `<li>${inline(ul[1])}</li>`;
			continue;
		}
		const ol = /^\d+[.)]\s+(.*)$/.exec(t);
		if (ol) {
			flushPara();
			if (listTag !== "ol") {
				closeList();
				html += "<ol>";
				listTag = "ol";
			}
			html += `<li>${inline(ol[1])}</li>`;
			continue;
		}
		closeList();
		// 表格分隔行丢弃，数据行降级成一行文本（总结文档不用表格，这里只兼容旧笔记）
		if (t.includes("|") && /^[\s|:-]+$/.test(t)) continue;
		if (t.startsWith("|")) {
			flushPara();
			const cells = t
				.replace(/^\||\|$/g, "")
				.split("|")
				.map((c) => c.trim())
				.filter(Boolean);
			html += `<p class="bili-row">${cells.map((c) => inline(c)).join(" · ")}</p>`;
			continue;
		}
		para.push(t);
	}
	flushAll();
	return html || '<p style="color: var(--text-dim);">暂无内容</p>';
}

/**
 * 旧单篇笔记头部的文件元信息（`# 标题` / `> 来自「刷B站」…` / `> 这一份是单条笔记`）
 * 在详情弹窗里全是噪音：标题在弹窗头部、出处有「B站打开」按钮。
 */
export function stripNoteScaffold(text) {
	return String(text || "")
		.split(/\r?\n/)
		.filter((line) => {
			const t = line.trim();
			if (/^#\s+/.test(t) && !/^##/.test(t)) return false;
			if (/^>\s*来自/.test(t)) return false;
			if (/^>\s*这一份是/.test(t)) return false;
			return true;
		})
		.join("\n")
		.replace(/^---\s*$/gm, "")
		.trim();
}
