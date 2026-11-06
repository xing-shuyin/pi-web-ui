import { Live2DStage, ensureLive2dEngine } from "./engine.mjs";
import { getAllModels, saveCustomModels, loadCustomModels } from "./models.mjs";
import { WIDGET_CSS } from "./styles.mjs";
import { esc as escapeHtml } from "@pi-web-ui/plugin-sdk/client";

const POS_STORAGE_KEY = "pi-web-ui:live2d-pos";
const CONFIG_STORAGE_KEY = "pi-web-ui:live2d-config";

function playChirpSound() {
	try {
		const Ctx = window.AudioContext || window.webkitAudioContext;
		if (!Ctx) return;
		const ctx = new Ctx();
		if (ctx.state === "suspended") void ctx.resume();
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = "sine";
		osc.frequency.setValueAtTime(880, ctx.currentTime);
		osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
		gain.gain.setValueAtTime(0.08, ctx.currentTime);
		gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
		osc.connect(gain);
		gain.connect(ctx.destination);
		osc.start();
		osc.stop(ctx.currentTime + 0.15);
	} catch {}
}

export class Live2DWidget {
	constructor(options = {}) {
		this.clientBase = options.clientBase || "/plugins/live2d/client";
		this.t = options.t || ((k) => k);
		this.config = this._loadConfig();
		this.models = getAllModels(this.clientBase);
		this.activeModel = this.models.find((m) => m.key === this.config.modelKey) || this.models[0];

		this.stage = null;
		this.container = null;
		this.bodyWrap = null;
		this.canvas = null;
		this.bubbleEl = null;
		this.bubbleTimer = null;
		this.contextMenuEl = null;
		this.modalEl = null;
		this._hideTimer = null;
		this._onPointerMove = null;
		this._onPointerUp = null;

		document.getElementById("pi-l2d-minimized-pill")?.remove();

		this.width = Math.round(280 * (this.config.scale || 1.0));
		this.height = Math.round(340 * (this.config.scale || 1.0));
		this.visible = this.config.enabled !== false;

		this._initStyles();
		this._buildDOM();
		this._setupGestures();
		this._setupEvents();
	}

	_loadConfig() {
		try {
			const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
			if (raw) return JSON.parse(raw);
		} catch {}
		return {
			enabled: true,
			modelKey: "shizuku",
			mode: "mouse",
			scale: 1.0,
			clickThrough: false,
			reactToAgent: true,
			soundEnabled: true,
			autoBlink: true,
			lipSyncSensitivity: 1.25,
			voiceOnly: true,
		};
	}

	_saveConfig() {
		try {
			localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(this.config));
		} catch {}
	}

	_initStyles() {
		let style = document.getElementById("pi-live2d-styles");
		if (!style) {
			style = document.createElement("style");
			style.id = "pi-live2d-styles";
			document.head.appendChild(style);
		}
		style.textContent = WIDGET_CSS;
	}

	_buildDOM() {
		const container = document.createElement("div");
		container.id = "pi-live2d-companion";
		if (!this.visible) {
			container.classList.add("pi-l2d-hidden");
			container.style.display = "none";
		}
		if (this.config.clickThrough) container.classList.add("pi-l2d-click-through");

		this._applyStoredPosition(container);

		const bubble = document.createElement("div");
		bubble.className = "pi-l2d-bubble";
		bubble.innerHTML = `
			<div class="pi-l2d-bubble-badge" style="display: none;">
				<span class="pi-l2d-bubble-badge-icon">💭</span>
				<span class="pi-l2d-bubble-badge-label">${this.t("bubble.thought_label")}</span>
			</div>
			<span class="pi-l2d-bubble-text">${this.t("bubble.default")}</span>
			<button class="pi-l2d-bubble-close">✕</button>
			<div class="pi-l2d-thought-dots" aria-hidden="true">
				<span class="pi-l2d-thought-dot pi-l2d-dot-1"></span>
				<span class="pi-l2d-thought-dot pi-l2d-dot-2"></span>
			</div>
		`;
		bubble.querySelector(".pi-l2d-bubble-close").addEventListener("click", (e) => {
			e.stopPropagation();
			this.hideBubble();
		});
		this.bubbleEl = bubble;
		container.appendChild(bubble);

		const bodyWrap = document.createElement("div");
		bodyWrap.className = "pi-l2d-body-wrap";
		this.bodyWrap = bodyWrap;

		const canvas = document.createElement("canvas");
		canvas.className = "pi-l2d-canvas";
		canvas.width = this.width;
		canvas.height = this.height;
		canvas.style.width = `${this.width}px`;
		canvas.style.height = `${this.height}px`;
		this.canvas = canvas;
		bodyWrap.appendChild(canvas);

		const actionsBar = document.createElement("div");
		actionsBar.className = "pi-l2d-actions-bar";
		actionsBar.innerHTML = `
			<button class="pi-l2d-action-btn" data-action="exp" title="${this.t("actions.expressions")}">🎭</button>
			<button class="pi-l2d-action-btn" data-action="switch" title="${this.t("actions.switch_model")}">🔄</button>
			<button class="pi-l2d-action-btn" data-action="music" title="${this.t("actions.music")}">🎵</button>
			<button class="pi-l2d-action-btn" data-action="mode" title="${this.t("actions.mode")}">👀</button>
			<button class="pi-l2d-action-btn" data-action="ghost" title="${this.t("actions.click_through")}">👻</button>
			<button class="pi-l2d-action-btn" data-action="settings" title="${this.t("actions.settings")}">⚙️</button>
			<button class="pi-l2d-action-btn" data-action="close" title="${this.t("actions.close")}">✕</button>
		`;
		actionsBar.addEventListener("click", (e) => {
			const btn = e.target.closest(".pi-l2d-action-btn");
			if (!btn) return;
			e.stopPropagation();
			const act = btn.dataset.action;
			if (act === "exp") this._showExpressionsMenu(btn);
			else if (act === "switch") this._showModelsMenu(btn);
			else if (act === "music") this.openMusicPanel();
			else if (act === "mode") this._toggleMode();
			else if (act === "ghost") this.toggleClickThrough();
			else if (act === "settings") this.openSettings();
			else if (act === "close") this.hide();
		});
		bodyWrap.appendChild(actionsBar);

		const musicBadge = document.createElement("div");
		musicBadge.className = "pi-l2d-music-badge";
		musicBadge.innerHTML = `🎵 <span class="pi-l2d-badge-note">♪</span>`;
		musicBadge.title = this.t("music.title");
		musicBadge.addEventListener("click", (e) => {
			e.stopPropagation();
			this.openMusicPanel();
		});
		this.musicBadgeEl = musicBadge;
		bodyWrap.appendChild(musicBadge);

		container.appendChild(bodyWrap);
		document.body.appendChild(container);
		this.container = container;
	}

	_applyStoredPosition(el) {
		try {
			const raw = localStorage.getItem(POS_STORAGE_KEY);
			if (raw) {
				const pos = JSON.parse(raw);
				if (pos.right !== undefined) el.style.right = `${pos.right}px`;
				if (pos.bottom !== undefined) el.style.bottom = `${pos.bottom}px`;
				if (pos.left !== undefined) {
					const maxLeft = Math.max(10, window.innerWidth - this.width - 10);
					const left = Math.max(10, Math.min(maxLeft, Number(pos.left) || 0));
					el.style.left = `${left}px`;
					el.style.right = "auto";
				}
				if (pos.top !== undefined) {
					const maxTop = Math.max(10, window.innerHeight - this.height - 10);
					const top = Math.max(10, Math.min(maxTop, Number(pos.top) || 0));
					el.style.top = `${top}px`;
					el.style.bottom = "auto";
				}
				return;
			}
		} catch {}
		el.style.right = "24px";
		el.style.bottom = "24px";
	}

	_abortDragging() {
		if (this.isDragging) {
			this.isDragging = false;
			if (this._onPointerMove) window.removeEventListener("pointermove", this._onPointerMove);
			if (this._onPointerUp) window.removeEventListener("pointerup", this._onPointerUp);
			this._onPointerMove = null;
			this._onPointerUp = null;
		}
	}

	_setupGestures() {
		this.isDragging = false;
		let startX = 0;
		let startY = 0;
		let origLeft = 0;
		let origTop = 0;
		let moved = false;

		const onPointerDown = (e) => {
			if (!this.visible || this.config.clickThrough) return;
			if (e.button !== 0) return;
			if (e.target.closest(".pi-l2d-actions-bar") || e.target.closest(".pi-l2d-bubble")) return;
			if (this.stage?.isPixelTransparent(e.clientX, e.clientY)) return;

			this.isDragging = true;
			moved = false;
			startX = e.clientX;
			startY = e.clientY;

			const rect = this.container.getBoundingClientRect();
			origLeft = rect.left;
			origTop = rect.top;

			this.container.style.left = `${origLeft}px`;
			this.container.style.top = `${origTop}px`;
			this.container.style.right = "auto";
			this.container.style.bottom = "auto";

			this._onPointerMove = onPointerMove;
			this._onPointerUp = onPointerUp;
			window.addEventListener("pointermove", onPointerMove);
			window.addEventListener("pointerup", onPointerUp);
		};

		const onPointerMove = (e) => {
			if (!this.isDragging || !this.visible) return;
			const dx = e.clientX - startX;
			const dy = e.clientY - startY;
			if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
				moved = true;
			}
			let newLeft = origLeft + dx;
			let newTop = origTop + dy;

			const maxLeft = window.innerWidth - this.width - 10;
			const maxTop = window.innerHeight - this.height - 10;
			newLeft = Math.max(10, Math.min(maxLeft, newLeft));
			newTop = Math.max(10, Math.min(maxTop, newTop));

			this.container.style.left = `${newLeft}px`;
			this.container.style.top = `${newTop}px`;
		};

		const onPointerUp = (e) => {
			if (!this.isDragging) return;
			this.isDragging = false;
			if (this._onPointerMove) window.removeEventListener("pointermove", this._onPointerMove);
			if (this._onPointerUp) window.removeEventListener("pointerup", this._onPointerUp);
			this._onPointerMove = null;
			this._onPointerUp = null;

			if (!this.visible) return;

			if (moved) {
				const rect = this.container.getBoundingClientRect();
				try {
					localStorage.setItem(
						POS_STORAGE_KEY,
						JSON.stringify({
							left: Math.round(rect.left),
							top: Math.round(rect.top),
						}),
					);
				} catch {}
			} else {
				this._handleClick(e);
			}
		};

		this.canvas.addEventListener("pointerdown", onPointerDown);

		this.container.addEventListener(
			"wheel",
			(e) => {
				if (!this.visible || this.config.clickThrough) return;
				if (this.stage?.isPixelTransparent(e.clientX, e.clientY)) return;
				e.preventDefault();
				const delta = e.deltaY > 0 ? -0.05 : 0.05;
				let nextScale = (this.config.scale || 1.0) + delta;
				nextScale = Math.max(0.4, Math.min(2.0, Math.round(nextScale * 100) / 100));
				this.setScale(nextScale);
			},
			{ passive: false },
		);
	}

	_setupEvents() {
		this.canvas.addEventListener("contextmenu", (e) => {
			if (!this.visible || this.config.clickThrough) return;
			if (this.stage?.isPixelTransparent(e.clientX, e.clientY)) return;
			e.preventDefault();
			e.stopPropagation();
			this._showContextMenu(e.clientX, e.clientY);
		});

		this.canvas.addEventListener("dblclick", (e) => {
			if (!this.visible || this.config.clickThrough) return;
			if (this.stage?.isPixelTransparent(e.clientX, e.clientY)) return;
			e.preventDefault();
			e.stopPropagation();
			this._handleDoubleClick();
		});

		window.addEventListener("click", () => {
			this._closeContextMenu();
		});
	}

	_setupStageHover() {
		if (!this.stage) return;
		this.stage.onHoverPixel = (transparent) => {
			if (!this.visible || this.config.clickThrough || this.isDragging) return;
			if (transparent === true) {
				if (this.canvas) this.canvas.style.pointerEvents = "none";
				if (this.bodyWrap) this.bodyWrap.style.pointerEvents = "none";
			} else {
				if (this.canvas) this.canvas.style.pointerEvents = "auto";
				if (this.bodyWrap) this.bodyWrap.style.pointerEvents = "auto";
			}
		};
	}

	toggleClickThrough(forced) {
		const next = typeof forced === "boolean" ? forced : !this.config.clickThrough;
		this.config.clickThrough = next;
		this._saveConfig();

		if (next) {
			this._abortDragging();
			this.container?.classList.add("pi-l2d-click-through");
			if (this.canvas) this.canvas.style.pointerEvents = "";
			if (this.bodyWrap) this.bodyWrap.style.pointerEvents = "";
			this.showBubble(this.t("toast.click_through_on"), 3500);
		} else {
			this.container?.classList.remove("pi-l2d-click-through");
			if (this.canvas) this.canvas.style.pointerEvents = "auto";
			if (this.bodyWrap) this.bodyWrap.style.pointerEvents = "auto";
			this.showBubble(this.t("toast.click_through_off"), 3000);
		}
	}

	async start() {
		try {
			await ensureLive2dEngine(this.clientBase);
			this.stage = new Live2DStage(this.canvas, {
				mode: this.config.mode || "mouse",
				autoBlink: this.config.autoBlink !== false,
				lipSyncSensitivity: this.config.lipSyncSensitivity ?? 1.25,
				voiceOnly: this.config.voiceOnly !== false,
			});
			await this.stage.init();
			await this.stage.loadModel(this.activeModel);

			this._setupStageHover();
			this._setupAudioSyncListeners();

			if (!this.visible) {
				this.stage.stop();
			} else {
				setTimeout(() => {
					this.showBubble(this.t("bubble.default"), 4500);
				}, 600);
			}
		} catch (err) {
			console.error("[live2d] 初始化挂件失败:", err);
		}
	}

	async switchModel(modelKey) {
		const target = this.models.find((m) => m.key === modelKey);
		if (!target || !this.stage) return;
		const prevModel = this.activeModel;
		const prevKey = this.config.modelKey;
		this.activeModel = target;
		this.config.modelKey = modelKey;
		this._saveConfig();

		this.showBubble(`${this.t("toast.switched_model")}${target.name}`, 3000);
		if (this.config.soundEnabled) playChirpSound();
		try {
			await this.stage.loadModel(target);
		} catch (err) {
			console.error("[live2d] 模型切换失败，回退到先前模型:", err);
			this.showBubble(`加载 ${target.name} 失败，已恢复`, 3500);
			this.activeModel = prevModel;
			this.config.modelKey = prevKey;
			this._saveConfig();
			if (prevModel) {
				try {
					await this.stage.loadModel(prevModel);
				} catch {}
			}
		}
	}

	_toggleMode() {
		const nextMode = this.config.mode === "mouse" ? "idle" : "mouse";
		this.config.mode = nextMode;
		this._saveConfig();
		this.stage?.setMode(nextMode);
		const label = nextMode === "mouse" ? this.t("menu.mode.mouse") : this.t("menu.mode.idle");
		this.showBubble(`${this.t("toast.switched_mode")}${label}`, 2500);
	}

	setScale(scale) {
		this.config.scale = scale;
		this._saveConfig();
		this.width = Math.round(280 * scale);
		this.height = Math.round(340 * scale);
		this.canvas.style.width = `${this.width}px`;
		this.canvas.style.height = `${this.height}px`;
		this.stage?.resize(this.width, this.height);
	}

	_handleClick(e) {
		if (!this.stage) return;
		const area = this.stage.hitTest(e.clientX, e.clientY);

		if (this.config.soundEnabled) playChirpSound();

		if (area === "head") {
			this.stage.playMotion("flick_head") || this.stage.playMotion("Tap") || this.stage.playMotion("TapBody");
			this.stage.playExpression("happy");
			this.showBubble(this.t("bubble.poke_head"), 3500);
		} else if (area === "mouth") {
			this.stage.playExpression("surprised");
			this.showBubble(this.t("bubble.poke_mouth"), 3500);
		} else {
			this.stage.playMotion("tap_body") || this.stage.playMotion("Tap") || this.stage.playMotion("TapBody");
			this.stage.playExpression("blush") || this.stage.playExpression("happy");
			this.showBubble(this.t("bubble.poke_body"), 3500);
		}
	}

	_handleDoubleClick() {
		if (!this.stage) return;
		this.stage.playMotion("shake") || this.stage.playMotion("Tap");
		this.stage.playExpression("happy");
		const quotes = [
			this.t("bubble.random1"),
			this.t("bubble.random2"),
			this.t("bubble.random3"),
			this.t("bubble.random4"),
		];
		const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
		this.showBubble(randomQuote, 4000);
	}

	showBubble(text, duration = 4000, options = {}) {
		if (!this.bubbleEl || !this.visible) return;
		const isThought = Boolean(options?.isThought || options?.thought);
		const textSpan = this.bubbleEl.querySelector(".pi-l2d-bubble-text");
		if (textSpan) textSpan.textContent = text;

		const badgeEl = this.bubbleEl.querySelector(".pi-l2d-bubble-badge");
		const badgeLabel = this.bubbleEl.querySelector(".pi-l2d-bubble-badge-label");
		if (badgeEl) {
			if (isThought) {
				badgeEl.style.display = "inline-flex";
				if (badgeLabel) badgeLabel.textContent = this.t("bubble.thought_label");
			} else {
				badgeEl.style.display = "none";
			}
		}

		if (isThought) {
			this.bubbleEl.classList.add("pi-l2d-bubble-thought");
		} else {
			this.bubbleEl.classList.remove("pi-l2d-bubble-thought");
		}

		this.bubbleEl.classList.add("pi-l2d-bubble-visible");

		if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
		if (duration > 0) {
			this.bubbleTimer = setTimeout(() => {
				this.hideBubble();
			}, duration);
		}
	}

	showThought(text, duration = 5000, emotion) {
		if (emotion && this.stage?.playExpression) {
			this.stage.playExpression(emotion);
		}
		this.showBubble(text, duration, { isThought: true });
	}

	hideBubble() {
		if (this.bubbleEl) {
			this.bubbleEl.classList.remove("pi-l2d-bubble-visible");
			this.bubbleEl.classList.remove("pi-l2d-bubble-thought");
			const badgeEl = this.bubbleEl.querySelector(".pi-l2d-bubble-badge");
			if (badgeEl) badgeEl.style.display = "none";
		}
		if (this.bubbleTimer) {
			clearTimeout(this.bubbleTimer);
			this.bubbleTimer = null;
		}
	}

	show() {
		this.visible = true;
		this.config.enabled = true;
		this._saveConfig();
		if (this._hideTimer) {
			clearTimeout(this._hideTimer);
			this._hideTimer = null;
		}
		if (this.container) {
			this.container.style.display = "";
			void this.container.offsetHeight;
			this.container.classList.remove("pi-l2d-hidden");
			try {
				const rect = this.container.getBoundingClientRect();
				if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) {
					this.container.style.left = "";
					this.container.style.top = "";
					this.container.style.right = "24px";
					this.container.style.bottom = "24px";
					try {
						localStorage.removeItem(POS_STORAGE_KEY);
					} catch {}
				}
			} catch {}
		}
		if (this.canvas) this.canvas.style.pointerEvents = "auto";
		if (this.bodyWrap) this.bodyWrap.style.pointerEvents = "auto";
		this.stage?.start();
		this.showBubble(this.t("bubble.default"), 3000);
	}

	hide() {
		this.visible = false;
		this.config.enabled = false;
		this._saveConfig();
		this.hideBubble();
		this._closeContextMenu();
		this._abortDragging();
		if (this.modalEl) {
			this.modalEl.remove();
			this.modalEl = null;
		}
		this.stage?.stop();
		if (this.container) {
			this.container.classList.add("pi-l2d-hidden");
			if (this._hideTimer) clearTimeout(this._hideTimer);
			this._hideTimer = setTimeout(() => {
				if (!this.visible && this.container) {
					this.container.style.display = "none";
				}
			}, 260);
		}
	}

	toggle() {
		if (this.visible) this.hide();
		else this.show();
	}

	_showContextMenu(clientX, clientY) {
		this._closeContextMenu();

		const menu = document.createElement("div");
		menu.className = "pi-l2d-contextmenu";

		menu.appendChild(this._createMenuTitle(this.t("menu.mode")));
		const isMouse = this.config.mode === "mouse";
		menu.appendChild(
			this._createMenuItem(this.t("menu.mode.mouse"), isMouse, () => {
				this.config.mode = "mouse";
				this._saveConfig();
				this.stage?.setMode("mouse");
			}),
		);
		menu.appendChild(
			this._createMenuItem(this.t("menu.mode.idle"), !isMouse, () => {
				this.config.mode = "idle";
				this._saveConfig();
				this.stage?.setMode("idle");
			}),
		);
		menu.appendChild(
			this._createMenuItem(
				this.config.clickThrough ? this.t("menu.click_through_disable") : this.t("menu.click_through_enable"),
				Boolean(this.config.clickThrough),
				() => {
					this.toggleClickThrough();
				},
			),
		);

		menu.appendChild(this._createDivider());

		const expressions = this.stage?.expressions || [];
		if (expressions.length > 0) {
			menu.appendChild(this._createMenuTitle(this.t("menu.expressions")));
			const previewExps = expressions.slice(0, 5);
			for (const exp of previewExps) {
				menu.appendChild(
					this._createMenuItem(`🎭 ${exp}`, false, () => {
						this.stage?.playExpression(exp);
					}),
				);
			}
			menu.appendChild(this._createDivider());
		}

		menu.appendChild(this._createMenuTitle(this.t("menu.models")));
		for (const m of this.models) {
			menu.appendChild(
				this._createMenuItem(m.name, m.key === this.activeModel.key, () => {
					this.switchModel(m.key);
				}),
			);
		}

		menu.appendChild(this._createDivider());

		menu.appendChild(this._createMenuTitle(this.t("menu.music_and_blink")));
		menu.appendChild(
			this._createMenuItem(this.t("menu.music_panel"), false, () => {
				this.openMusicPanel();
			}),
		);
		menu.appendChild(
			this._createMenuItem(this.t("menu.blink_eye"), false, () => {
				this.stage?.triggerBlink();
			}),
		);
		menu.appendChild(
			this._createMenuItem(this.t("menu.wink_eye"), false, () => {
				this.stage?.triggerWink(Math.random() > 0.5 ? "left" : "right");
			}),
		);

		menu.appendChild(this._createDivider());

		menu.appendChild(
			this._createMenuItem(this.t("menu.reset_pos"), false, () => {
				localStorage.removeItem(POS_STORAGE_KEY);
				this.container.style.left = "auto";
				this.container.style.top = "auto";
				this.container.style.right = "24px";
				this.container.style.bottom = "24px";
			}),
		);

		menu.appendChild(
			this._createMenuItem(this.t("menu.settings"), false, () => {
				this.openSettings();
			}),
		);

		menu.appendChild(
			this._createMenuItem(this.t("menu.hide"), false, () => {
				this.hide();
			}),
		);

		document.body.appendChild(menu);
		this.contextMenuEl = menu;

		const menuW = 200;
		const menuH = menu.offsetHeight || 280;
		const x = Math.min(window.innerWidth - menuW - 10, clientX);
		const y = Math.min(window.innerHeight - menuH - 10, clientY);
		menu.style.left = `${x}px`;
		menu.style.top = `${y}px`;

		requestAnimationFrame(() => menu.classList.add("pi-l2d-menu-visible"));
	}

	_showExpressionsMenu(anchorBtn) {
		const rect = anchorBtn.getBoundingClientRect();
		this._showContextMenu(rect.left - 200, rect.top);
	}

	_showModelsMenu(anchorBtn) {
		const rect = anchorBtn.getBoundingClientRect();
		this._showContextMenu(rect.left - 200, rect.top);
	}

	_createMenuTitle(text) {
		const el = document.createElement("div");
		el.className = "pi-l2d-menu-group-title";
		el.textContent = text;
		return el;
	}

	_createMenuItem(text, active, onClick) {
		const el = document.createElement("div");
		el.className = "pi-l2d-menu-item" + (active ? " active" : "");
		el.textContent = text;
		el.addEventListener("click", (e) => {
			e.stopPropagation();
			this._closeContextMenu();
			onClick();
		});
		return el;
	}

	_createDivider() {
		const el = document.createElement("div");
		el.className = "pi-l2d-menu-divider";
		return el;
	}

	_closeContextMenu() {
		if (this.contextMenuEl) {
			this.contextMenuEl.remove();
			this.contextMenuEl = null;
		}
	}

	_setupAudioSyncListeners() {
		if (!this.stage?.audioSync) return;
		const audioSync = this.stage.audioSync;

		audioSync.onStateChange = (state) => {
			this._updateMusicBadge();
			this._updateMusicPanelPlayState(state);
		};

		audioSync.onProgress = (cur, dur) => {
			this._updateMusicPanelProgress(cur, dur);
		};

		audioSync.onEnded = () => {
			this._updateMusicBadge();
			this._updateMusicPanelPlayState("idle");
		};
	}

	_updateMusicBadge() {
		if (!this.musicBadgeEl) return;
		const isPlaying = this.stage?.audioSync?.isPlaying();
		if (isPlaying) {
			this.musicBadgeEl.classList.add("visible");
		} else {
			this.musicBadgeEl.classList.remove("visible");
		}
	}

	openMusicPanel() {
		if (this.musicPanelEl) {
			this.closeMusicPanel();
			return;
		}

		const panel = document.createElement("div");
		panel.className = "pi-l2d-music-panel";

		const audioSync = this.stage?.audioSync;
		const curTrack = audioSync?.trackTitle || this.t("music.track_idle");
		const isPlaying = audioSync?.isPlaying();

		panel.innerHTML = `
			<div class="pi-l2d-music-head">
				<div class="pi-l2d-music-title">
					<span>🎵</span>
					<span>${this.t("music.title")}</span>
				</div>
				<button class="pi-l2d-bubble-close" id="pi-l2d-music-close">✕</button>
			</div>
			<div class="pi-l2d-music-body">
				<!-- 1. 音频来源切换行 -->
				<div class="pi-l2d-music-source-row">
					<button type="button" class="pi-l2d-music-source-btn" id="pi-l2d-btn-music-local" title="${this.t("music.source_local_desc")}">
						<span>📁</span>
						<span>${this.t("music.source_local")}</span>
					</button>
					<button type="button" class="pi-l2d-music-source-btn" id="pi-l2d-btn-music-demo" title="${this.t("music.source_demo_desc")}">
						<span>🎹</span>
						<span>${this.t("music.source_demo")}</span>
					</button>
					<button type="button" class="pi-l2d-music-source-btn" id="pi-l2d-btn-music-url-toggle">
						<span>🌐</span>
						<span>${this.t("music.source_url")}</span>
					</button>
				</div>
				<input type="file" id="pi-l2d-input-audio-file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac" style="display:none;" />

				<!-- 2. 网络 URL 抽屉 (可折叠) -->
				<div id="pi-l2d-url-drawer" style="display: none; flex-direction: column; gap: 6px; padding: 10px; background: var(--bg, #0d0f14); border-radius: 8px; border: 1px solid var(--border, #334155);">
					<input class="pi-l2d-input" id="pi-l2d-music-url-input" placeholder="${this.t("music.url_placeholder")}" />
					<div style="display: flex; gap: 6px; justify-content: flex-end;">
						<button type="button" class="pi-l2d-btn pi-l2d-btn-primary" id="pi-l2d-btn-play-url" style="font-size: 12px; padding: 4px 10px;">${this.t("music.play")}</button>
					</div>
				</div>

				<!-- 3. 正在播放卡片与进度条 -->
				<div class="pi-l2d-music-track-card" id="pi-l2d-track-dropzone">
					<div class="pi-l2d-track-name" id="pi-l2d-current-track-name">${escapeHtml(curTrack)}</div>
					<div class="pi-l2d-progress-wrap">
						<div class="pi-l2d-progress-bar" id="pi-l2d-music-progress-bar">
							<div class="pi-l2d-progress-fill" id="pi-l2d-music-progress-fill"></div>
						</div>
						<div class="pi-l2d-progress-time">
							<span id="pi-l2d-time-cur">00:00</span>
							<span id="pi-l2d-time-dur">00:00</span>
						</div>
					</div>

					<div class="pi-l2d-music-controls">
						<button type="button" class="pi-l2d-ctrl-btn sub" id="pi-l2d-btn-music-stop" title="${this.t("music.stop")}">⏹</button>
						<button type="button" class="pi-l2d-ctrl-btn main" id="pi-l2d-btn-music-toggle" title="${this.t("music.play_pause")}">
							${isPlaying ? "⏸" : "▶"}
						</button>
					</div>
				</div>

				<!-- 4. 实时口型开合开度指示器 -->
				<div class="pi-l2d-lip-meter-wrap" title="${this.t("music.lip_meter_desc")}">
					<span class="pi-l2d-lip-icon" id="pi-l2d-lip-icon">👄</span>
					<div class="pi-l2d-meter-track">
						<div class="pi-l2d-meter-bar" id="pi-l2d-lip-meter-bar"></div>
					</div>
					<span style="font-size: 11px; color: var(--text-faint, #64748b); font-variant-numeric: tabular-nums;" id="pi-l2d-lip-val">0%</span>
				</div>

				<!-- 5. 灵敏度与音量滑块 -->
				<div class="pi-l2d-slider-row">
					<span class="pi-l2d-slider-label">👄 ${this.t("music.sens_label")}</span>
					<input type="range" class="pi-l2d-slider-input" id="pi-l2d-music-sens" min="0.5" max="2.5" step="0.05" value="${this.config.lipSyncSensitivity ?? 1.25}" />
					<span class="pi-l2d-slider-val" id="pi-l2d-music-sens-val">${Math.round((this.config.lipSyncSensitivity ?? 1.25) * 100)}%</span>
				</div>

				<div class="pi-l2d-slider-row">
					<span class="pi-l2d-slider-label">🔊 ${this.t("music.volume_label")}</span>
					<input type="range" class="pi-l2d-slider-input" id="pi-l2d-music-vol" min="0" max="1" step="0.02" value="${audioSync?.volume ?? 0.85}" />
					<span class="pi-l2d-slider-val" id="pi-l2d-music-vol-val">${Math.round((audioSync?.volume ?? 0.85) * 100)}%</span>
				</div>

				<!-- 6. 眨眼控制与互动 -->
				<div style="border-top: 1px solid var(--border, #334155); padding-top: 8px; display: flex; flex-direction: column; gap: 8px;">
					<div class="pi-l2d-switch-row" style="padding: 0;" title="${this.t("music.voice_only_desc")}">
						<span style="font-size: 12px;">🎤 ${this.t("music.voice_only")}</span>
						<input type="checkbox" id="pi-l2d-music-voice-only" ${this.config.voiceOnly !== false ? "checked" : ""} />
					</div>
					<div class="pi-l2d-switch-row" style="padding: 0;">
						<span style="font-size: 12px;">😉 ${this.t("music.auto_blink")}</span>
						<input type="checkbox" id="pi-l2d-music-auto-blink" ${this.config.autoBlink !== false ? "checked" : ""} />
					</div>
					<div class="pi-l2d-blink-actions">
						<button type="button" class="pi-l2d-blink-btn" id="pi-l2d-btn-blink-now">${this.t("music.blink_now")}</button>
						<button type="button" class="pi-l2d-blink-btn" id="pi-l2d-btn-wink-now">${this.t("music.wink_now")}</button>
					</div>
				</div>
			</div>
		`;

		document.body.appendChild(panel);
		this.musicPanelEl = panel;

		this._positionMusicPanel(panel);

		this._bindMusicPanelEvents(panel);

		this._startMeterRaf();

		requestAnimationFrame(() => panel.classList.add("pi-l2d-music-visible"));
	}

	_positionMusicPanel(panel) {
		const widgetRect = this.container
			? this.container.getBoundingClientRect()
			: { right: 24, bottom: 24, top: 100, left: 100 };
		const panelW = 320;
		const panelH = 430;

		let left = widgetRect.left - panelW - 12;
		let top = widgetRect.top;

		if (left < 10) {
			left = Math.max(10, widgetRect.right - panelW);
			top = Math.max(10, widgetRect.top - panelH - 12);
		}
		if (top + panelH > window.innerHeight - 10) {
			top = Math.max(10, window.innerHeight - panelH - 10);
		}

		panel.style.left = `${left}px`;
		panel.style.top = `${top}px`;
	}

	_bindMusicPanelEvents(panel) {
		const audioSync = this.stage?.audioSync;

		panel.querySelector("#pi-l2d-music-close").addEventListener("click", () => {
			this.closeMusicPanel();
		});

		const fileInput = panel.querySelector("#pi-l2d-input-audio-file");
		panel.querySelector("#pi-l2d-btn-music-local").addEventListener("click", () => {
			fileInput.click();
		});
		fileInput.addEventListener("change", (e) => {
			const file = e.target.files?.[0];
			if (file && audioSync) {
				void audioSync.playFile(file);
				panel.querySelector("#pi-l2d-current-track-name").textContent = file.name.replace(/\.[^/.]+$/, "");
			}
			fileInput.value = "";
		});

		const dropzone = panel.querySelector("#pi-l2d-track-dropzone");
		dropzone.addEventListener("dragover", (e) => {
			e.preventDefault();
			dropzone.style.borderColor = "var(--accent, #3b82f6)";
		});
		dropzone.addEventListener("dragleave", () => {
			dropzone.style.borderColor = "";
		});
		dropzone.addEventListener("drop", (e) => {
			e.preventDefault();
			dropzone.style.borderColor = "";
			const file = e.dataTransfer?.files?.[0];
			if (file && audioSync) {
				void audioSync.playFile(file);
				panel.querySelector("#pi-l2d-current-track-name").textContent = file.name.replace(/\.[^/.]+$/, "");
			}
		});

		panel.querySelector("#pi-l2d-btn-music-demo").addEventListener("click", () => {
			if (audioSync) {
				audioSync.playDemo();
				panel.querySelector("#pi-l2d-current-track-name").textContent = audioSync.trackTitle;
			}
		});

		const urlDrawer = panel.querySelector("#pi-l2d-url-drawer");
		panel.querySelector("#pi-l2d-btn-music-url-toggle").addEventListener("click", () => {
			const isHidden = urlDrawer.style.display === "none";
			urlDrawer.style.display = isHidden ? "flex" : "none";
			if (isHidden) panel.querySelector("#pi-l2d-music-url-input").focus();
		});

		panel.querySelector("#pi-l2d-btn-play-url").addEventListener("click", () => {
			const urlInput = panel.querySelector("#pi-l2d-music-url-input");
			const val = urlInput.value.trim();
			if (val && audioSync) {
				void audioSync.playUrl(val);
				panel.querySelector("#pi-l2d-current-track-name").textContent = audioSync.trackTitle;
			}
		});

		panel.querySelector("#pi-l2d-btn-music-toggle").addEventListener("click", () => {
			if (audioSync) audioSync.togglePlayPause();
		});
		panel.querySelector("#pi-l2d-btn-music-stop").addEventListener("click", () => {
			if (audioSync) audioSync.stop();
		});

		const progressBar = panel.querySelector("#pi-l2d-music-progress-bar");
		progressBar.addEventListener("click", (e) => {
			if (!audioSync || !audioSync.duration) return;
			const rect = progressBar.getBoundingClientRect();
			const clickX = e.clientX - rect.left;
			const ratio = Math.max(0, Math.min(1, clickX / rect.width));
			audioSync.seek(ratio * audioSync.duration);
		});

		const sensInput = panel.querySelector("#pi-l2d-music-sens");
		const sensVal = panel.querySelector("#pi-l2d-music-sens-val");
		sensInput.addEventListener("input", (e) => {
			const val = parseFloat(e.target.value);
			sensVal.textContent = `${Math.round(val * 100)}%`;
			this.config.lipSyncSensitivity = val;
			this._saveConfig();
			if (audioSync) audioSync.setSensitivity(val);
		});

		const volInput = panel.querySelector("#pi-l2d-music-vol");
		const volVal = panel.querySelector("#pi-l2d-music-vol-val");
		volInput.addEventListener("input", (e) => {
			const val = parseFloat(e.target.value);
			volVal.textContent = `${Math.round(val * 100)}%`;
			if (audioSync) audioSync.setVolume(val);
		});

		const voiceOnlyCheckbox = panel.querySelector("#pi-l2d-music-voice-only");
		voiceOnlyCheckbox.addEventListener("change", (e) => {
			const checked = e.target.checked;
			this.config.voiceOnly = checked;
			this._saveConfig();
			this.stage?.setVoiceOnly(checked);
		});

		const blinkCheckbox = panel.querySelector("#pi-l2d-music-auto-blink");
		blinkCheckbox.addEventListener("change", (e) => {
			const checked = e.target.checked;
			this.config.autoBlink = checked;
			this._saveConfig();
			this.stage?.setAutoBlink(checked);
		});

		panel.querySelector("#pi-l2d-btn-blink-now").addEventListener("click", () => {
			this.stage?.triggerBlink();
		});
		panel.querySelector("#pi-l2d-btn-wink-now").addEventListener("click", () => {
			this.stage?.triggerWink(Math.random() > 0.5 ? "left" : "right");
		});
	}

	_updateMusicPanelPlayState(state) {
		if (!this.musicPanelEl) return;
		const toggleBtn = this.musicPanelEl.querySelector("#pi-l2d-btn-music-toggle");
		if (toggleBtn) {
			toggleBtn.textContent = state === "playing" ? "⏸" : "▶";
		}
		const titleEl = this.musicPanelEl.querySelector("#pi-l2d-current-track-name");
		if (titleEl && this.stage?.audioSync) {
			titleEl.textContent = this.stage.audioSync.trackTitle || this.t("music.track_idle");
		}
	}

	_updateMusicPanelProgress(cur, dur) {
		if (!this.musicPanelEl) return;
		const fill = this.musicPanelEl.querySelector("#pi-l2d-music-progress-fill");
		const timeCur = this.musicPanelEl.querySelector("#pi-l2d-time-cur");
		const timeDur = this.musicPanelEl.querySelector("#pi-l2d-time-dur");

		if (fill) {
			const ratio = dur > 0 ? Math.min(100, Math.max(0, (cur / dur) * 100)) : 0;
			fill.style.width = `${ratio}%`;
		}
		if (timeCur) timeCur.textContent = this._formatTime(cur);
		if (timeDur) timeDur.textContent = this._formatTime(dur);
	}

	_formatTime(seconds) {
		if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
		const mins = Math.floor(seconds / 60);
		const secs = Math.floor(seconds % 60);
		return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
	}

	_startMeterRaf() {
		if (this._meterRafId) cancelAnimationFrame(this._meterRafId);
		const updateMeter = () => {
			if (!this.musicPanelEl) {
				this._meterRafId = null;
				return;
			}
			const audioSync = this.stage?.audioSync;
			const mouthOpen = audioSync ? audioSync.getMouthOpen() : 0;
			const pct = Math.round(mouthOpen * 100);

			const meterBar = this.musicPanelEl.querySelector("#pi-l2d-lip-meter-bar");
			const meterVal = this.musicPanelEl.querySelector("#pi-l2d-lip-val");
			const lipIcon = this.musicPanelEl.querySelector("#pi-l2d-lip-icon");

			if (meterBar) meterBar.style.width = `${pct}%`;
			if (meterVal) meterVal.textContent = `${pct}%`;
			if (lipIcon) {
				lipIcon.style.transform = `scale(${1 + mouthOpen * 0.45})`;
			}

			this._meterRafId = requestAnimationFrame(updateMeter);
		};
		this._meterRafId = requestAnimationFrame(updateMeter);
	}

	closeMusicPanel() {
		if (this._meterRafId) {
			cancelAnimationFrame(this._meterRafId);
			this._meterRafId = null;
		}
		if (this.musicPanelEl) {
			this.musicPanelEl.remove();
			this.musicPanelEl = null;
		}
	}

	async playAudio(url, title = "", volume = 0.85) {
		if (!this.stage?.audioSync) return;
		if (typeof volume === "number") this.stage.audioSync.setVolume(volume);
		if (url.startsWith("data:audio")) {
			await this.stage.audioSync.playBase64(url, undefined, title);
		} else {
			await this.stage.audioSync.playUrl(url, title);
		}
		this.showBubble(`🎵 正在播放: ${title || "音乐"}`, 3000);
	}

	stopAudio() {
		this.stage?.audioSync?.stop();
	}

	triggerBlink(type = "both") {
		if (type === "wink_left") this.stage?.triggerWink("left");
		else if (type === "wink_right" || type === "wink") this.stage?.triggerWink("right");
		else this.stage?.triggerBlink();
	}

	openSettings() {
		if (this.modalEl) return;

		const overlay = document.createElement("div");
		overlay.className = "pi-l2d-modal-overlay";

		const card = document.createElement("div");
		card.className = "pi-l2d-modal-card";
		card.innerHTML = `
			<div class="pi-l2d-modal-head">
				<span>${this.t("settings.title")}</span>
				<button class="pi-l2d-bubble-close" id="pi-l2d-close-settings">✕</button>
			</div>
			<div class="pi-l2d-modal-body">
				<!-- 1. 已配置角色列表 -->
				<div class="pi-l2d-form-group">
					<label class="pi-l2d-form-label">${this.t("settings.models")}</label>
					<div id="pi-l2d-models-list" style="display: flex; flex-direction: column; gap: 8px;"></div>
				</div>

				<!-- 2. 本地模型上传区 -->
				<div class="pi-l2d-form-group">
					<label class="pi-l2d-form-label">${this.t("settings.upload_title")}</label>
					<div class="pi-l2d-dropzone" id="pi-l2d-dropzone">
						<div class="pi-l2d-dropzone-icon">📦</div>
						<div class="pi-l2d-dropzone-title">${this.t("settings.upload_title")}</div>
						<div class="pi-l2d-dropzone-desc">${this.t("settings.upload_desc")}</div>
						<div class="pi-l2d-upload-actions">
							<button type="button" class="pi-l2d-btn pi-l2d-btn-primary" id="pi-l2d-btn-upload-zip">${this.t("settings.upload_zip_btn")}</button>
							<button type="button" class="pi-l2d-btn" id="pi-l2d-btn-upload-folder">${this.t("settings.upload_folder_btn")}</button>
						</div>
						<div class="pi-l2d-upload-status" id="pi-l2d-upload-status" style="display: none;"></div>
					</div>
					<input type="file" id="pi-l2d-file-zip" accept=".zip,application/zip" style="display:none;" />
					<input type="file" id="pi-l2d-file-folder" webkitdirectory directory multiple style="display:none;" />
				</div>

				<!-- 3. 外部 URL 导入 -->
				<div class="pi-l2d-form-group" style="padding: 12px; background: var(--bg, #0d0f14); border-radius: 8px; border: 1px solid var(--border, #334155);">
					<label class="pi-l2d-form-label">${this.t("settings.add_model")}</label>
					<input class="pi-l2d-input" id="pi-l2d-new-name" placeholder="${this.t("settings.model_name")}" />
					<input class="pi-l2d-input" id="pi-l2d-new-url" placeholder="${this.t("settings.model_url")}" style="margin-top:6px;" />
					<button class="pi-l2d-btn" id="pi-l2d-btn-add" style="margin-top:8px; align-self: flex-start;">${this.t("settings.add_model")}</button>
				</div>

				<!-- 4. 交互选项开关 -->
				<div class="pi-l2d-switch-row" style="padding: 10px 12px; background: var(--bg-elev2, #1e222b); border-radius: 8px;">
					<div>
						<div style="font-weight: 500;">${this.t("settings.click_through")}</div>
						<div style="font-size: 11.5px; color: var(--text-faint, #64748b); margin-top: 2px;">${this.t("settings.click_through_hint")}</div>
					</div>
					<input type="checkbox" id="pi-l2d-cfg-clickthrough" ${this.config.clickThrough ? "checked" : ""} />
				</div>

				<div class="pi-l2d-switch-row">
					<span>${this.t("settings.react_agent")}</span>
					<input type="checkbox" id="pi-l2d-cfg-react" ${this.config.reactToAgent ? "checked" : ""} />
				</div>

				<div class="pi-l2d-switch-row">
					<span>${this.t("settings.sound")}</span>
					<input type="checkbox" id="pi-l2d-cfg-sound" ${this.config.soundEnabled ? "checked" : ""} />
				</div>

				<div class="pi-l2d-switch-row">
					<span>${this.t("settings.auto_blink")}</span>
					<input type="checkbox" id="pi-l2d-cfg-autoblink" ${this.config.autoBlink !== false ? "checked" : ""} />
				</div>

				<div class="pi-l2d-switch-row" title="${this.t("music.voice_only_desc")}">
					<span>${this.t("settings.voice_only")}</span>
					<input type="checkbox" id="pi-l2d-cfg-voiceonly" ${this.config.voiceOnly !== false ? "checked" : ""} />
				</div>

				<div class="pi-l2d-slider-row" style="padding: 10px 12px; background: var(--bg-elev2, #1e222b); border-radius: 8px;">
					<span class="pi-l2d-slider-label">${this.t("settings.lipsync_sens")}</span>
					<input type="range" class="pi-l2d-slider-input" id="pi-l2d-cfg-lipsync-sens" min="0.5" max="2.5" step="0.1" value="${this.config.lipSyncSensitivity ?? 1.25}" />
					<span class="pi-l2d-slider-val" id="pi-l2d-val-lipsync-sens">${Math.round((this.config.lipSyncSensitivity ?? 1.25) * 100)}%</span>
				</div>
			</div>
			<div class="pi-l2d-modal-foot">
				<button class="pi-l2d-btn pi-l2d-btn-primary" id="pi-l2d-save-settings">${this.t("settings.save")}</button>
			</div>
		`;

		overlay.appendChild(card);
		document.body.appendChild(overlay);
		this.modalEl = overlay;

		const renderModelsList = () => {
			const listEl = card.querySelector("#pi-l2d-models-list");
			listEl.innerHTML = "";
			for (const m of this.models) {
				const isCur = m.key === this.activeModel.key;
				const isCustom = m.isUploaded || m.key.startsWith("upload_") || m.key.startsWith("custom_");
				const row = document.createElement("div");
				row.style.cssText =
					"display:flex; align-items:center; justify-content:space-between; padding:8px 12px; background:var(--bg-elev2,#1e222b); border-radius:6px;";
				row.innerHTML = `
					<div style="font-size:13px; font-weight:${isCur ? "600" : "400"}; color:${isCur ? "var(--accent,#3b82f6)" : "inherit"}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:260px;">${escapeHtml(m.name)}</div>
					<div style="display:flex; gap:6px; align-items:center;">
						${!isCur ? `<button class="pi-l2d-btn pi-l2d-btn-apply" data-key="${escapeHtml(m.key)}" style="padding:4px 8px; font-size:12px;">${this.t("settings.apply")}</button>` : '<span style="font-size:12px; color:var(--accent,#3b82f6);">✓</span>'}
						${isCustom ? `<button class="pi-l2d-btn-del" data-key="${escapeHtml(m.key)}" title="${this.t("settings.del")}">🗑️</button>` : ""}
					</div>
				`;
				row.querySelector(".pi-l2d-btn-apply")?.addEventListener("click", () => {
					this.switchModel(m.key);
					renderModelsList();
				});
				row.querySelector(".pi-l2d-btn-del")?.addEventListener("click", async () => {
					try {
						await fetch("/plugins-api/live2d/delete-model", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ key: m.key }),
						});
					} catch {}
					const idx = this.models.findIndex((x) => x.key === m.key);
					if (idx !== -1) this.models.splice(idx, 1);
					const customs = loadCustomModels().filter((x) => x.key !== m.key);
					saveCustomModels(customs);
					if (this.activeModel.key === m.key) {
						await this.switchModel("shizuku");
					}
					renderModelsList();
				});
				listEl.appendChild(row);
			}
		};
		renderModelsList();

		const statusEl = card.querySelector("#pi-l2d-upload-status");
		const fileZipInput = card.querySelector("#pi-l2d-file-zip");
		const fileFolderInput = card.querySelector("#pi-l2d-file-folder");
		const dropzoneEl = card.querySelector("#pi-l2d-dropzone");

		const handleZipFile = async (file) => {
			if (!file) return;
			statusEl.style.display = "flex";
			statusEl.className = "pi-l2d-upload-status loading";
			statusEl.textContent = `⏳ ${this.t("settings.uploading")}`;
			try {
				const modelName = encodeURIComponent(file.name.replace(/\.zip$/i, ""));
				const res = await fetch(`/plugins-api/live2d/upload-zip?name=${modelName}`, {
					method: "POST",
					headers: { "Content-Type": "application/octet-stream" },
					body: file,
				});
				const data = await res.json();
				if (!data.ok) throw new Error(data.error || "Upload failed");

				statusEl.className = "pi-l2d-upload-status";
				statusEl.style.color = "var(--green, #22c55e)";
				statusEl.textContent = `✓ ${this.t("settings.upload_success")}`;

				const newModel = data.model;
				const customs = loadCustomModels();
				customs.push(newModel);
				saveCustomModels(customs);
				this.models.push(newModel);
				await this.switchModel(newModel.key);
				renderModelsList();
			} catch (err) {
				statusEl.className = "pi-l2d-upload-status error";
				statusEl.textContent = `✗ ${this.t("settings.upload_failed")}${err.message}`;
			}
		};

		const handleFolderFiles = async (fileList) => {
			if (!fileList || fileList.length === 0) return;
			const files = Array.from(fileList);
			const modelKey = "upload_" + Date.now();
			const folderName = files[0].webkitRelativePath?.split("/")[0] || "CustomModel";

			statusEl.style.display = "flex";
			statusEl.className = "pi-l2d-upload-status loading";
			statusEl.textContent = `⏳ ${this.t("settings.uploading")} (0/${files.length})`;

			try {
				let uploaded = 0;
				for (const file of files) {
					const relPath = file.webkitRelativePath || file.name;
					await fetch(`/plugins-api/live2d/upload-file?key=${modelKey}&relPath=${encodeURIComponent(relPath)}`, {
						method: "POST",
						headers: { "Content-Type": "application/octet-stream" },
						body: file,
					});
					uploaded++;
					statusEl.textContent = `⏳ ${this.t("settings.uploading")} (${uploaded}/${files.length})`;
				}

				const res = await fetch("/plugins-api/live2d/finish-folder-upload", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ key: modelKey, name: folderName }),
				});
				const data = await res.json();
				if (!data.ok) throw new Error(data.error || "Failed to parse model");

				statusEl.className = "pi-l2d-upload-status";
				statusEl.style.color = "var(--green, #22c55e)";
				statusEl.textContent = `✓ ${this.t("settings.upload_success")}`;

				const newModel = data.model;
				const customs = loadCustomModels();
				customs.push(newModel);
				saveCustomModels(customs);
				this.models.push(newModel);
				await this.switchModel(newModel.key);
				renderModelsList();
			} catch (err) {
				statusEl.className = "pi-l2d-upload-status error";
				statusEl.textContent = `✗ ${this.t("settings.upload_failed")}${err.message}`;
			}
		};

		card.querySelector("#pi-l2d-btn-upload-zip").addEventListener("click", () => {
			fileZipInput.click();
		});
		fileZipInput.addEventListener("change", (e) => {
			const file = e.target.files?.[0];
			if (file) handleZipFile(file);
			fileZipInput.value = "";
		});

		card.querySelector("#pi-l2d-btn-upload-folder").addEventListener("click", () => {
			fileFolderInput.click();
		});
		fileFolderInput.addEventListener("change", (e) => {
			if (e.target.files) handleFolderFiles(e.target.files);
			fileFolderInput.value = "";
		});

		dropzoneEl.addEventListener("dragover", (e) => {
			e.preventDefault();
			dropzoneEl.classList.add("dragover");
		});
		dropzoneEl.addEventListener("dragleave", () => {
			dropzoneEl.classList.remove("dragover");
		});
		dropzoneEl.addEventListener("drop", (e) => {
			e.preventDefault();
			dropzoneEl.classList.remove("dragover");
			const file = e.dataTransfer?.files?.[0];
			if (file) {
				if (file.name.toLowerCase().endsWith(".zip")) {
					handleZipFile(file);
				} else if (e.dataTransfer.files.length > 1) {
					handleFolderFiles(e.dataTransfer.files);
				}
			}
		});

		const sensRange = card.querySelector("#pi-l2d-cfg-lipsync-sens");
		const sensVal = card.querySelector("#pi-l2d-val-lipsync-sens");
		sensRange?.addEventListener("input", (e) => {
			if (sensVal) sensVal.textContent = `${Math.round(parseFloat(e.target.value) * 100)}%`;
		});

		card.querySelector("#pi-l2d-btn-add").addEventListener("click", () => {
			const nameInput = card.querySelector("#pi-l2d-new-name");
			const urlInput = card.querySelector("#pi-l2d-new-url");
			const name = nameInput.value.trim();
			const url = urlInput.value.trim();
			if (!name || !url) return;

			const key = "custom_" + Date.now();
			const newModel = {
				key,
				name: `✨ ${name}`,
				url,
				type: url.endsWith(".model.json") ? "cubism2" : "cubism4",
				scale: 1.0,
			};
			const customs = loadCustomModels();
			customs.push(newModel);
			saveCustomModels(customs);
			this.models.push(newModel);

			nameInput.value = "";
			urlInput.value = "";
			renderModelsList();
		});

		const close = () => {
			const clickThroughChecked = card.querySelector("#pi-l2d-cfg-clickthrough").checked;
			if (clickThroughChecked !== Boolean(this.config.clickThrough)) {
				this.toggleClickThrough(clickThroughChecked);
			}
			this.config.reactToAgent = card.querySelector("#pi-l2d-cfg-react").checked;
			this.config.soundEnabled = card.querySelector("#pi-l2d-cfg-sound").checked;
			this.config.autoBlink = card.querySelector("#pi-l2d-cfg-autoblink").checked;
			this.config.voiceOnly = card.querySelector("#pi-l2d-cfg-voiceonly").checked;
			this.config.lipSyncSensitivity = parseFloat(card.querySelector("#pi-l2d-cfg-lipsync-sens").value);
			this.stage?.setAutoBlink(this.config.autoBlink);
			this.stage?.setVoiceOnly(this.config.voiceOnly);
			this.stage?.setLipSyncSensitivity(this.config.lipSyncSensitivity);
			this._saveConfig();
			overlay.remove();
			this.modalEl = null;
		};

		card.querySelector("#pi-l2d-close-settings").addEventListener("click", close);
		card.querySelector("#pi-l2d-save-settings").addEventListener("click", close);
		overlay.addEventListener("click", (e) => {
			if (e.target === overlay) close();
		});
	}

	onAgentThinking() {
		if (!this.config.reactToAgent || !this.visible) return;
		this.stage?.playExpression("f00") || this.stage?.playExpression("neutral");
		this.showBubble(this.t("bubble.thinking"), 4000);
	}

	onAgentDone() {
		if (!this.config.reactToAgent || !this.visible) return;
		this.stage?.playExpression("happy") || this.stage?.playExpression("f01");
		this.stage?.playMotion("tap_body") || this.stage?.playMotion("Tap");
		this.showBubble(this.t("bubble.done"), 3500);
	}

	onAgentError() {
		if (!this.config.reactToAgent || !this.visible) return;
		this.stage?.playExpression("sad") || this.stage?.playExpression("f03");
		this.showBubble(this.t("bubble.error"), 4000);
	}

	destroy() {
		if (this._hideTimer) {
			clearTimeout(this._hideTimer);
			this._hideTimer = null;
		}
		this._abortDragging();
		this.hideBubble();
		this._closeContextMenu();
		this.closeMusicPanel();
		document.getElementById("pi-l2d-minimized-pill")?.remove();
		if (this.musicBadgeEl) {
			this.musicBadgeEl.remove();
			this.musicBadgeEl = null;
		}
		if (this.modalEl) {
			this.modalEl.remove();
			this.modalEl = null;
		}
		if (this.container) this.container.remove();
		if (this.stage) this.stage.destroy();
	}
}
