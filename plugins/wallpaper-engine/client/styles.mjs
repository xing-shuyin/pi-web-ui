export const WALLPAPER_THEMES = {
	obsidian: {
		id: "wallpaper-obsidian",
		name: "🌑 黑曜冷月",
		accent: "#e2e8f0",
		accentContrast: "#0c0d11",
		accentSoft: "rgba(255, 255, 255, 0.14)",
		border: "rgba(255, 255, 255, 0.16)",
		borderSoft: "rgba(255, 255, 255, 0.08)",
		text: "#ffffff",
		textDim: "#cbd5e1",
		topbarBg: "rgba(6, 6, 8, 0.48)",
		panelBg: "rgba(8, 8, 12, 0.45)",
		cardBg: "rgba(12, 13, 18, 0.65)",
		inputboxBg: "rgba(14, 15, 22, 0.60)",
		userBg: "linear-gradient(135deg, rgba(30, 32, 40, 0.68) 0%, rgba(18, 19, 24, 0.58) 100%)",
		userBorder: "rgba(255, 255, 255, 0.30)",
		inputGlow: "rgba(255, 255, 255, 0.12)",
		inputFocusGlow: "rgba(255, 255, 255, 0.28)",
		focusBorder: "rgba(255, 255, 255, 0.65)",
		codeBg: "rgba(6, 7, 10, 0.85)",
		codeBorder: "rgba(255, 255, 255, 0.14)",
	},
	flow: {
		id: "wallpaper-flow",
		name: "🖋️ 极简行文",
		accent: "#ffffff",
		accentContrast: "#000000",
		accentSoft: "rgba(255, 255, 255, 0.12)",
		border: "rgba(255, 255, 255, 0.14)",
		borderSoft: "rgba(255, 255, 255, 0.06)",
		text: "#ffffff",
		textDim: "#cbd5e1",
		topbarBg: "rgba(6, 6, 8, 0.38)",
		panelBg: "rgba(8, 8, 12, 0.35)",
		cardBg: "transparent",
		inputboxBg: "rgba(12, 14, 20, 0.52)",
		userBg: "linear-gradient(135deg, rgba(28, 30, 40, 0.55) 0%, rgba(16, 18, 24, 0.45) 100%)",
		userBorder: "rgba(255, 255, 255, 0.16)",
		inputGlow: "rgba(255, 255, 255, 0.10)",
		inputFocusGlow: "rgba(255, 255, 255, 0.25)",
		focusBorder: "rgba(255, 255, 255, 0.60)",
		codeBg: "rgba(6, 8, 12, 0.70)",
		codeBorder: "rgba(255, 255, 255, 0.10)",
	},
};
WALLPAPER_THEMES["compact-flow"] = WALLPAPER_THEMES.flow;

function scaleAlpha(colorStr, factor) {
	if (!colorStr) return colorStr;
	return colorStr.replace(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)/g, (_, r, g, b, a) => {
		const newA = Math.max(0, Math.min(1, Number(a) * factor)).toFixed(3);
		return `rgba(${r}, ${g}, ${b}, ${newA})`;
	});
}

export function getGlassThemeCss(
	blur = 0,
	opacity = 40,
	interactive = false,
	themeKey = "obsidian",
	lightWallpaperMode = false,
) {
	const clampedBlur = Math.max(0, Math.min(Number(blur) || 0, 24));
	const opRatio = Math.max(0.0, Math.min(1.0, (Number(opacity) ?? 40) / 100));
	const op = opRatio.toFixed(2);
	const hasBlur = clampedBlur > 0;
	const isFlowTheme = themeKey === "flow" || themeKey === "compact-flow";
	const pal = WALLPAPER_THEMES[themeKey] || WALLPAPER_THEMES.obsidian;

	const topbarBg = scaleAlpha(pal.topbarBg, opRatio);
	const panelBg = scaleAlpha(pal.panelBg, opRatio);
	const cardBg = scaleAlpha(pal.cardBg, opRatio);
	const inputboxBg = scaleAlpha(pal.inputboxBg, opRatio);
	const userBg = scaleAlpha(pal.userBg, opRatio);

	const fixedGlassFilter = hasBlur
		? `backdrop-filter: blur(${clampedBlur}px) !important; -webkit-backdrop-filter: blur(${clampedBlur}px) !important;`
		: `backdrop-filter: none !important; -webkit-backdrop-filter: none !important;`;

	const composerGlassFilter = hasBlur
		? `backdrop-filter: blur(${clampedBlur}px) !important; -webkit-backdrop-filter: blur(${clampedBlur}px) !important;`
		: `backdrop-filter: none !important; -webkit-backdrop-filter: none !important;`;

	const chipBlur = hasBlur ? Math.max(8, clampedBlur) : 8;
	const menuBlur = hasBlur ? Math.max(12, clampedBlur) : 12;

	return `
:root {
	--pi-we-blur: ${clampedBlur}px;
	--pi-we-opacity: ${op};

	/* 深度联动宿主内置壁纸透明度系统与当前选中的壁纸主题调色 */
	--wallpaper-panel-alpha: calc(var(--pi-we-opacity) * 35%);
	--topbar-bg: ${topbarBg};
	--statusbar-bg: ${topbarBg};
	--panel-bg: ${panelBg};
	--msgs-bg: transparent;
	--inputbox-bg: ${inputboxBg};
	--card-bg: ${cardBg};
	--chip-bg: color-mix(in srgb, var(--text) ${Math.max(0, 8 * opRatio).toFixed(1)}%, transparent);

	--accent: ${pal.accent};
	--accent-contrast: ${pal.accentContrast ?? "#ffffff"};
	--accent-soft: ${pal.accentSoft};
	--border: ${pal.border};
	--border-soft: ${pal.borderSoft};
	--text: ${pal.text};
	--text-dim: ${pal.textDim};
}

/* 1. 透出底层壁纸：将所有骨架实底背景完全置为透明 */
#root, .app, .layout, .view-pane, .main, .messages-wrap, .chat-view, .chat-scroll, .messages, .inputbar {
	background: transparent !important;
}

/* 2. 顶栏与底栏：去阴影、纯净通透，根据模糊度按需毛玻璃 */
.topbar {
	background: ${topbarBg} !important;
	border-bottom: 1px solid ${pal.border} !important;
	box-shadow: none !important;
	${fixedGlassFilter}
	z-index: 50 !important;
}

.footer-bar, .statusbar {
	background: ${topbarBg} !important;
	border-top: 1px solid ${pal.border} !important;
	box-shadow: none !important;
	${fixedGlassFilter}
	z-index: 50 !important;
}

/* 3. 左右侧边栏面板（.panel）：剔除实黑，呈现高级亚克力微透暗晶质感（去阴影） */
.panel, .drawer-left .panel, .drawer-right .panel, .lp-panel {
	background: ${panelBg} !important;
	border-color: ${pal.border} !important;
	box-shadow: none !important;
	${fixedGlassFilter}
}

.panel-header, .lp-section-header, .panel-convs, .panel-sessions, .lp-group-title, .panel-body {
	background: transparent !important;
}

.lp-conv-row:hover, .lp-conv-row.active, .ft-row:hover, .panel-item:hover {
	background: ${pal.accentSoft} !important;
}

/* 3.1 左侧分区标题（最近项目、运行对话、历史对话等）彻底提亮为清爽亮白，告别暗黑发脏 */
.lp-section-header,
.lp-section-title,
.lp-section-title-text,
.lp-section-chevron,
.lp-section-count,
.panel-section-title {
	color: var(--text) !important;
	opacity: 0.96 !important;
	text-shadow: 0 0 1px rgba(0, 0, 0, 0.95), 0 1px 1.5px rgba(0, 0, 0, 0.85) !important;
}

/* 4. 气泡与正文系统：黑曜冷月（独立毛玻璃圆角卡片）与极简行文（零边框零背景·极致紧凑无界正文） */
.messages-wrap,
.chat-scroll,
.messages {
	background: transparent !important;
}

.msg {
	background: transparent !important;
	border: none !important;
	box-shadow: none !important;
}

${
	isFlowTheme
		? `
/* 4-A. 极简行文模式（Flow）：正文极致紧凑，零边框、零背景，所有文字微小黑色阴影，行云流水自然倾泻 */
.messages {
	padding-top: 4px !important;
	padding-bottom: calc(48px + var(--quick-row-h, 0px)) !important;
}

.msg {
	margin: 4px 0 !important;
	padding: 0 !important;
}

.msg-assistant {
	margin: 8px 0 !important;
	padding: 0 !important;
}

.msg-assistant .msg-body {
	background: transparent !important;
	border: none !important;
	border-radius: 0 !important;
	box-shadow: none !important;
	backdrop-filter: none !important;
	-webkit-backdrop-filter: none !important;
	overflow: visible !important;
	display: block !important;
	padding: 0 !important;
	margin: 0 !important;
	line-height: 1.62 !important;
	letter-spacing: 0.012em !important;
}

.msg-text,
.msg-assistant .msg-text {
	background: transparent !important;
	border: none !important;
	box-shadow: none !important;
	padding: 0 !important;
	margin: 0 !important;
}

/* 正文段落与排版极致紧凑流畅 */
.msg-body p {
	margin: 0.36em 0 !important;
	line-height: 1.62 !important;
}
.msg-body p:first-child { margin-top: 0 !important; }
.msg-body p:last-child { margin-bottom: 0 !important; }

.msg-body ul, .msg-body ol {
	margin: 0.25em 0 !important;
	padding-left: 1.25em !important;
}

.msg-body li {
	margin: 0.12em 0 !important;
	line-height: 1.58 !important;
}
.msg-body li > p {
	margin: 0 !important;
	display: inline !important;
}

.msg-body h1, .msg-body h2, .msg-body h3, .msg-body h4, .msg-body h5, .msg-body h6 {
	margin: 0.55em 0 0.22em 0 !important;
	line-height: 1.35 !important;
	font-weight: 600 !important;
	color: var(--text) !important;
}
.msg-body h1:first-child, .msg-body h2:first-child, .msg-body h3:first-child, .msg-body h4:first-child {
	margin-top: 0 !important;
}

.msg-body blockquote {
	background: transparent !important;
	border: none !important;
	border-left: 2px solid rgba(255, 255, 255, 0.32) !important;
	margin: 0.35em 0 !important;
	padding: 2px 0 2px 10px !important;
	opacity: 0.92 !important;
}

.msg-body hr {
	margin: 0.5em 0 !important;
	border: none !important;
	border-top: 1px solid rgba(255, 255, 255, 0.12) !important;
}

.msg-body table {
	background: transparent !important;
	border-collapse: collapse !important;
	border: 1px solid rgba(255, 255, 255, 0.14) !important;
	margin: 0.4em 0 !important;
	font-size: 13.5px !important;
}
.msg-body th, .msg-body td {
	background: transparent !important;
	border: 1px solid rgba(255, 255, 255, 0.10) !important;
	padding: 4px 8px !important;
}

.msg-body code:not(pre code) {
	background: color-mix(in srgb, var(--text) 8%, transparent) !important;
	border: 1px solid rgba(255, 255, 255, 0.14) !important;
	border-radius: 4px !important;
	padding: 1px 4px !important;
}

.msg-body pre {
	background: rgba(6, 8, 12, 0.72) !important;
	border: 1px solid rgba(255, 255, 255, 0.12) !important;
	border-radius: 8px !important;
	margin: 0.42em 0 !important;
	padding: 8px 12px !important;
	line-height: 1.45 !important;
	font-size: 13px !important;
}

/* -------------------------------------------------------------
   字级输入流系统（Character-Level Inline Stream）：
   对话流就像一个输入框，每个工具调用、思考、附件就是一个字。
   无折叠按钮，无任何换行，字字连贯，一点一点混排流进正文中。
   ------------------------------------------------------------- */

/* 1. 助手消息体：完全作为文字流容器，不设多余内外边距 */
.turn-tools-trail {
	display: flex !important;
	flex-direction: row !important;
	flex-wrap: wrap !important;
	align-items: center !important;
	gap: 6px !important;
	margin: 6px 0 16px 0 !important;
	padding: 0 !important;
	width: 100% !important;
}
.turn-tools-trail > .msg,
.turn-tools-trail > .msg-assistant,
.turn-tools-trail > .msg .msg-body,
.turn-tools-trail > .msg-assistant .msg-body {
	display: contents !important;
	width: auto !important;
}
/* 彻底隐藏工具流集群内的元数据行（角色/模型/时间）与操作栏，杜绝100%全宽节点打断胶囊横向流动 */
.turn-tools-trail .msg-meta,
.turn-tools-trail .msg-actions,
.turn-tools-trail > .msg > .msg-meta,
.turn-tools-trail > .msg > .msg-actions,
.turn-tools-trail > .msg-assistant > .msg-meta,
.turn-tools-trail > .msg-assistant > .msg-actions {
	display: none !important;
	width: 0 !important;
	height: 0 !important;
	margin: 0 !important;
	padding: 0 !important;
}
/* 消除兄弟选择器在横向流中对卡头施加的任何 border 细线，彻底清零外边距 */
.turn-tools-trail .chead,
.turn-tools-trail .toolcall .chead,
.turn-tools-trail .thinking .chead,
.turn-tools-trail .toolcall + .toolcall .chead,
.turn-tools-trail .thinking + .toolcall .chead,
.turn-tools-trail .toolcall + .thinking .chead,
.turn-tools-trail * .chead {
	border: none !important;
	margin: 0 !important;
}
.turn-tools-trail .thinking,
.turn-tools-trail .toolcall,
.main.hide-model-row .turn-tools-trail .thinking,
.main.hide-model-row .turn-tools-trail .toolcall,
.main.hide-model-row .msg-assistant .turn-tools-trail .thinking,
.main.hide-model-row .msg-assistant .turn-tools-trail .toolcall {
	display: inline-flex !important;
	align-items: center !important;
	justify-content: center !important;
	vertical-align: middle !important;
	box-sizing: border-box !important;
	width: auto !important;
	min-width: 0 !important;
	max-width: fit-content !important;
	flex: 0 0 auto !important;
	flex-shrink: 0 !important;
	height: 22px !important;
	line-height: 20px !important;
	margin: 0 !important;
	padding: 0 7px !important;
	overflow: hidden !important;
	contain: layout paint !important;
	white-space: nowrap !important;
}

/* 流式待定等待指示器：锁定微胶囊尺寸，杜绝首帧大文本撑宽换行引发闪现回跳 */
.turn-tools-trail .thinking-wait {
	display: inline-flex !important;
	align-items: center !important;
	justify-content: center !important;
	vertical-align: middle !important;
	box-sizing: border-box !important;
	width: auto !important;
	min-width: 0 !important;
	max-width: fit-content !important;
	height: 22px !important;
	line-height: 20px !important;
	padding: 0 7px !important;
	margin: 0 !important;
	font-size: 11px !important;
	font-family: var(--mono, monospace) !important;
	border-radius: 999px !important;
	background: color-mix(in srgb, var(--text) 5%, transparent) !important;
	border: 1px solid rgba(255, 255, 255, 0.09) !important;
	flex: 0 0 auto !important;
	flex-shrink: 0 !important;
	contain: layout paint !important;
	white-space: nowrap !important;
}

.msg-assistant .msg-body {
	display: block !important;
	line-height: 1.62 !important;
	font-size: 14px !important;
	letter-spacing: 0.015em !important;
	word-break: break-word !important;
}

/* 2. 工具调用、思考、附件徽标：Apple Vision 液态亚克力呼吸晶体微胶囊
   胶囊不上 backdrop-filter：行内重复项每颗各占一个合成表面（300 颗 = 310 层），
   而且壁纸底下是每帧都在变的视频/WebGL 画面，逐颗回读+12px 卷积是最贵的用法。 */
.toolcall,
.thinking {
	display: inline-flex !important;
	align-items: center !important;
	justify-content: center !important;
	vertical-align: middle !important;
	box-sizing: border-box !important;
	width: auto !important;
	min-width: 0 !important;
	max-width: fit-content !important;
	flex: 0 0 auto !important;
	flex-shrink: 0 !important;
	height: 23px !important;
	line-height: 21px !important;
	margin: 0 !important;
	padding: 0 8px !important;
	background: color-mix(in srgb, var(--text) 5%, transparent) !important;
	border: 1px solid rgba(255, 255, 255, 0.09) !important;
	border-radius: 999px !important;
	font-family: var(--mono, monospace) !important;
	font-size: 11px !important;
	font-weight: 500 !important;
	cursor: pointer !important;
	white-space: nowrap !important;
	box-shadow:
		inset 0 0.5px 0.5px rgba(255, 255, 255, 0.22),
		0 2px 5px rgba(0, 0, 0, 0.35) !important;
	backdrop-filter: none !important;
	-webkit-backdrop-filter: none !important;
	transition:
		background 0.15s cubic-bezier(0.16, 1, 0.3, 1),
		border-color 0.15s cubic-bezier(0.16, 1, 0.3, 1),
		box-shadow 0.15s cubic-bezier(0.16, 1, 0.3, 1) !important;
	overflow: hidden !important;
	contain: layout paint !important;
	user-select: none !important;
	text-decoration: none !important;
}

.toolcall:hover,
.thinking:hover {
	background: color-mix(in srgb, var(--text) 9%, transparent) !important;
	border-color: rgba(255, 255, 255, 0.22) !important;
	box-shadow:
		inset 0 1px 1px rgba(255, 255, 255, 0.35),
		0 4px 10px rgba(0, 0, 0, 0.45) !important;
	transform: translateY(-1px) !important;
	transition:
		background 0.15s cubic-bezier(0.16, 1, 0.3, 1),
		border-color 0.15s cubic-bezier(0.16, 1, 0.3, 1),
		box-shadow 0.15s cubic-bezier(0.16, 1, 0.3, 1),
		transform 0.15s cubic-bezier(0.16, 1, 0.3, 1) !important;
}

/* 状态氛围微光点睛 */
.toolcall.run {
	border-color: rgba(245, 158, 11, 0.45) !important;
	box-shadow:
		inset 0 0.5px 0.5px rgba(255, 255, 255, 0.25),
		0 0 10px rgba(245, 158, 11, 0.25) !important;
}

.toolcall.ok {
	border-color: rgba(52, 211, 153, 0.25) !important;
}

.toolcall.err {
	border-color: rgba(248, 113, 113, 0.45) !important;
	box-shadow:
		inset 0 0.5px 0.5px rgba(255, 255, 255, 0.25),
		0 0 10px rgba(239, 68, 68, 0.25) !important;
}

/* 思考徽标：淡紫微晶调色 */
.thinking {
	border-color: rgba(192, 132, 252, 0.25) !important;
}
.thinking:hover {
	border-color: rgba(192, 132, 252, 0.45) !important;
}
.thinking.run {
	border-color: rgba(192, 132, 252, 0.5) !important;
	box-shadow:
		inset 0 0.5px 0.5px rgba(255, 255, 255, 0.25),
		0 0 10px rgba(192, 132, 252, 0.25) !important;
}
.thinking.ok {
	border: none !important;
}

/* 彻底隐藏流内图片缩略图，read 的图片绝不直接塞在流里破坏胶囊排布；
   用户点击胶囊时由居中弹窗 Tool Inspector 完整展示高清大图与详情 */
.toolcall-images,
.toolcall-image,
.toolcall .toolcall-images {
	display: none !important;
}

/* 3. 卡头：自适应内容宽度，严格水平垂直对齐 */
.toolcall .toolcall-head,
.toolcall .chead,
.thinking .chead {
	display: inline-flex !important;
	align-items: center !important;
	justify-content: center !important;
	vertical-align: middle !important;
	box-sizing: border-box !important;
	width: auto !important;
	min-width: 0 !important;
	max-width: fit-content !important;
	min-height: unset !important;
	height: 100% !important;
	padding: 0 !important;
	margin: 0 !important;
	border: none !important;
	border-top: none !important;
	border-bottom: none !important;
	background: transparent !important;
	gap: 4px !important;
	box-shadow: none !important;
	line-height: 1 !important;
	flex: 0 0 auto !important;
	flex-shrink: 0 !important;
	white-space: nowrap !important;
}

/* 彻底隐藏一切占位、折叠、复制等破坏行内流动性的元素：不需要折叠按钮、不需要长文本，所有按钮只显示名称与状态 */
.toolcall .chead-toggle,
.toolcall .toolcall-toggle,
.toolcall .toolcall-spacer,
.toolcall .chead-copy,
.toolcall .toolcall-copy,
.toolcall .toolcall-path,
.toolcall .toolcall-cmd,
.toolcall .toolcall-query,
.toolcall .toolcall-timeout,
.toolcall .toolcall-agent,
.toolcall .toolcall-open,
.toolcall .toolcall-kill,
.toolcall .toolcall-duration,
.thinking .chead-toggle,
.thinking .thinking-toggle,
.thinking .chead-copy,
.thinking .thinking-copy,
.thinking .thinking-spacer,
.thinking .thinking-summary-text,
.thinking .thinking-preview-live,
.thinking .thinking-preview-viewport,
.thinking .thinking-preview-track,
.thinking .thinking-preview-prefix,
.thinking .thinking-live-label,
.thinking-summary {
	display: none !important;
}

/* 图标与标题：字级微雕尺寸 */
.chead-icon,
.chead-icon.thinking-icon,
.chead-icon.toolcall-icon,
.toolcall-icon,
.toolcall-head svg,
.thinking-icon,
.thinking svg {
	display: inline-flex !important;
	align-items: center !important;
	justify-content: center !important;
	width: 12px !important;
	height: 12px !important;
	padding: 0 !important;
	margin: 0 !important;
	border-radius: 0 !important;
	background: transparent !important;
	flex: none !important;
	opacity: 0.82 !important;
	font-size: 10px !important;
}

.toolcall-name,
.chead-title.toolcall-name,
.thinking-name,
.thinking-label,
.chead-title.thinking-label {
	display: inline-flex !important;
	align-items: center !important;
	justify-content: center !important;
	line-height: 1 !important;
	font-size: 11px !important;
	font-weight: 500 !important;
	color: var(--text) !important;
	padding: 0 !important;
	margin: 0 !important;
	flex: none !important;
	min-width: unset !important;
	max-width: unset !important;
	letter-spacing: 0.02em !important;
}

.thinking .thinking-name {
	color: var(--text) !important;
}
.thinking .thinking-icon,
.thinking .thinking-status {
	color: #c084fc !important;
	filter: drop-shadow(0 0 4px rgba(192, 132, 252, 0.75)) !important;
}

/* 语义化工具微光宝石呼吸灯 */
.toolcall-icon.tc-tone-exec {
	color: #38bdf8 !important;
	filter: drop-shadow(0 0 4px rgba(56, 189, 248, 0.75)) !important;
}
.toolcall-icon.tc-tone-read,
.toolcall-icon.tc-tone-search {
	color: #34d399 !important;
	filter: drop-shadow(0 0 4px rgba(52, 211, 153, 0.75)) !important;
}
.toolcall-icon.tc-tone-edit {
	color: var(--amber) !important;
	filter: drop-shadow(0 0 4px rgba(251, 191, 36, 0.75)) !important;
}
.toolcall-icon.tc-tone-code {
	color: #e879f9 !important;
	filter: drop-shadow(0 0 4px rgba(232, 121, 249, 0.75)) !important;
}
.toolcall-icon.tc-tone-agent {
	color: var(--red) !important;
	filter: drop-shadow(0 0 4px rgba(248, 113, 113, 0.75)) !important;
}

.toolcall.ok .toolcall-status {
	color: #34d399 !important;
	filter: drop-shadow(0 0 3px rgba(52, 211, 153, 0.6)) !important;
}
.toolcall.err .toolcall-status {
	color: var(--red) !important;
	filter: drop-shadow(0 0 4px rgba(248, 113, 113, 0.8)) !important;
}

.toolcall-status,
.thinking-status {
	display: inline-flex !important;
	align-items: center !important;
	justify-content: center !important;
	vertical-align: middle !important;
	width: 11px !important;
	height: 11px !important;
	font-size: 9px !important;
	flex: none !important;
	margin: 0 !important;
	padding: 0 !important;
}
.toolcall-status > svg,
.toolcall-status svg,
.thinking-status > svg,
.thinking-status svg {
	width: 10px !important;
	height: 10px !important;
	margin: 0 !important;
	padding: 0 !important;
}
.thinking-status .spin,
.toolcall-status .spin,
.toolcall-status .half-ring-spin,
.thinking-status .half-ring-spin,
.toolcall.run .toolcall-status svg,
.toolcall.run .toolcall-status-icon svg {
	animation: spin 0.85s linear infinite !important;
	transform-origin: center center !important;
}

/* 特殊输出代表性微标：图片 🖼️、Markdown 📝 等精致小徽标，行内零干扰 */
.toolcall-out-badge {
	display: inline-flex !important;
	align-items: center !important;
	justify-content: center !important;
	vertical-align: middle !important;
	width: 11px !important;
	height: 11px !important;
	font-size: 9.5px !important;
	margin: 0 !important;
	padding: 0 !important;
	flex: none !important;
	opacity: 0.85 !important;
}
.toolcall-out-badge.img {
	color: #38bdf8 !important;
}
.toolcall-out-badge.md {
	color: #a78bfa !important;
}
.toolcall-out-badge svg {
	width: 10px !important;
	height: 10px !important;
	margin: 0 !important;
	padding: 0 !important;
}

/* 4. 附件也是一个“字”：排布在同一输入流中，外边距清零由 gap 管理 */
.msg-queued-atts-bar {
	display: inline-flex !important;
	align-items: center !important;
	gap: 6px !important;
	margin: 0 !important;
	padding: 0 !important;
}
.queued-att-chip,
.attach-chip {
	display: inline-flex !important;
	align-items: center !important;
	vertical-align: middle !important;
	box-sizing: border-box !important;
	height: 22px !important;
	line-height: 20px !important;
	margin: 0 !important;
	padding: 0 7px !important;
	font-size: 11px !important;
	border-radius: 5px !important;
}

/* 5. 核心铁律：正文文本自成段落倾泻，与上方工具流保持呼吸间距 */
.msg-assistant .msg-text {
	display: block !important;
	padding: 0 !important;
	margin: 8px 0 0 0 !important;
}
.msg-assistant .msg-text > .markdown {
	display: inline !important;
}
.msg-assistant .msg-text > .markdown > p:first-child {
	display: inline !important;
	margin: 0 !important;
}

/* 6. 核心：彻底隐藏原地展开内容，点击由检查器弹窗全屏/居中接管 */
.toolcall-body,
.thinking-body {
	display: none !important;
}

.msg-actions {
	opacity: 0.3 !important;
	margin-top: 2px !important;
	transition: opacity 0.15s ease !important;
}
.msg-assistant:hover .msg-actions,
.msg-user:hover .msg-actions {
	opacity: 1 !important;
}

.card {
	background: transparent !important;
	border: none !important;
	box-shadow: none !important;
}
`
		: `
/* 4-B. 黑曜冷月默认模式：单个气泡独立圆角与轻微毛玻璃背景 */
.msg-assistant .msg-body {
	background: rgba(12, 18, 32, 0.38) !important;
	border: 1px solid rgba(255, 255, 255, 0.05) !important;
	border-radius: 16px !important;
	box-shadow: none !important;
	backdrop-filter: blur(2px) saturate(115%) !important;
	-webkit-backdrop-filter: blur(2px) saturate(115%) !important;
	overflow: hidden !important;
}

/* 正文消息（最终文本回复）与上方工具卡、思考块左侧完全对齐留出边距，消除顶格突兀感 */
.msg-text {
	padding: 6px 12px !important;
	border-radius: 8px !important;
}

/* 黑曜冷月专属回合工具集群：单列优雅纵向卡片流，独立圆角微晶质感，杜绝横向挤压变形 */
.turn-tools-trail {
	display: flex !important;
	flex-direction: column !important;
	width: 100% !important;
	min-width: 0 !important;
	max-width: 100% !important;
	margin: 4px 0 8px 0 !important;
	gap: 0 !important;
}
.turn-tools-trail > .msg,
.turn-tools-trail > .msg-assistant {
	display: block !important;
	width: 100% !important;
	min-width: 0 !important;
	margin: 0 !important;
	padding: 0 !important;
}
.turn-tools-trail > .msg .msg-body,
.turn-tools-trail > .msg-assistant .msg-body {
	display: block !important;
	width: 100% !important;
	min-width: 0 !important;
	background: rgba(12, 18, 32, 0.38) !important;
	border: 1px solid rgba(255, 255, 255, 0.05) !important;
	border-radius: 12px !important;
	margin: 2px 0 !important;
	overflow: hidden !important;
}
.turn-tools-trail .thinking,
.turn-tools-trail .toolcall,
.toolcall,
.thinking {
	display: block !important;
	width: 100% !important;
	min-width: 0 !important;
	max-width: 100% !important;
	height: auto !important;
	line-height: inherit !important;
	margin: 0 !important;
}
.chead {
	display: flex !important;
	width: 100% !important;
	min-width: 0 !important;
	max-width: 100% !important;
	height: auto !important;
}
.action-suggestions {
	display: block !important;
	clear: both !important;
	width: 100% !important;
	min-width: 0 !important;
	margin: 12px 0 16px 0 !important;
	padding: 0 4px !important;
}
`
}

/* 4.1 全页面可见文字防眩光阴影（标题、项目名、会话名、正文字等），微小黑色阴影紧锁边缘，绝不晕染发糊 */
.topbar,
.topbar-title,
.bar-item-text,
.bar-item-badge,
.brand,
.brand *,
.lp-section-header,
.lp-section-title,
.lp-group-title,
.project-name,
.session-title,
.lp-conv-title,
.ft-name,
.quick-chip,
.attach-chip,
.attach-range,
.attachcard-name,
.attachcard-path,
.attachcard-mode,
.attachcard-refnote,
.quote-source,
.quote-preview,
.slash-name,
.msg-editor-file,
.msg-assistant,
.msg-assistant *,
.msg-text,
.msg-text *,
.msg-body,
.msg-body *,
.msg-body p,
.msg-body li,
.msg-body ul,
.msg-body ol,
.msg-body h1,
.msg-body h2,
.msg-body h3,
.msg-body h4,
.msg-body h5,
.msg-body h6,
.msg-body strong,
.msg-body b,
.msg-body em,
.msg-body i,
.msg-body span,
.msg-body a,
.msg-body blockquote,
.msg-body table,
.msg-body td,
.msg-body th,
.msg-body code:not(pre code),
.thinking-title,
.thinking-summary,
.thinking-body,
.thinking-body *,
.tool-title,
.toolcall-name,
.chead-title,
button:not(.icon-btn):not(.lp-section-action),
.btn {
	${
		lightWallpaperMode
			? `text-shadow:
		-1px -1px 0 rgba(0, 0, 0, 0.95),
		 1px -1px 0 rgba(0, 0, 0, 0.95),
		-1px  1px 0 rgba(0, 0, 0, 0.95),
		 1px  1px 0 rgba(0, 0, 0, 0.95),
		 0 1px 2px rgba(0, 0, 0, 0.9) !important;`
			: `text-shadow: 0 0 1px rgba(0, 0, 0, 0.95), 0 1px 1.5px rgba(0, 0, 0, 0.88) !important;`
	}
}

/* 4.2 次要与偏黑小字全面保护（项目路径、时间戳、会话副标题、分区计数、底栏所有小指标等）：提亮并应用零扩散紧致微暗边缘，绝不隐形，绝不糊黑 */
.project-path,
.project-time,
.session-sub,
.session-meta,
.session-time,
.ft-path,
.ft-size,
.ft-date,
.msg-time,
.msg-role,
.bar-item-char,
.cwd-sub,
.lp-section-count,
.lp-count,
.statusbar,
.statusbar *,
.footer-bar,
.footer-bar *,
.ctx-val,
.ctx-max,
.status-conn-label,
.status-cache-label,
.engine-picker-name,
.engine-badge,
.text-dim,
.text-faint,
.version-text,
.template-desc,
.inputbox textarea {
	color: var(--text) !important;
	opacity: 0.95 !important;
	text-shadow:
		0 0 1px rgba(0, 0, 0, 0.95),
		0 1px 1px rgba(0, 0, 0, 0.85) !important;
}

.project-path,
.session-meta {
	color: var(--text) !important;
	opacity: 0.92 !important;
}

.project-time,
.session-time {
	color: var(--text) !important;
	opacity: 0.95 !important;
}

${
	lightWallpaperMode
		? `
/* 4.3 亮色壁纸增强偏光晶层：轻微压制高亮刺眼白光，让壁纸与白字达到最舒适对比度 */
#pi-we-bg-container::after {
	content: "" !important;
	position: absolute !important;
	inset: 0 !important;
	background: rgba(0, 0, 0, 0.14) !important;
	pointer-events: none !important;
	z-index: 1 !important;
}
`
		: ""
}

/* 5. 用户提问消息气泡：独立微晶毛玻璃气泡（带圆角） */
.msg-user {
	background: transparent !important;
	box-shadow: none !important;
	${isFlowTheme ? "margin: 6px 0 2px 0 !important;" : ""}
}

.msg-user .msg-body {
	${
		isFlowTheme
			? `background: linear-gradient(135deg, rgba(28, 30, 40, 0.55) 0%, rgba(16, 18, 24, 0.45) 100%) !important;
	border: 1px solid rgba(255, 255, 255, 0.12) !important;
	border-radius: 12px !important;
	padding: 6px 12px !important;
	box-shadow: none !important;
	backdrop-filter: blur(2px) saturate(115%) !important;
	-webkit-backdrop-filter: blur(2px) saturate(115%) !important;`
			: `background: linear-gradient(135deg, rgba(30, 32, 40, 0.68) 0%, rgba(18, 19, 24, 0.58) 100%) !important;
	border: 1px solid rgba(255, 255, 255, 0.12) !important;
	border-radius: 16px !important;
	box-shadow: none !important;
	backdrop-filter: blur(2px) saturate(115%) !important;
	-webkit-backdrop-filter: blur(2px) saturate(115%) !important;`
	}
}

/* 6. 输入框外壳（.inputbox）与底部控制栏（回形针、麦克风、书本、模型/思考/权限胶囊等全适配）：轻微毛玻璃磨砂 */
.inputbox {
	background: rgba(12, 14, 20, 0.48) !important;
	border: 1px solid rgba(255, 255, 255, 0.22) !important;
	border-radius: 20px !important;
	box-shadow: none !important;
	backdrop-filter: blur(10px) saturate(130%) !important;
	-webkit-backdrop-filter: blur(10px) saturate(130%) !important;
	transition: border-color 0.2s ease;
}

.inputbox:focus-within {
	border-color: ${pal.focusBorder} !important;
	box-shadow: none !important;
}

.inputbox textarea {
	background: transparent !important;
	color: var(--text) !important;
	text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
}

/* 6.1 输入框底部工具条：胶囊文字（高、完全权限、全功能等）彻底提亮为纯白，防眩光锁边 */
.composer-tools,
.composer-tools-left,
.composer-tools-center,
.composer-tools-right {
	color: var(--text) !important;
}

.composer-tools .chip {
	background: rgba(14, 20, 36, 0.45) !important;
	border: 1px solid rgba(56, 189, 248, 0.28) !important;
	color: var(--text) !important;
	box-shadow: none !important;
	transition: background 0.15s ease, border-color 0.15s ease;
}

.composer-tools .chip:hover {
	background: rgba(14, 20, 36, 0.65) !important;
	border-color: ${pal.accent} !important;
}

.composer-tools .chip > span,
.composer-tools .chip > span.chip-model,
.composer-tools .chip > span.chip-sub,
.composer-tools .chip-sub {
	color: var(--text) !important;
	opacity: 0.98 !important;
	text-shadow:
		0 0 1px rgba(0, 0, 0, 0.95),
		0 1px 1.5px rgba(0, 0, 0, 0.85) !important;
}

.composer-tools .chip > svg,
.composer-tools .dd-caret svg,
.composer-tools .dd-caret,
.inputbox .composer-tools-left button svg,
.inputbox .btn.composer-plugin-action svg,
.inputbox .composer-tools-left .btn svg {
	color: var(--text) !important;
	stroke: #f8fafc !important;
	filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.95)) drop-shadow(0 1px 1.2px rgba(0, 0, 0, 0.85)) !important;
}

.inputbox .composer-tools-left button,
.inputbox .btn.composer-plugin-action,
.inputbox .composer-tools-left .btn {
	filter: none !important;
}

/* 胶囊按钮（模型、思考、权限、预设等下拉）恒定保持 8px 圆角矩形，悬停绝不变形为扁平椭圆 */
.composer-tools .chip,
.composer-tools .chip:hover,
.composer-tools .dropdown > button,
.composer-tools .dropdown > button:hover,
.dropdown > button.chip,
.dropdown > button.chip:hover {
	border-radius: 8px !important;
}

/* 仅针对左侧附件等纯图标小按钮悬停时轻微高光，绝不改变任何下拉胶囊圆角 */
.inputbox .btn.composer-plugin-action:not(.chip):hover,
.inputbox .composer-tools-left > button:not(.chip):not(.dropdown):hover {
	color: ${pal.accent} !important;
	background: color-mix(in srgb, var(--text) 12%, transparent) !important;
	border-radius: 6px !important;
}

/* 发送按钮（冷白银辉高光圆钮 + 深黑箭头，高对比度清晰锋利，绝不白底隐形） */
.inputbox .btn.send {
	background: #f8fafc !important;
	border-color: var(--text) !important;
	color: #050507 !important;
	box-shadow: 0 2px 12px rgba(255, 255, 255, 0.35) !important;
}
.inputbox .btn.send svg {
	stroke: #050507 !important;
	color: #050507 !important;
	filter: none !important;
}
.inputbox .btn.send:hover:not(:disabled) {
	background: #ffffff !important;
	border-color: var(--text) !important;
	color: #000000 !important;
	box-shadow: 0 0 16px rgba(255, 255, 255, 0.55) !important;
	transform: translateY(-1px);
}
.inputbox .btn.send:disabled {
	opacity: 0.35 !important;
	box-shadow: none !important;
	cursor: default !important;
}
.inputbox .btn.send:disabled svg {
	stroke: #050507 !important;
	color: #050507 !important;
	filter: none !important;
}

/* 运行中插队/排队分裂胶囊按钮（银白双段胶囊，黑箭黑单，分界清晰） */
.inputbox .split-send {
	background: #f8fafc !important;
	border-color: var(--text) !important;
	box-shadow: 0 2px 12px rgba(255, 255, 255, 0.35) !important;
}
.inputbox .split-send button {
	color: #050507 !important;
}
.inputbox .split-send button svg {
	stroke: #050507 !important;
	color: #050507 !important;
	filter: none !important;
}
.inputbox .split-send .split-queue {
	background: rgba(0, 0, 0, 0.08) !important;
}
.inputbox .split-send button + button {
	border-left: 1px solid rgba(0, 0, 0, 0.18) !important;
}
.inputbox .split-send:hover {
	background: #ffffff !important;
	border-color: var(--text) !important;
	box-shadow: 0 0 16px rgba(255, 255, 255, 0.55) !important;
}
.inputbox .split-send button:hover:not(:disabled) {
	background: rgba(0, 0, 0, 0.12) !important;
}

/* 7. 卡片、代码块与工具调用：方案 B（纯净无界微透流 · 连成一体无空隙） */
.card {
	background: color-mix(in srgb, var(--text) 4%, transparent) !important;
	border: none !important;
	border-radius: 10px !important;
	box-shadow: none !important;
}

/* 工具调用（.toolcall）、思考块（.thinking）彻底消除外边距，连成一体，杜绝百叶窗斑马线切碎背景 */
.toolcall,
.thinking {
	background: transparent !important;
	border: none !important;
	border-radius: 0 !important;
	margin: 0 !important;
	box-shadow: none !important;
	backdrop-filter: none !important;
	-webkit-backdrop-filter: none !important;
}

/* 折叠条（.chead）：紧凑平整悬浮，完全不设边框与独立外边距，内边距与 .msg-text 对齐 */
.chead {
	background: transparent !important;
	border: none !important;
	border-radius: 0 !important;
	padding: 6px 12px !important;
	margin: 0 !important;
	position: relative !important;
	box-shadow: none !important;
	backdrop-filter: none !important;
	-webkit-backdrop-filter: none !important;
	transition: background 0.15s ease !important;
}

.chead:hover {
	background: color-mix(in srgb, var(--text) 6%, transparent) !important;
}

/* 条目之间仅以 1px 极微弱细线无缝分割，消除任何漏景空隙 */
.toolcall + .toolcall .chead,
.thinking + .toolcall .chead,
.toolcall + .thinking .chead {
	border-top: 1px solid rgba(255, 255, 255, 0.04) !important;
}

/* 工具组首项与末项圆角封闭，整组浑然一体 */
.msg-body > .toolcall:first-child .chead,
.msg-body > .thinking:first-child .chead {
	border-top-left-radius: 8px !important;
	border-top-right-radius: 8px !important;
}
.msg-body > .toolcall:last-child .chead,
.msg-body > .thinking:last-child .chead {
	border-bottom-left-radius: 8px !important;
	border-bottom-right-radius: 8px !important;
}

.toolcall .chead::before,
.thinking .chead::before {
	display: none !important;
}

pre, code {
	text-shadow: none !important;
}

pre {
	background: ${pal.codeBg} !important;
	border: 1px solid rgba(255, 255, 255, 0.08) !important;
	border-radius: 10px !important;
	box-shadow: none !important;
}

/* 7.1 工具调用与思考文字：彻底提亮为高对比纯白，注入1像素紧致微暗边缘 */
.toolcall-name,
.chead-title.toolcall-name,
.toolcall-path,
.toolcall-cmd,
.toolcall-agent,
.toolcall-status,
.toolcall-output-label,
.thinking-label,
.thinking-live-label,
.thinking-preview-prefix,
.thinking-preview-track,
.thinking-preview-live,
.thinking-wait,
.thinking-body p,
.thinking-body li,
.thinking-body span,
.thinking-body strong,
.thinking-body em {
	color: var(--text) !important;
	opacity: 0.98 !important;
	text-shadow:
		0 0 1px rgba(0, 0, 0, 0.95),
		0 1px 1.5px rgba(0, 0, 0, 0.85) !important;
}

.toolcall-path,
.toolcall-cmd {
	color: var(--text) !important;
}

/* 8. 文件引用与快捷短语芯片：微透毛玻璃磨砂晶体胶囊 */
.quick-chip {
	background: rgba(14, 16, 24, 0.45) !important;
	border: 1px solid rgba(255, 255, 255, 0.16) !important;
	border-radius: 14px !important;
	backdrop-filter: blur(8px) saturate(130%) !important;
	-webkit-backdrop-filter: blur(8px) saturate(130%) !important;
	box-shadow: none !important;
	text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9) !important;
}

.quick-chip:hover {
	background: color-mix(in srgb, var(--text) 16%, transparent) !important;
	border-color: rgba(255, 255, 255, 0.4) !important;
}

/* 文件引用与附件芯片（.attach-chip 系列：全形态磨砂微晶胶囊） */
.attach-chip {
	background: rgba(18, 16, 28, 0.52) !important;
	border: 1px solid rgba(168, 85, 247, 0.35) !important;
	border-radius: 999px !important;
	backdrop-filter: blur(8px) saturate(130%) !important;
	-webkit-backdrop-filter: blur(8px) saturate(130%) !important;
	box-shadow: none !important;
	color: var(--text) !important;
	text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9) !important;
	transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease !important;
}

.attach-chip:hover {
	background: rgba(168, 85, 247, 0.22) !important;
	border-color: rgba(168, 85, 247, 0.6) !important;
}

/* 核心：文件引用专属形态（.attach-chip.reference，金黄/琥珀微晶流） */
.attach-chip.reference {
	background: rgba(36, 28, 12, 0.55) !important;
	border-color: rgba(251, 191, 36, 0.45) !important;
	color: var(--amber-text) !important;
}

.attach-chip.reference:hover {
	background: rgba(251, 191, 36, 0.22) !important;
	border-color: rgba(251, 191, 36, 0.7) !important;
}

/* 按行引用（.attach-chip.lines，翠绿微晶流） */
.attach-chip.lines {
	background: rgba(12, 32, 24, 0.55) !important;
	border-color: rgba(52, 211, 153, 0.45) !important;
	color: #d1fae5 !important;
}

.attach-chip.lines:hover {
	background: rgba(52, 211, 153, 0.22) !important;
	border-color: rgba(52, 211, 153, 0.7) !important;
}

/* 文件附件（.attach-chip.file，冰蓝微晶流） */
.attach-chip.file {
	background: rgba(14, 24, 40, 0.55) !important;
	border-color: rgba(96, 165, 250, 0.45) !important;
	color: #dbeafe !important;
}

.attach-chip.file:hover {
	background: rgba(96, 165, 250, 0.22) !important;
	border-color: rgba(96, 165, 250, 0.7) !important;
}

/* 网页引用（.attach-chip.page，青蓝微晶流） */
.attach-chip.page {
	background: rgba(12, 28, 40, 0.55) !important;
	border-color: rgba(56, 189, 248, 0.45) !important;
	color: #e0f2fe !important;
}

.attach-chip.page:hover {
	background: rgba(56, 189, 248, 0.22) !important;
	border-color: rgba(56, 189, 248, 0.7) !important;
}

/* 图片附件（.attach-chip.image，洋红微晶流） */
.attach-chip.image {
	background: rgba(36, 16, 28, 0.55) !important;
	border-color: rgba(244, 114, 182, 0.45) !important;
	color: var(--accent) !important;
}

.attach-chip.image:hover {
	background: rgba(244, 114, 182, 0.22) !important;
	border-color: rgba(244, 114, 182, 0.7) !important;
}

/* 引用行号胶囊（.attach-range）与移除按钮（.attach-remove） */
.attach-range {
	background: rgba(52, 211, 153, 0.2) !important;
	border: 1px solid rgba(52, 211, 153, 0.4) !important;
	color: #6ee7b7 !important;
	text-shadow: 0 1px 1px rgba(0, 0, 0, 0.8) !important;
}

.attach-remove {
	color: var(--text-dim) !important;
	text-shadow: none !important;
	transition: color 0.15s ease, transform 0.15s ease !important;
}

.attach-remove:hover {
	color: var(--red) !important;
	transform: scale(1.15) !important;
}

/* 编辑消息里的文件引用 chip */
.msg-editor-img.file-chip {
	background: rgba(14, 24, 40, 0.55) !important;
	backdrop-filter: blur(${chipBlur}px) saturate(125%) !important;
	-webkit-backdrop-filter: blur(${chipBlur}px) saturate(125%) !important;
	border: 1px solid rgba(96, 165, 250, 0.4) !important;
	border-radius: 8px !important;
	box-shadow: none !important;
}

.msg-editor-file {
	color: var(--text) !important;
	text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9) !important;
}

/* 8.1 消息流中的文件引用卡片（.attachcard）与选区引用（.quote-card）：微透毛玻璃晶体质感 */
.attachcard {
	background: rgba(14, 16, 26, 0.52) !important;
	border: 1px solid rgba(255, 255, 255, 0.14) !important;
	border-radius: 12px !important;
	backdrop-filter: blur(${chipBlur}px) saturate(125%) !important;
	-webkit-backdrop-filter: blur(${chipBlur}px) saturate(125%) !important;
	box-shadow: none !important;
	overflow: hidden !important;
}

.attachcard.reference {
	background: rgba(24, 20, 14, 0.55) !important;
	border: 1px solid rgba(251, 191, 36, 0.35) !important;
}

.attachcard.page {
	background: rgba(10, 22, 34, 0.55) !important;
	border: 1px solid rgba(56, 189, 248, 0.35) !important;
}

.attachcard.conversation {
	background: rgba(20, 14, 30, 0.55) !important;
	border: 1px solid rgba(168, 85, 247, 0.35) !important;
}

.attachcard-head {
	background: transparent !important;
	border: none !important;
}

.attachcard-name {
	color: var(--text) !important;
	text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9) !important;
}

.attachcard-path {
	color: var(--text-dim) !important;
	text-shadow: 0 1px 1.5px rgba(0, 0, 0, 0.85) !important;
}

.attachcard-refnote {
	background: rgba(251, 191, 36, 0.08) !important;
	border-top: 1px dashed rgba(251, 191, 36, 0.25) !important;
	color: var(--amber-text) !important;
	text-shadow: 0 1px 1px rgba(0, 0, 0, 0.8) !important;
}

.attachcard-bridgenote {
	background: rgba(168, 85, 247, 0.08) !important;
	border-bottom: 1px solid rgba(168, 85, 247, 0.2) !important;
	color: var(--plugin-purple) !important;
}

.attachcard-content {
	background: rgba(6, 8, 14, 0.6) !important;
	border-top: 1px solid rgba(255, 255, 255, 0.08) !important;
	color: var(--text) !important;
}

.attachcard-mode {
	background: color-mix(in srgb, var(--text) 6%, transparent) !important;
	border: 1px solid rgba(255, 255, 255, 0.18) !important;
	color: var(--text-dim) !important;
}

.attachcard-mode.ref {
	background: rgba(251, 191, 36, 0.14) !important;
	border-color: rgba(251, 191, 36, 0.4) !important;
	color: var(--amber-text) !important;
}

.attachcard-mode.lines {
	background: rgba(52, 211, 153, 0.14) !important;
	border-color: rgba(52, 211, 153, 0.4) !important;
	color: #6ee7b7 !important;
}

.attachcard-mode.page {
	background: rgba(56, 189, 248, 0.14) !important;
	border-color: rgba(56, 189, 248, 0.4) !important;
	color: #7dd3fc !important;
}

.attachcard-mode.conversation {
	background: rgba(168, 85, 247, 0.14) !important;
	border-color: rgba(168, 85, 247, 0.4) !important;
	color: #d8b4fe !important;
}

/* 引用选区卡片（.quote-card） */
.quote-card {
	background: rgba(14, 18, 28, 0.52) !important;
	backdrop-filter: blur(${chipBlur}px) saturate(125%) !important;
	-webkit-backdrop-filter: blur(${chipBlur}px) saturate(125%) !important;
	border: 1px solid rgba(255, 255, 255, 0.14) !important;
	border-left: 3px solid ${pal.accent} !important;
	border-radius: 10px !important;
	box-shadow: none !important;
	color: var(--text) !important;
}

.quote-card summary {
	color: var(--text-dim) !important;
}

.quote-source {
	color: #a78bfa !important;
	font-weight: 500 !important;
	text-shadow: 0 1px 1.5px rgba(0, 0, 0, 0.85) !important;
}

.quote-preview {
	color: var(--text) !important;
	text-shadow: 0 1px 1px rgba(0, 0, 0, 0.8) !important;
}

.quote-content {
	background: rgba(6, 8, 14, 0.55) !important;
	border: 1px solid rgba(255, 255, 255, 0.08) !important;
	border-radius: 6px !important;
	color: var(--text) !important;
}

.quote-remove {
	color: var(--text-dim) !important;
	transition: color 0.15s ease, transform 0.15s ease !important;
}

.quote-remove:hover {
	color: var(--red) !important;
	transform: scale(1.15) !important;
}

/* 8.2 @ 引用检索下拉菜单与斜杠命令菜单（.slash-menu）：深晶毛玻璃适配 */
.slash-menu {
	background: rgba(10, 14, 24, 0.82) !important;
	backdrop-filter: blur(${menuBlur}px) saturate(130%) !important;
	-webkit-backdrop-filter: blur(${menuBlur}px) saturate(130%) !important;
	border: 1px solid rgba(255, 255, 255, 0.18) !important;
	border-radius: 14px !important;
	box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.6) !important;
}

.slash-menu-hint {
	color: #94a3b8 !important;
	border-bottom: 1px dashed rgba(255, 255, 255, 0.12) !important;
}

.slash-item {
	color: var(--text) !important;
}

.slash-item:hover,
.slash-item.active {
	background: color-mix(in srgb, var(--text) 12%, transparent) !important;
}

.slash-name {
	color: var(--text) !important;
	text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9) !important;
}

.slash-desc {
	color: var(--text-dim) !important;
}

/* 9. 确保所有全局弹窗、下拉菜单、浮层与抽屉在毛玻璃壁纸下永不被消息或背景遮挡（MARKERS等浮窗透亮适配） */
.dd-portal-wrapper,
.dd-menu,
.ctx-menu,
.pm-panel,
.pi-we-drawer,
.pi-we-backdrop,
.modal-backdrop,
.modal-overlay,
[data-pi-floating-panel],
.floating-panel {
	z-index: 99999 !important;
}

[data-pi-floating-panel],
.floating-panel {
	background: rgba(10, 15, 26, 0.82) !important;
	border: 1px solid rgba(56, 189, 248, 0.28) !important;
	box-shadow: 0 8px 32px rgba(0, 0, 0, 0.55) !important;
	color: var(--text) !important;
}

[data-pi-floating-panel] *,
.floating-panel * {
	color: var(--text) !important;
	text-shadow:
		0 0 1px rgba(0, 0, 0, 0.95),
		0 1px 1.2px rgba(0, 0, 0, 0.85) !important;
}

/* 9.1 右下角状态栏指标（GitHub、CPU/内存68%·32%、工作区路径等）全量高对比提亮与矢量锁边 */
.statusbar-right,
.statusbar-right *,
.statusbar .bar-item-host-metrics,
.statusbar .bar-item-host-metrics *,
.statusbar .status-host-metrics,
.statusbar .status-host-metrics *,
.statusbar .bar-item-cwd,
.statusbar .bar-item-cwd *,
.statusbar .status-cwd,
.statusbar .status-cwd * {
	color: var(--text) !important;
	opacity: 0.98 !important;
	text-shadow:
		0 0 1px rgba(0, 0, 0, 0.95),
		0 1px 1.5px rgba(0, 0, 0, 0.85) !important;
}

.statusbar-right .bar-item-icon svg,
.statusbar .bar-item-host-metrics svg,
.statusbar .status-host-metrics svg,
.statusbar .bar-item-cwd svg,
.statusbar .status-cwd svg {
	color: var(--text) !important;
	stroke: #f8fafc !important;
	filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.95)) drop-shadow(0 1px 1.2px rgba(0, 0, 0, 0.85)) !important;
}

/* 10. 顶部按钮与所有图标：所有按钮统一度量衡，阴影唯一精准挂载在矢量笔画上，严禁父子容器双重叠加产生浓黑光晕 */
span.bar-item-icon,
span.plugin-icon-svg,
.side-dock-btn,
.chead-copy,
.chead-toggle,
.msg-actions button,
.panel-header .icon-btn,
.panel-collapse-btn,
.panel-rail,
.lp-section-action,
.pi-we-icon-btn,
.topbar .icon-btn,
.icon-btn,
.project-icon {
	background: transparent !important;
	border: none !important;
	box-shadow: none !important;
	filter: none !important;
	text-shadow: none !important;
	color: var(--text) !important;
	transition: filter 0.15s ease, transform 0.15s ease, color 0.15s ease;
}

/* 全界面所有图标矢量元素（SVG / Glyph / 胶囊图标）：统一定义唯一、精致、锐利的微黑锁边，绝不晕染；
   注意：仅对叶子节点 SVG 或字符 Glyph 施加滤镜，绝对禁止在包含 SVG 的 span 容器上挂滤镜防嵌套双重阴影 */
svg.bar-item-icon,
.bar-item-glyph,
.bar-item-icon svg,
.bar-item-icon.plugin-icon-svg svg,
.lp-section-action svg,
.panel-collapse-btn svg,
.panel-rail svg,
.side-dock-btn svg,
.project-icon svg,
.chead-copy svg,
.chead-copy > svg,
.chead-toggle svg,
.chead-toggle > svg,
.chead-icon svg,
.toolcall-icon svg,
.thinking-icon svg,
.toolcall-status svg,
.toolcall-open svg {
	color: var(--text) !important;
	stroke: #f8fafc !important;
	filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.95)) drop-shadow(0 1px 1.2px rgba(0, 0, 0, 0.85)) !important;
	transition: filter 0.15s ease, color 0.15s ease;
}

/* 悬停微高光微反馈：统一只对图标自身应用光晕，容器 span 保持无滤镜 */
.bar-item:hover span.bar-item-icon,
.bar-item:hover span.plugin-icon-svg {
	filter: none !important;
}

.bar-item:hover svg.bar-item-icon,
.bar-item:hover .bar-item-icon svg,
.bar-item:hover .bar-item-glyph,
.side-dock-btn:hover svg,
.chead-copy:hover svg,
.chead-toggle:hover svg,
.msg-actions button:hover svg,
.lp-section-action:hover svg,
.panel-collapse-btn:hover svg,
.panel-rail:hover svg,
.icon-btn:hover svg,
.toolcall-open:hover svg {
	color: ${pal.accent} !important;
	stroke: ${pal.accent} !important;
	filter: drop-shadow(0 0 2px ${pal.accent}) drop-shadow(0 1px 2px rgba(0, 0, 0, 0.9)) !important;
}

.side-dock-btn:hover,
.chead-copy:hover,
.chead-toggle:hover,
.msg-actions button:hover,
.lp-section-action:hover,
.panel-collapse-btn:hover,
.panel-rail:hover,
.icon-btn:hover,
.toolcall-open:hover {
	transform: scale(1.08);
}

/* 顶栏所有按钮（含沙盒、临时对话等）默认彻底裸幽灵化，绝不残留突兀的高亮黄色圆环或生硬外边框 */
.topbar .bar-item:not(:hover),
.topbar .chip:not(:hover),
.topbar .sandbox-chip:not(:hover),
.topbar .ephemeral-chat-btn:not(:hover) {
	background: transparent !important;
	border-color: transparent !important;
	box-shadow: none !important;
}

${
	interactive
		? `
/* 交互模式开启：允许鼠标穿透透明消息背景区域 */
.messages-wrap, .chat-view, .chat-scroll, .messages {
	pointer-events: none !important;
}
.msg, .msg-body, .inputbar, .inputbox, .attach-chip, .attachcard, .quote-card, .slash-menu, .card, .topbar, .panel, .footer-bar, button, a, input, textarea, [role="button"] {
	pointer-events: auto !important;
}
`
		: ""
}
`;
}

export const DRAWER_CSS = `
/* ---------------- 全局底层壁纸容器（独立硬件加速层与严格包含） ---------------- */
#pi-we-bg-container {
	position: fixed;
	inset: 0;
	z-index: 0;
	overflow: hidden;
	pointer-events: none;
	user-select: none;
	transform: translate3d(0, 0, 0);
	will-change: transform;
	contain: strict;
	backface-visibility: hidden;
}

#pi-we-bg-container.interactive {
	pointer-events: auto;
}

.pi-we-poster {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	object-fit: cover;
	object-position: center;
	border: none;
	z-index: 0;
	transform: translateZ(0);
	transition: opacity 0.35s ease-out;
	pointer-events: none;
}

.pi-we-bg-media {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	object-fit: cover;
	object-position: center;
	border: none;
	transform: translateZ(0);
	opacity: 0;
	transition: opacity 0.35s ease-out;
	will-change: opacity;
	z-index: 1;
}

.pi-we-bg-media.pi-we-ready {
	opacity: 1;
}

iframe.pi-we-bg-media {
	border: none;
	width: 100%;
	height: 100%;
	background: transparent;
	pointer-events: inherit;
}

.pi-we-scene-mount {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	overflow: hidden;
	pointer-events: inherit;
	transform: translateZ(0);
	opacity: 0;
	transition: opacity 0.35s ease-out;
	will-change: opacity;
	z-index: 1;
}

.pi-we-scene-mount.pi-we-ready {
	opacity: 1;
}

.pi-we-scene-mount canvas {
	width: 100% !important;
	height: 100% !important;
	display: block;
	object-fit: cover;
	transform: translateZ(0);
}

/* ---------------- 壁纸库抽屉蒙层与面板 ---------------- */
.pi-we-backdrop {
	position: fixed;
	inset: 0;
	background: rgba(0, 0, 0, 0.55);
	backdrop-filter: blur(6px);
	-webkit-backdrop-filter: blur(6px);
	z-index: 9998;
	opacity: 0;
	pointer-events: none;
	transition: opacity 0.25s ease;
}

.pi-we-backdrop.open {
	opacity: 1;
	pointer-events: auto;
}

.pi-we-drawer {
	position: fixed;
	top: 0;
	right: 0;
	bottom: 0;
	height: 100vh;
	max-height: 100vh;
	width: 480px;
	max-width: 92vw;
	background: rgba(14, 20, 34, 0.96);
	border-left: 1px solid rgba(56, 189, 248, 0.25);
	box-shadow: -10px 0 40px rgba(0, 0, 0, 0.65);
	z-index: 9999;
	display: flex;
	flex-direction: column;
	overflow: hidden;
	transform: translate3d(100%, 0, 0);
	will-change: transform;
	transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
	color: var(--text);
	font-family: inherit;
	box-sizing: border-box;
}

.pi-we-drawer.open {
	transform: translate3d(0, 0, 0);
}

/* 抽屉头部（精简纯净、单行防折行） */
.pi-we-header {
	padding: 12px 16px !important;
	display: flex !important;
	align-items: center !important;
	justify-content: space-between !important;
	gap: 10px !important;
	flex-wrap: nowrap !important;
	white-space: nowrap !important;
	min-width: 0 !important;
	border-bottom: 1px solid rgba(56, 189, 248, 0.16) !important;
	flex-shrink: 0 !important;
	background: rgba(11, 16, 28, 0.5) !important;
	box-sizing: border-box !important;
}

.pi-we-title {
	font-size: 15px !important;
	font-weight: 600 !important;
	display: flex !important;
	align-items: center !important;
	gap: 6px !important;
	margin: 0 !important;
	color: var(--text) !important;
	text-shadow: 0 0 12px rgba(56, 189, 248, 0.45) !important;
	flex-shrink: 1 !important;
	min-width: 0 !important;
	white-space: nowrap !important;
	overflow: hidden !important;
	text-overflow: ellipsis !important;
}

.pi-we-header-actions {
	display: flex !important;
	align-items: center !important;
	gap: 6px !important;
	flex-shrink: 0 !important;
	white-space: nowrap !important;
}

.pi-we-icon-btn {
	background: rgba(56, 189, 248, 0.08);
	border: 1px solid rgba(56, 189, 248, 0.22);
	color: var(--text-dim);
	border-radius: 6px;
	padding: 5px 8px !important;
	font-size: 12px !important;
	cursor: pointer;
	display: inline-flex !important;
	align-items: center !important;
	justify-content: center !important;
	gap: 4px !important;
	flex-shrink: 0 !important;
	white-space: nowrap !important;
	transition: all 0.15s ease;
	line-height: 1 !important;
}

.pi-we-close-btn {
	padding: 5px 8px !important;
	font-size: 13px !important;
}

.pi-we-icon-btn:hover {
	background: rgba(56, 189, 248, 0.22);
	border-color: rgba(56, 189, 248, 0.45);
	color: var(--text);
}

.pi-we-theme-badge {
	font-size: 11px;
	padding: 2px 7px;
	border-radius: 999px;
	background: rgba(56, 189, 248, 0.16);
	border: 1px solid rgba(56, 189, 248, 0.35);
	color: #38bdf8;
	font-weight: 500;
}

/* 外观调节面板（支持优雅折叠/展开，为壁纸列表腾出最大纵向浏览高度） */
.pi-we-settings-bar {
	padding: 12px 20px;
	background: rgba(8, 12, 22, 0.45);
	border-bottom: 1px solid rgba(56, 189, 248, 0.12);
	display: flex;
	flex-direction: column;
	gap: 10px;
	font-size: 12px;
	max-height: 520px;
	overflow: hidden;
	opacity: 1;
	transition: max-height 0.28s cubic-bezier(0.16, 1, 0.3, 1), padding 0.25s ease, opacity 0.2s ease, border-color 0.2s ease;
	box-sizing: border-box;
}

.pi-we-settings-bar.collapsed {
	max-height: 0 !important;
	padding-top: 0 !important;
	padding-bottom: 0 !important;
	border-bottom-color: transparent !important;
	opacity: 0 !important;
	pointer-events: none !important;
}

.pi-we-icon-btn.active {
	background: rgba(56, 189, 248, 0.25) !important;
	border-color: #38bdf8 !important;
	color: var(--text) !important;
	box-shadow: 0 0 10px rgba(56, 189, 248, 0.35) !important;
}

.pi-we-slider-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

.pi-we-slider-label {
	color: #94a3b8;
	width: 90px;
	flex-shrink: 0;
}

.pi-we-slider-row input[type="range"] {
	flex: 1;
	accent-color: #38bdf8;
	cursor: pointer;
}

.pi-we-slider-val {
	width: 44px;
	text-align: right;
	color: var(--text);
	font-family: monospace;
}

.pi-we-select {
	background: rgba(8, 12, 22, 0.7);
	border: 1px solid rgba(56, 189, 248, 0.25);
	color: var(--text);
	border-radius: 6px;
	padding: 4px 8px;
	font-size: 12px;
	outline: none;
	cursor: pointer;
}

.pi-we-select:focus {
	border-color: #38bdf8;
}

.pi-we-checkbox-row {
	display: flex;
	align-items: center;
	gap: 6px;
	color: var(--text-dim);
	cursor: pointer;
}

/* 预设导出与导入条 */
.pi-we-preset-row {
	display: flex;
	align-items: center;
	gap: 8px;
	padding-top: 4px;
	border-top: 1px dashed rgba(56, 189, 248, 0.16);
}

/* 搜索与分类 */
.pi-we-filter-bar {
	padding: 12px 20px 8px;
	display: flex;
	flex-direction: column;
	gap: 10px;
	flex-shrink: 0;
}

.pi-we-search-input {
	width: 100%;
	padding: 8px 12px;
	background: rgba(8, 12, 22, 0.5);
	border: 1px solid rgba(56, 189, 248, 0.22);
	border-radius: 6px;
	color: var(--text);
	font-size: 13px;
	outline: none;
	box-sizing: border-box;
}

.pi-we-search-input:focus {
	border-color: #38bdf8;
	box-shadow: 0 0 10px rgba(56, 189, 248, 0.25);
}

.pi-we-tabs {
	display: flex;
	gap: 6px;
	overflow-x: auto;
}

.pi-we-tab {
	padding: 4px 10px;
	border-radius: 4px;
	font-size: 12px;
	background: color-mix(in srgb, var(--text) 5%, transparent);
	border: 1px solid transparent;
	color: #94a3b8;
	cursor: pointer;
	white-space: nowrap;
	transition: all 0.15s ease;
}

.pi-we-tab:hover {
	color: var(--text);
	background: rgba(56, 189, 248, 0.12);
}

.pi-we-tab.active {
	background: rgba(56, 189, 248, 0.2);
	color: #38bdf8;
	border-color: rgba(56, 189, 248, 0.4);
	font-weight: 500;
}

/* 显示模式切换按钮（分页浏览 vs 全部展示） */
.pi-we-mode-btn {
	margin-left: auto;
	padding: 4px 10px;
	border-radius: 4px;
	font-size: 11.5px;
	background: rgba(56, 189, 248, 0.12);
	border: 1px solid rgba(56, 189, 248, 0.35);
	color: #38bdf8;
	cursor: pointer;
	white-space: nowrap;
	transition: all 0.15s ease;
	display: inline-flex;
	align-items: center;
	gap: 4px;
}

.pi-we-mode-btn:hover {
	background: rgba(56, 189, 248, 0.25);
	border-color: #38bdf8;
	color: var(--text);
}

/* 壁纸列表网格（声明 min-height: 0 锁定 flex 伸缩，强制以 min-content 撑起自适应网格行高，坚决杜绝任何行高塌陷与卡片重叠，确保垂直顺畅滚动） */
.pi-we-body {
	flex: 1 1 0% !important;
	min-height: 0 !important;
	max-height: 100% !important;
	overflow-y: auto !important;
	overflow-x: hidden !important;
	-webkit-overflow-scrolling: touch !important;
	padding: 12px 16px 28px !important;
	display: grid !important;
	grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
	grid-auto-rows: min-content !important;
	gap: 12px !important;
	align-content: start !important;
	align-items: start !important;
	overscroll-behavior: contain !important;
	box-sizing: border-box !important;
}

.pi-we-card,
.pi-we-card-item {
	position: relative !important;
	background: rgba(14, 21, 37, 0.85) !important;
	border: 1px solid rgba(56, 189, 248, 0.2) !important;
	border-radius: 8px !important;
	overflow: hidden !important;
	cursor: pointer !important;
	display: flex !important;
	flex-direction: column !important;
	flex-shrink: 0 !important;
	min-width: 0 !important;
	width: 100% !important;
	min-height: 195px !important;
	height: auto !important;
	box-sizing: border-box !important;
	margin: 0 !important;
	contain: paint !important;
	transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.2s ease, box-shadow 0.2s ease !important;
	outline: none !important;
}

.pi-we-card:hover,
.pi-we-card-item:hover {
	border-color: rgba(56, 189, 248, 0.6) !important;
	transform: translateY(-2px) !important;
	box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5), 0 0 12px rgba(56, 189, 248, 0.25) !important;
}

.pi-we-card.active,
.pi-we-card-item.active {
	border-color: #38bdf8 !important;
	box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.85) !important;
}

/* 封面容器：统一固定标准高度，不依赖图片自身比例，更饱满舒展，绝不扁平，完全杜绝高度塌陷与重叠 */
.pi-we-thumb-wrap,
.pi-we-cover-wrap {
	position: relative !important;
	width: 100% !important;
	height: 145px !important;
	min-height: 145px !important;
	max-height: 145px !important;
	flex: 0 0 145px !important;
	background: #060913 !important;
	overflow: hidden !important;
	display: block !important;
	box-sizing: border-box !important;
}

/* 封面主体图片：绝对定位充满容器，object-fit: cover 裁切填满，全视角全部可见不拉伸 */
.pi-we-thumb,
.pi-we-cover-img {
	position: absolute !important;
	inset: 0 !important;
	width: 100% !important;
	height: 100% !important;
	object-fit: cover !important;
	object-position: center !important;
	display: block !important;
	transition: transform 0.25s ease !important;
	box-sizing: border-box !important;
}

.pi-we-card:hover .pi-we-thumb,
.pi-we-card-item:hover .pi-we-cover-img {
	transform: scale(1.05) !important;
}

.pi-we-badge {
	position: absolute;
	top: 6px;
	right: 6px;
	padding: 2px 6px;
	border-radius: 4px;
	font-size: 10px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.5px;
	background: rgba(0, 0, 0, 0.75);
	backdrop-filter: blur(4px);
	z-index: 2;
}

.pi-we-badge.video {
	color: #38bdf8;
	border: 1px solid rgba(56, 189, 248, 0.4);
}

.pi-we-badge.scene {
	color: #c084fc;
	border: 1px solid rgba(192, 132, 252, 0.4);
}

.pi-we-badge.image {
	color: var(--amber);
	border: 1px solid rgba(251, 191, 36, 0.4);
}

.pi-we-badge.web {
	color: #34d399;
	border: 1px solid rgba(52, 211, 153, 0.4);
}

.pi-we-active-indicator {
	position: absolute;
	top: 6px;
	left: 6px;
	background: #38bdf8;
	color: #020617;
	font-size: 10px;
	font-weight: 700;
	padding: 2px 6px;
	border-radius: 4px;
	box-shadow: 0 0 10px rgba(56, 189, 248, 0.6);
	z-index: 2;
}

/* 卡片信息区：有明确的背景和分界，确保卡片层次分明，绝不与相邻卡片重叠 */
.pi-we-card-info,
.pi-we-card-meta-bar {
	padding: 8px 10px !important;
	background: rgba(10, 15, 26, 0.96) !important;
	border-top: 1px solid rgba(56, 189, 248, 0.15) !important;
	display: flex !important;
	flex-direction: column !important;
	gap: 4px !important;
	min-width: 0 !important;
	flex: 0 0 auto !important;
	flex-shrink: 0 !important;
	box-sizing: border-box !important;
}

.pi-we-card-title {
	font-size: 12px !important;
	font-weight: 500 !important;
	color: var(--text) !important;
	overflow: hidden !important;
	text-overflow: ellipsis !important;
	white-space: nowrap !important;
	line-height: 1.4 !important;
}

.pi-we-card-meta {
	display: flex !important;
	align-items: center !important;
	justify-content: space-between !important;
	gap: 6px !important;
	font-size: 11px !important;
	color: #94a3b8 !important;
}

.pi-we-fav-btn {
	background: transparent;
	border: none;
	font-size: 15px;
	color: #64748b;
	cursor: pointer;
	padding: 2px;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: color 0.15s ease, transform 0.15s ease;
}

.pi-we-fav-btn:hover {
	transform: scale(1.2);
}

.pi-we-fav-btn.active {
	color: var(--amber);
	text-shadow: 0 0 8px rgba(245, 158, 11, 0.5);
}

/* 空状态与无壁纸选项 */
.pi-we-empty {
	grid-column: span 2;
	padding: 32px 16px;
	text-align: center;
	color: #94a3b8;
	font-size: 13px;
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 10px;
}

.pi-we-card-none {
	grid-column: span 2;
	padding: 12px;
	background: color-mix(in srgb, var(--text) 3%, transparent);
	border: 1px dashed rgba(56, 189, 248, 0.25);
	border-radius: 8px;
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 8px;
	font-size: 13px;
	color: #94a3b8;
	cursor: pointer;
	transition: all 0.2s ease;
}

.pi-we-card-none:hover {
	border-color: rgba(56, 189, 248, 0.6);
	color: #38bdf8;
	background: rgba(56, 189, 248, 0.08);
}

/* 壁纸列表分页栏（吸底常驻，保证无论内容多少均 100% 始终可见） */
.pi-we-pagination {
	flex-shrink: 0 !important;
	position: sticky !important;
	bottom: 0 !important;
	z-index: 99 !important;
	padding: 10px 16px !important;
	background: rgba(8, 12, 22, 0.98) !important;
	border-top: 1px solid rgba(56, 189, 248, 0.3) !important;
	box-shadow: 0 -6px 20px rgba(0, 0, 0, 0.6) !important;
	backdrop-filter: blur(12px) !important;
	display: flex !important;
	align-items: center !important;
	justify-content: space-between !important;
	gap: 8px !important;
	user-select: none !important;
	box-sizing: border-box !important;
	min-height: 48px !important;
}

.pi-we-page-info {
	font-size: 11.5px;
	color: #94a3b8;
	white-space: nowrap;
}

.pi-we-page-nav {
	display: flex;
	align-items: center;
	gap: 4px;
}

.pi-we-page-btn {
	padding: 4px 8px;
	font-size: 11.5px;
	color: var(--text);
	background: color-mix(in srgb, var(--text) 6%, transparent);
	border: 1px solid rgba(56, 189, 248, 0.2);
	border-radius: 5px;
	cursor: pointer;
	transition: all 0.15s ease;
	white-space: nowrap;
}

.pi-we-page-btn:hover:not(:disabled) {
	background: rgba(56, 189, 248, 0.2);
	border-color: #38bdf8;
	color: #38bdf8;
}

.pi-we-page-btn:disabled {
	opacity: 0.35;
	cursor: not-allowed;
	border-color: rgba(255, 255, 255, 0.08);
}

.pi-we-page-numbers {
	display: flex;
	align-items: center;
	gap: 3px;
}

.pi-we-page-num {
	min-width: 24px;
	height: 24px;
	padding: 0 4px;
	font-size: 11.5px;
	font-family: inherit;
	color: #94a3b8;
	background: transparent;
	border: 1px solid transparent;
	border-radius: 4px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	cursor: pointer;
	transition: all 0.15s ease;
}

.pi-we-page-num:hover:not(.active) {
	color: var(--text);
	background: color-mix(in srgb, var(--text) 8%, transparent);
}

.pi-we-page-num.active {
	color: #020617;
	background: #38bdf8;
	border-color: #38bdf8;
	font-weight: 700;
	box-shadow: 0 0 8px rgba(56, 189, 248, 0.45);
}

.pi-we-page-ellipsis {
	padding: 0 2px;
	color: #64748b;
	font-size: 12px;
}

/* 小屏移动端/窄视口响应式适配：确保抽屉撑满且卡片列表绝不重叠、文字与图片全部可见 */
@media (max-width: 480px) {
	.pi-we-drawer {
		width: 100vw !important;
		max-width: 100vw !important;
	}
	.pi-we-header {
		padding: 10px 12px !important;
		gap: 8px !important;
	}
	.pi-we-header .pi-we-btn-label {
		display: none !important;
	}
	.pi-we-header-actions {
		gap: 5px !important;
	}
	.pi-we-body {
		padding: 10px 10px 24px !important;
		gap: 10px !important;
	}
	.pi-we-card,
	.pi-we-card-item {
		min-height: 175px !important;
	}
	.pi-we-thumb-wrap,
	.pi-we-cover-wrap {
		height: 125px !important;
		min-height: 125px !important;
		max-height: 125px !important;
		flex: 0 0 125px !important;
	}
	.pi-we-card-info,
	.pi-we-card-meta-bar {
		padding: 6px 8px !important;
	}
	.pi-we-card-title {
		font-size: 11.5px !important;
	}
	.pi-we-card-meta {
		font-size: 10.5px !important;
	}
}

/* ---------------- 工具详情检查器弹窗（Tool Inspector Modal） ---------------- */
.pi-we-inspector-backdrop {
	position: fixed;
	inset: 0;
	z-index: 100000;
	background: rgba(4, 6, 12, 0.72);
	backdrop-filter: blur(10px) saturate(120%);
	-webkit-backdrop-filter: blur(10px) saturate(120%);
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 20px;
	opacity: 0;
	pointer-events: none;
	transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.pi-we-inspector-backdrop.open {
	opacity: 1;
	pointer-events: auto;
}

.pi-we-inspector-dialog {
	position: relative;
	width: 760px;
	max-width: 92vw;
	max-height: 82vh;
	display: flex;
	flex-direction: column;
	background: rgba(10, 14, 24, 0.94);
	border: 1px solid rgba(255, 255, 255, 0.18);
	border-radius: 14px;
	box-shadow: 0 20px 50px rgba(0, 0, 0, 0.85), 0 0 20px rgba(255, 255, 255, 0.08);
	color: var(--text);
	font-family: system-ui, -apple-system, sans-serif;
	overflow: hidden;
	transform: scale(0.96) translateY(10px);
	transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}

.pi-we-inspector-backdrop.open .pi-we-inspector-dialog {
	transform: scale(1) translateY(0);
}

.pi-we-inspector-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 12px 18px;
	background: rgba(15, 22, 38, 0.75);
	border-bottom: 1px solid rgba(255, 255, 255, 0.12);
	gap: 12px;
	flex-shrink: 0;
}

.pi-we-inspector-title-group {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
}

.pi-we-inspector-icon {
	width: 24px;
	height: 24px;
	border-radius: 6px;
	background: color-mix(in srgb, var(--text) 10%, transparent);
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 13px;
	color: var(--text);
	flex-shrink: 0;
}

.pi-we-inspector-title {
	font-family: var(--mono, monospace);
	font-weight: 700;
	font-size: 14.5px;
	color: var(--text);
	white-space: nowrap;
	text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
}

.pi-we-inspector-badge {
	font-family: var(--mono, monospace);
	font-size: 11px;
	padding: 2px 7px;
	border-radius: 4px;
	background: color-mix(in srgb, var(--text) 8%, transparent);
	border: 1px solid rgba(255, 255, 255, 0.15);
	color: var(--text-dim);
	white-space: nowrap;
}

.pi-we-inspector-badge.ok {
	background: rgba(74, 222, 128, 0.15);
	border-color: rgba(74, 222, 128, 0.4);
	color: var(--green);
}

.pi-we-inspector-badge.run {
	background: rgba(251, 191, 36, 0.15);
	border-color: rgba(251, 191, 36, 0.4);
	color: var(--amber);
}

.pi-we-inspector-badge.err {
	background: rgba(248, 113, 113, 0.15);
	border-color: rgba(248, 113, 113, 0.4);
	color: var(--red-text);
}

.pi-we-inspector-actions {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-shrink: 0;
}

.pi-we-inspector-btn {
	background: color-mix(in srgb, var(--text) 8%, transparent);
	border: 1px solid rgba(255, 255, 255, 0.18);
	border-radius: 6px;
	color: var(--text);
	font-size: 12px;
	padding: 5px 10px;
	cursor: pointer;
	display: inline-flex;
	align-items: center;
	gap: 5px;
	transition: all 0.15s ease;
	text-shadow: 0 1px 1px rgba(0, 0, 0, 0.8);
}

.pi-we-inspector-btn:hover {
	background: color-mix(in srgb, var(--text) 16%, transparent);
	border-color: rgba(255, 255, 255, 0.35);
	color: var(--text);
}

.pi-we-inspector-close {
	padding: 5px 8px;
	font-size: 14px;
	line-height: 1;
}

.pi-we-inspector-body {
	flex: 1;
	overflow-y: auto;
	overscroll-behavior: contain;
	padding: 16px 20px 24px;
	display: flex;
	flex-direction: column;
	gap: 16px;
}

.pi-we-inspector-section {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.pi-we-inspector-label {
	font-size: 12px;
	font-weight: 600;
	color: #94a3b8;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	display: flex;
	align-items: center;
	gap: 6px;
}

.pi-we-inspector-codeblock {
	background: rgba(4, 6, 12, 0.85);
	border: 1px solid rgba(255, 255, 255, 0.12);
	border-radius: 8px;
	padding: 12px 14px;
	font-family: var(--mono, monospace);
	font-size: 12.5px;
	line-height: 1.55;
	color: var(--text);
	white-space: pre-wrap;
	word-break: break-all;
	overflow-x: auto;
	max-height: 40vh;
	margin: 0;
	text-shadow: 0 1px 1px rgba(0, 0, 0, 0.9);
}

.pi-we-inspector-thinking-text {
	background: rgba(18, 14, 28, 0.65);
	border: 1px solid rgba(168, 85, 247, 0.25);
	border-radius: 8px;
	padding: 14px 16px;
	font-size: 13.5px;
	line-height: 1.68;
	color: var(--text);
	white-space: pre-wrap;
	word-break: break-word;
	max-height: 55vh;
	overflow-y: auto;
	margin: 0;
	text-shadow: 0 1px 1.5px rgba(0, 0, 0, 0.9);
}

/* 富媒体文件展示预览（针对 present_files 与文件交付） */
.pi-we-ins-preview-wrap {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.pi-we-ins-preview-meta {
	background: color-mix(in srgb, var(--text) 4%, transparent);
	border: 1px solid rgba(255, 255, 255, 0.08);
	border-radius: 8px;
	padding: 12px 14px;
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.pi-we-ins-preview-title {
	font-size: 14px;
	font-weight: 600;
	color: var(--text);
	display: flex;
	align-items: center;
	gap: 6px;
}

.pi-we-ins-preview-note {
	font-size: 12.5px;
	line-height: 1.55;
	color: var(--text-dim);
	word-break: break-word;
}

.pi-we-ins-preview-card {
	background: rgba(15, 23, 42, 0.7);
	border: 1px solid rgba(255, 255, 255, 0.12);
	border-radius: 10px;
	padding: 12px 14px;
	display: flex;
	flex-direction: column;
	gap: 10px;
	box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.pi-we-ins-preview-card:hover {
	border-color: rgba(56, 189, 248, 0.35);
}

.pi-we-ins-preview-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
	min-width: 0;
}

.pi-we-ins-preview-info {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
	flex: 1;
}

.pi-we-ins-preview-icon {
	font-size: 18px;
	line-height: 1;
	flex-shrink: 0;
}

.pi-we-ins-preview-name {
	font-size: 13px;
	font-weight: 600;
	color: var(--text);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	min-width: 0;
}

.pi-we-ins-preview-caption {
	font-size: 11.5px;
	color: #94a3b8;
	background: color-mix(in srgb, var(--text) 6%, transparent);
	padding: 2px 6px;
	border-radius: 4px;
	flex-shrink: 0;
}

.pi-we-ins-preview-actions {
	display: flex;
	align-items: center;
	gap: 6px;
	flex-shrink: 0;
}

.pi-we-ins-btn-sm {
	background: color-mix(in srgb, var(--text) 8%, transparent);
	border: 1px solid rgba(255, 255, 255, 0.12);
	color: var(--text);
	border-radius: 5px;
	padding: 3px 8px;
	font-size: 11.5px;
	cursor: pointer;
	text-decoration: none;
	display: inline-flex;
	align-items: center;
	gap: 4px;
	transition: all 0.15s ease;
}

.pi-we-ins-btn-sm:hover {
	background: rgba(56, 189, 248, 0.2);
	border-color: rgba(56, 189, 248, 0.4);
	color: #38bdf8;
}

.pi-we-ins-preview-media {
	width: 100%;
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.pi-we-ins-preview-audio {
	width: 100%;
	height: 38px;
	border-radius: 6px;
	outline: none;
}

.pi-we-ins-preview-img {
	max-height: 280px;
	max-width: 100%;
	border-radius: 6px;
	border: 1px solid rgba(255, 255, 255, 0.1);
	object-fit: contain;
	background: rgba(0, 0, 0, 0.3);
}

.pi-we-ins-preview-video {
	max-height: 320px;
	max-width: 100%;
	border-radius: 6px;
	border: 1px solid rgba(255, 255, 255, 0.1);
	outline: none;
	background: rgba(0, 0, 0, 0.5);
}

`;
