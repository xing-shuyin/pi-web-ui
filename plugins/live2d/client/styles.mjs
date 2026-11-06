export const WIDGET_CSS = `
/* ── Live2D 挂件全局容器 ────────────────────────────────────────── */
#pi-live2d-companion {
	position: fixed;
	z-index: 9990;
	pointer-events: none;
	user-select: none;
	-webkit-user-select: none;
	display: flex;
	flex-direction: column;
	align-items: center;
	transition: opacity 0.25s ease, transform 0.25s ease, visibility 0.25s ease;
	font-family: inherit;
}

#pi-live2d-companion.pi-l2d-hidden {
	opacity: 0 !important;
	pointer-events: none !important;
	visibility: hidden !important;
	transform: scale(0.9) translateY(10px) !important;
}

#pi-live2d-companion.pi-l2d-hidden,
#pi-live2d-companion.pi-l2d-hidden * {
	pointer-events: none !important;
	visibility: hidden !important;
}

#pi-live2d-companion.pi-l2d-click-through {
	opacity: 0.85;
	filter: saturate(0.9);
	pointer-events: none !important;
}

#pi-live2d-companion.pi-l2d-click-through,
#pi-live2d-companion.pi-l2d-click-through * {
	pointer-events: none !important;
}

/* ── 对话台词气泡 ────────────────────────────────────────────── */
.pi-l2d-bubble {
	pointer-events: auto;
	position: relative;
	margin-bottom: 8px;
	max-width: 260px;
	min-width: 80px;
	padding: 10px 14px;
	background: var(--bg-elev2, #1e222b);
	color: var(--text, #f1f5f9);
	font-size: 13px;
	line-height: 1.5;
	border: 1px solid var(--border, #334155);
	border-radius: 12px;
	box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
	backdrop-filter: blur(12px);
	-webkit-backdrop-filter: blur(12px);
	word-break: break-word;
	overflow-wrap: anywhere;
	opacity: 0;
	transform: translateY(8px) scale(0.95);
	transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1), transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
	cursor: pointer;
}

.pi-l2d-bubble.pi-l2d-bubble-visible {
	opacity: 1;
	transform: translateY(0) scale(1);
}

.pi-l2d-bubble.pi-l2d-bubble-thought {
	border-style: dashed;
	border-color: color-mix(in srgb, var(--accent, #6366f1) 45%, var(--border, #334155));
	background: color-mix(in srgb, var(--accent, #6366f1) 12%, var(--bg-elev2, #1e222b));
	border-radius: 16px;
	box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28), 0 0 14px color-mix(in srgb, var(--accent, #6366f1) 20%, transparent);
}

.pi-l2d-bubble.pi-l2d-bubble-thought::after {
	display: none;
}

.pi-l2d-bubble-badge {
	display: none;
	align-items: center;
	gap: 4px;
	margin-bottom: 4px;
	font-size: 11px;
	font-weight: 600;
	letter-spacing: 0.02em;
	color: var(--accent, #6366f1);
	line-height: 1;
	user-select: none;
}

.pi-l2d-bubble-badge-icon {
	font-size: 12px;
	filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.3));
}

.pi-l2d-bubble-badge-label {
	font-style: normal;
	opacity: 0.9;
}

.pi-l2d-thought-dots {
	display: none;
}

.pi-l2d-bubble.pi-l2d-bubble-thought .pi-l2d-thought-dots {
	display: block;
}

.pi-l2d-thought-dot {
	position: absolute;
	border-radius: 50%;
	background: color-mix(in srgb, var(--accent, #6366f1) 12%, var(--bg-elev2, #1e222b));
	border: 1px dashed color-mix(in srgb, var(--accent, #6366f1) 45%, var(--border, #334155));
	pointer-events: none;
}

.pi-l2d-dot-1 {
	bottom: -9px;
	left: 50%;
	width: 9px;
	height: 9px;
	transform: translateX(-50%);
}

.pi-l2d-dot-2 {
	bottom: -16px;
	left: 52%;
	width: 6px;
	height: 6px;
	transform: translateX(-50%);
}

.pi-l2d-bubble::after {
	content: "";
	position: absolute;
	bottom: -7px;
	left: 50%;
	transform: translateX(-50%);
	width: 0;
	height: 0;
	border-left: 7px solid transparent;
	border-right: 7px solid transparent;
	border-top: 7px solid var(--bg-elev2, #1e222b);
}

.pi-l2d-bubble-close {
	position: absolute;
	top: 3px;
	right: 5px;
	background: none;
	border: none;
	color: var(--text-faint, #64748b);
	font-size: 11px;
	line-height: 1;
	cursor: pointer;
	padding: 2px 4px;
	border-radius: 4px;
	opacity: 0.6;
}
.pi-l2d-bubble-close:hover {
	opacity: 1;
	color: var(--text, #f1f5f9);
}

/* ── Canvas 挂件主体 ──────────────────────────────────────────── */
.pi-l2d-body-wrap {
	pointer-events: auto;
	position: relative;
	cursor: grab;
	display: flex;
	align-items: center;
	justify-content: center;
	filter: drop-shadow(0 10px 20px rgba(0, 0, 0, 0.2));
}

.pi-l2d-body-wrap:active {
	cursor: grabbing;
}

.pi-l2d-canvas {
	display: block;
	background: transparent;
	pointer-events: auto;
}

/* ── 鼠标悬浮快捷工具条 ────────────────────────────────────────── */
.pi-l2d-actions-bar {
	pointer-events: auto;
	position: absolute;
	right: -38px;
	top: 50%;
	transform: translateY(-50%);
	display: flex;
	flex-direction: column;
	gap: 6px;
	opacity: 0;
	visibility: hidden;
	transition: opacity 0.2s ease, visibility 0.2s ease, transform 0.2s ease;
	transform: translateY(-50%) translateX(-6px);
}

#pi-live2d-companion:not(.pi-l2d-hidden):hover .pi-l2d-actions-bar,
.pi-l2d-actions-bar:hover {
	opacity: 1;
	visibility: visible;
	transform: translateY(-50%) translateX(0);
}

.pi-l2d-action-btn {
	width: 32px;
	height: 32px;
	border-radius: 50%;
	border: 1px solid var(--border, #334155);
	background: var(--bg-elev2, #1e222b);
	color: var(--text, #f1f5f9);
	display: flex;
	align-items: center;
	justify-content: center;
	cursor: pointer;
	box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
	font-size: 14px;
	transition: all 0.15s ease;
}

.pi-l2d-action-btn:hover {
	background: var(--accent, #3b82f6);
	color: var(--accent-contrast, #ffffff);
	transform: scale(1.1);
	border-color: transparent;
}

/* ── 右键上下文菜单 ──────────────────────────────────────────── */
.pi-l2d-contextmenu {
	position: fixed;
	z-index: 9999;
	min-width: 170px;
	max-width: 240px;
	background: var(--bg-elev2, #1e222b);
	border: 1px solid var(--border, #334155);
	border-radius: 8px;
	box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
	backdrop-filter: blur(16px);
	-webkit-backdrop-filter: blur(16px);
	padding: 5px;
	font-size: 12.5px;
	color: var(--text, #f1f5f9);
	pointer-events: auto;
	opacity: 0;
	transform: scale(0.96);
	transition: opacity 0.12s ease, transform 0.12s ease;
}

.pi-l2d-contextmenu.pi-l2d-menu-visible {
	opacity: 1;
	transform: scale(1);
}

.pi-l2d-menu-group-title {
	font-size: 11px;
	color: var(--text-faint, #64748b);
	padding: 6px 10px 3px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.5px;
}

.pi-l2d-menu-item {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 7px 10px;
	border-radius: 6px;
	cursor: pointer;
	transition: background 0.12s ease;
	gap: 8px;
}

.pi-l2d-menu-item:hover {
	background: color-mix(in srgb, var(--accent, #3b82f6) 18%, transparent);
	color: var(--accent, #3b82f6);
}

.pi-l2d-menu-item.active {
	background: color-mix(in srgb, var(--accent, #3b82f6) 25%, transparent);
	color: var(--accent, #3b82f6);
	font-weight: 600;
}

.pi-l2d-menu-divider {
	height: 1px;
	background: var(--border, #334155);
	margin: 4px 6px;
}

/* ── 设置弹窗 ────────────────────────────────────────────────── */
.pi-l2d-modal-overlay {
	position: fixed;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	z-index: 99999;
	background: rgba(0, 0, 0, 0.5);
	display: flex;
	align-items: center;
	justify-content: center;
	backdrop-filter: blur(4px);
	padding: 16px;
}

.pi-l2d-modal-card {
	width: 100%;
	max-width: 480px;
	max-height: 85vh;
	background: var(--bg-elev, #161922);
	border: 1px solid var(--border, #334155);
	border-radius: 12px;
	box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
	color: var(--text, #f1f5f9);
	display: flex;
	flex-direction: column;
	overflow: hidden;
}

.pi-l2d-modal-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 14px 18px;
	border-bottom: 1px solid var(--border, #334155);
	font-weight: 600;
	font-size: 15px;
}

.pi-l2d-modal-body {
	padding: 18px;
	overflow-y: auto;
	display: flex;
	flex-direction: column;
	gap: 16px;
	overscroll-behavior: contain;
}

.pi-l2d-form-group {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.pi-l2d-form-label {
	font-size: 12.5px;
	font-weight: 500;
	color: var(--text, #f1f5f9);
}

.pi-l2d-input {
	padding: 8px 12px;
	background: var(--bg, #0d0f14);
	border: 1px solid var(--border, #334155);
	border-radius: 6px;
	color: var(--text, #f1f5f9);
	font-size: 13px;
	outline: none;
}
.pi-l2d-input:focus {
	border-color: var(--accent, #3b82f6);
}

.pi-l2d-switch-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	font-size: 13px;
	cursor: pointer;
}

.pi-l2d-modal-foot {
	display: flex;
	justify-content: flex-end;
	gap: 10px;
	padding: 12px 18px;
	border-top: 1px solid var(--border, #334155);
	background: var(--bg-elev2, #1e222b);
}

.pi-l2d-btn {
	padding: 7px 16px;
	border-radius: 6px;
	font-size: 13px;
	cursor: pointer;
	border: 1px solid var(--border, #334155);
	background: var(--bg, #0d0f14);
	color: var(--text, #f1f5f9);
	transition: all 0.15s ease;
}
.pi-l2d-btn:hover {
	border-color: var(--accent, #3b82f6);
	color: var(--accent, #3b82f6);
}
.pi-l2d-btn-primary {
	background: var(--accent, #3b82f6);
	border-color: transparent;
	color: var(--accent-contrast, #ffffff);
}
.pi-l2d-btn-primary:hover {
	opacity: 0.9;
	color: var(--accent-contrast, #ffffff);
}

/* ── 本地模型上传与管理区域 ──────────────────────────────────── */
.pi-l2d-dropzone {
	border: 2px dashed var(--border, #334155);
	border-radius: 8px;
	padding: 16px;
	text-align: center;
	background: color-mix(in srgb, var(--bg, #0d0f14) 70%, transparent);
	transition: all 0.2s ease;
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 10px;
}

.pi-l2d-dropzone.dragover {
	border-color: var(--accent, #3b82f6);
	background: color-mix(in srgb, var(--accent, #3b82f6) 12%, transparent);
	transform: scale(1.01);
}

.pi-l2d-dropzone-icon {
	font-size: 26px;
	line-height: 1;
}

.pi-l2d-dropzone-title {
	font-size: 13px;
	font-weight: 500;
	color: var(--text, #f1f5f9);
}

.pi-l2d-dropzone-desc {
	font-size: 11.5px;
	color: var(--text-faint, #64748b);
	line-height: 1.4;
	max-width: 320px;
}

.pi-l2d-upload-actions {
	display: flex;
	gap: 8px;
	flex-wrap: wrap;
	justify-content: center;
	margin-top: 4px;
}

.pi-l2d-upload-status {
	font-size: 12px;
	padding: 6px 10px;
	border-radius: 6px;
	display: flex;
	align-items: center;
	gap: 6px;
}

.pi-l2d-upload-status.loading {
	background: color-mix(in srgb, var(--accent, #3b82f6) 15%, transparent);
	color: var(--accent, #3b82f6);
}

.pi-l2d-upload-status.error {
	background: color-mix(in srgb, var(--red, #ef4444) 15%, transparent);
	color: var(--red, #ef4444);
}

.pi-l2d-btn-del {
	background: transparent;
	border: 1px solid transparent;
	color: var(--text-faint, #64748b);
	border-radius: 4px;
	padding: 4px 6px;
	font-size: 13px;
	cursor: pointer;
	transition: all 0.15s ease;
}

.pi-l2d-btn-del:hover {
	color: var(--red, #ef4444);
	background: color-mix(in srgb, var(--red, #ef4444) 15%, transparent);
}

/* ── 音乐口型对齐控制浮动面板 ──────────────────────────────────── */
.pi-l2d-music-panel {
	position: fixed;
	z-index: 9995;
	width: 320px;
	max-width: calc(100vw - 32px);
	background: var(--bg-elev2, #1e222b);
	border: 1px solid var(--border, #334155);
	border-radius: 14px;
	box-shadow: 0 16px 40px rgba(0, 0, 0, 0.4);
	backdrop-filter: blur(20px);
	-webkit-backdrop-filter: blur(20px);
	color: var(--text, #f1f5f9);
	font-size: 13px;
	pointer-events: auto;
	display: flex;
	flex-direction: column;
	opacity: 0;
	transform: scale(0.95) translateY(8px);
	transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1), transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.pi-l2d-music-panel.pi-l2d-music-visible {
	opacity: 1;
	transform: scale(1) translateY(0);
}

.pi-l2d-music-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 12px 14px 10px;
	border-bottom: 1px solid var(--border, #334155);
	font-weight: 600;
	font-size: 13.5px;
}

.pi-l2d-music-title {
	display: flex;
	align-items: center;
	gap: 6px;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.pi-l2d-music-body {
	padding: 14px;
	display: flex;
	flex-direction: column;
	gap: 12px;
	overflow-y: auto;
	max-height: 480px;
}

/* 音频来源操作行 */
.pi-l2d-music-source-row {
	display: flex;
	gap: 8px;
}

.pi-l2d-music-source-btn {
	flex: 1;
	min-width: 0;
	padding: 7px 10px;
	background: var(--bg, #0d0f14);
	border: 1px solid var(--border, #334155);
	border-radius: 8px;
	color: var(--text, #f1f5f9);
	font-size: 12px;
	cursor: pointer;
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 5px;
	transition: all 0.15s ease;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.pi-l2d-music-source-btn:hover {
	border-color: var(--accent, #3b82f6);
	background: color-mix(in srgb, var(--accent, #3b82f6) 12%, transparent);
	color: var(--accent, #3b82f6);
}

/* 当前曲目与播放进度卡片 */
.pi-l2d-music-track-card {
	padding: 10px 12px;
	background: var(--bg, #0d0f14);
	border: 1px solid var(--border, #334155);
	border-radius: 10px;
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.pi-l2d-track-name {
	font-size: 12.5px;
	font-weight: 500;
	color: var(--text, #f1f5f9);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.pi-l2d-progress-wrap {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.pi-l2d-progress-bar {
	width: 100%;
	height: 6px;
	background: var(--bg-elev2, #1e222b);
	border-radius: 3px;
	cursor: pointer;
	position: relative;
	overflow: hidden;
}

.pi-l2d-progress-fill {
	height: 100%;
	width: 0%;
	background: var(--accent, #3b82f6);
	border-radius: 3px;
	transition: width 0.08s linear;
}

.pi-l2d-progress-time {
	display: flex;
	justify-content: space-between;
	font-size: 11px;
	color: var(--text-faint, #64748b);
	font-variant-numeric: tabular-nums;
}

/* 播放主控制按钮组 */
.pi-l2d-music-controls {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 12px;
}

.pi-l2d-music-panel .pi-l2d-ctrl-btn {
	border: 1px solid var(--border, #334155);
	background: var(--bg-elev2, #1e222b);
	color: var(--text, #f1f5f9);
	border-radius: 50%;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	cursor: pointer;
	transition: all 0.15s ease;
	/* 硬约束圆形: 防宿主/主题全局 button 样式把播放键拉成椭圆 */
	flex: none !important;
	flex-grow: 0 !important;
	flex-shrink: 0 !important;
	box-sizing: border-box !important;
	padding: 0 !important;
	margin: 0 !important;
	line-height: 1 !important;
	aspect-ratio: 1 / 1 !important;
}

.pi-l2d-music-panel .pi-l2d-ctrl-btn:hover {
	border-color: var(--accent, #3b82f6);
	background: color-mix(in srgb, var(--accent, #3b82f6) 15%, transparent);
	color: var(--accent, #3b82f6);
}

.pi-l2d-music-panel .pi-l2d-ctrl-btn.main {
	width: 44px !important;
	height: 44px !important;
	min-width: 44px !important;
	max-width: 44px !important;
	min-height: 44px !important;
	max-height: 44px !important;
	font-size: 16px;
	background: var(--accent, #3b82f6);
	color: var(--accent-contrast, #ffffff);
	border-color: transparent;
	box-shadow: 0 4px 14px color-mix(in srgb, var(--accent, #3b82f6) 40%, transparent);
}

.pi-l2d-music-panel .pi-l2d-ctrl-btn.main:hover {
	transform: scale(1.06);
	filter: brightness(1.1);
}

.pi-l2d-music-panel .pi-l2d-ctrl-btn.sub {
	width: 34px !important;
	height: 34px !important;
	min-width: 34px !important;
	max-width: 34px !important;
	min-height: 34px !important;
	max-height: 34px !important;
	font-size: 13px;
}

/* 实时口型与音量可视化指示 */
.pi-l2d-lip-meter-wrap {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 8px 12px;
	background: var(--bg, #0d0f14);
	border: 1px solid var(--border, #334155);
	border-radius: 8px;
}

.pi-l2d-lip-icon {
	font-size: 18px;
	transition: transform 0.08s ease;
	display: inline-block;
}

.pi-l2d-meter-track {
	flex: 1;
	height: 8px;
	background: var(--bg-elev2, #1e222b);
	border-radius: 4px;
	overflow: hidden;
	position: relative;
}

.pi-l2d-meter-bar {
	height: 100%;
	width: 0%;
	background: linear-gradient(90deg, var(--green, #22c55e), var(--accent, #3b82f6), var(--red, #ef4444));
	border-radius: 4px;
	transition: width 0.06s linear;
}

/* 参数调节滑块行 */
.pi-l2d-slider-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
	font-size: 12px;
}

.pi-l2d-slider-label {
	color: var(--text-faint, #64748b);
	white-space: nowrap;
	min-width: 80px;
}

.pi-l2d-slider-input {
	flex: 1;
	accent-color: var(--accent, #3b82f6);
	cursor: pointer;
}

.pi-l2d-slider-val {
	font-variant-numeric: tabular-nums;
	color: var(--text, #f1f5f9);
	font-size: 11.5px;
	min-width: 36px;
	text-align: right;
}

/* 眨眼互动按键行 */
.pi-l2d-blink-actions {
	display: flex;
	gap: 8px;
}

.pi-l2d-blink-btn {
	flex: 1;
	padding: 6px 8px;
	border: 1px solid var(--border, #334155);
	background: var(--bg-elev2, #1e222b);
	color: var(--text, #f1f5f9);
	border-radius: 6px;
	font-size: 12px;
	cursor: pointer;
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 4px;
	transition: all 0.15s ease;
}

.pi-l2d-blink-btn:hover {
	border-color: var(--accent, #3b82f6);
	background: color-mix(in srgb, var(--accent, #3b82f6) 15%, transparent);
	color: var(--accent, #3b82f6);
}

/* 正在播放时挂件上的漂浮音符徽章 */
.pi-l2d-music-badge {
	position: absolute;
	top: -6px;
	right: 12px;
	background: var(--accent, #3b82f6);
	color: var(--accent-contrast, #ffffff);
	font-size: 11px;
	padding: 2px 7px;
	border-radius: 10px;
	cursor: pointer;
	box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
	display: none;
	align-items: center;
	gap: 3px;
	animation: piL2dPulse 1.4s ease-in-out infinite;
	pointer-events: auto;
	z-index: 9992;
}

.pi-l2d-music-badge.visible {
	display: flex;
}

@keyframes piL2dPulse {
	0%, 100% {
		transform: scale(1);
	}
	50% {
		transform: scale(1.08) translateY(-2px);
	}
}
`;
