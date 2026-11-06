import { EMOTION_ALIAS_MAP } from "./models.mjs";
import { AudioLipSyncEngine } from "./audio-lipsync.mjs";
import { EyeBlinkEngine } from "./eye-blink.mjs";

function loadScript(src) {
	return new Promise((resolve, reject) => {
		const existing = document.querySelector(`script[src="${src}"]`);
		if (existing) {
			if (existing.dataset.loaded === "true") return resolve();
			existing.addEventListener("load", () => resolve());
			existing.addEventListener("error", (e) => reject(e));
			return;
		}
		const s = document.createElement("script");
		s.src = src;
		s.async = false;
		s.onload = () => {
			s.dataset.loaded = "true";
			resolve();
		};
		s.onerror = (err) => reject(err);
		document.head.appendChild(s);
	});
}

let engineReadyPromise = null;

export function ensureLive2dEngine(clientBase) {
	if (engineReadyPromise) return engineReadyPromise;

	engineReadyPromise = (async () => {
		try {
			if (!window.Live2DCubismCore) {
				await loadScript(`${clientBase}/vendor/live2dcubismcore.min.js`);
			}
			if (!window.Live2D) {
				await loadScript(`${clientBase}/vendor/live2d.min.js`);
			}
			if (!window.PIXI) {
				await loadScript(`${clientBase}/vendor/pixi.min.js`);
			}
			if (!window.PIXI?.live2d?.Live2DModel) {
				await loadScript(`${clientBase}/vendor/pixi-live2d-display.min.js`);
			}
		} catch (localErr) {
			console.warn("[live2d] 本地 vendor 加载失败，回退 CDN：", localErr);
			if (!window.Live2DCubismCore) {
				await loadScript("https://cdn.jsdelivr.net/gh/dylanNew/live2d/webgl/Live2D/lib/live2dcubismcore.min.js");
			}
			if (!window.Live2D) {
				await loadScript("https://cdn.jsdelivr.net/gh/dylanNew/live2d/webgl/Live2D/lib/live2d.min.js");
			}
			if (!window.PIXI) {
				await loadScript("https://cdn.jsdelivr.net/npm/pixi.js@6.5.8/dist/browser/pixi.min.js");
			}
			if (!window.PIXI?.live2d?.Live2DModel) {
				await loadScript("https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/index.min.js");
			}
		}

		if (!window.PIXI || !window.PIXI.live2d?.Live2DModel) {
			throw new Error("Live2D 渲染引擎未能成功加载");
		}
		return window.PIXI;
	})();

	return engineReadyPromise;
}

export class Live2DStage {
	constructor(canvas, options = {}) {
		this.canvas = canvas;
		this.options = options;
		this.app = null;
		this.model = null;
		this.currentModelKey = "";
		this.mode = options.mode || "mouse";
		this.disposed = false;
		this.expressions = [];
		this.motions = [];
		this._onMouseMove = this._handleMouseMove.bind(this);

		this.audioSync = new AudioLipSyncEngine({
			sensitivity: options.lipSyncSensitivity ?? 1.25,
			voiceOnly: options.voiceOnly !== false,
			onBeat: () => {
				this.eyeBlink?.onMusicBeat();
			},
		});
		this.eyeBlink = new EyeBlinkEngine({
			enabled: options.autoBlink !== false,
		});
		this._onBeforeModelUpdate = null;
		this._lastMouthOpen = 0.0;
		this._lastTickerTime = performance.now();
		this._beatGroove = 0.0;
	}

	async init() {
		const PIXI = window.PIXI;
		const width = this.canvas.width || 280;
		const height = this.canvas.height || 340;

		this.app = new PIXI.Application({
			view: this.canvas,
			transparent: true,
			backgroundAlpha: 0,
			preserveDrawingBuffer: true,
			width,
			height,
			autoDensity: true,
			antialias: true,
			resolution: window.devicePixelRatio || 1,
		});

		window.addEventListener("mousemove", this._onMouseMove, { passive: true });
	}

	/**
	 * 智能检测指定视口像素坐标是否为完全透明
	 * @param {number} clientX
	 * @param {number} clientY
	 * @returns {boolean} true 为透明（应点击穿透），false 为非透明角色身体（应响应交互）
	 */
	isPixelTransparent(clientX, clientY) {
		if (!this.app || !this.canvas || !this.model || this.disposed) return true;
		const rect = this.canvas.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return true;
		if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
			return true;
		}

		try {
			const gl = this.app.renderer?.gl;
			if (!gl) return false;

			const scaleX = this.canvas.width / rect.width;
			const scaleY = this.canvas.height / rect.height;
			const x = Math.floor((clientX - rect.left) * scaleX);
			const y = Math.floor((clientY - rect.top) * scaleY);
			const glY = this.canvas.height - y - 1;

			if (x >= 0 && x < this.canvas.width && glY >= 0 && glY < this.canvas.height) {
				const pixel = new Uint8Array(4);
				gl.readPixels(x, glY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
				return pixel[3] < 16;
			}
		} catch {
			return false;
		}
		return true;
	}

	async loadModel(modelConfig) {
		if (this.disposed || !this.app) return;
		const PIXI = window.PIXI;

		this.currentModelKey = modelConfig.key || "";

		const Live2DModel = PIXI.live2d.Live2DModel;
		const newModel = await Live2DModel.from(modelConfig.url, {
			autoInteract: false,
		});

		if (this.disposed) {
			newModel.destroy();
			return;
		}

		if (this.model) {
			try {
				this.app.stage.removeChild(this.model);
				this.model.destroy();
			} catch {}
			this.model = null;
		}

		this.model = newModel;
		this.app.stage.addChild(newModel);

		newModel.anchor.set(0.5, 0.5);
		const canvasW = this.canvas.width;
		const canvasH = this.canvas.height;
		newModel.x = canvasW / 2;
		newModel.y = canvasH / 2 + (modelConfig.offsetY || 0);

		const fitScale = Math.min(canvasW / newModel.width, canvasH / newModel.height) * 0.95 * (modelConfig.scale || 1.0);
		newModel.scale.set(fitScale, fitScale);
		this.baseScale = fitScale;

		this.expressions = this._extractExpressions(newModel, modelConfig);
		this.motions = this._extractMotions(newModel, modelConfig);

		this._hookModelLipSyncAndBlink(newModel);

		this.setMode(this.mode);
	}

	_hookModelLipSyncAndBlink(model) {
		const internal = model?.internalModel;
		if (!internal) return;

		if (this._onBeforeModelUpdate) {
			internal.off?.("beforeModelUpdate", this._onBeforeModelUpdate);
		}

		this._onBeforeModelUpdate = () => {
			if (this.disposed || !this.model) return;
			const core = this.model.internalModel?.coreModel;
			if (!core) return;

			const now = performance.now();
			const deltaMs = Math.max(1, Math.min(100, now - this._lastTickerTime));
			this._lastTickerTime = now;

			if (this.eyeBlink) {
				const blink = this.eyeBlink.update(deltaMs);
				this._applyBlink(core, blink);
			}

			if (this.audioSync) {
				const mouthOpen = this.audioSync.update();
				if (mouthOpen > 0.001 || this._lastMouthOpen > 0.001) {
					this._applyMouth(core, mouthOpen);
					this._lastMouthOpen = mouthOpen;
				}

				if (this.audioSync.isPlaying()) {
					if (this.audioSync.isBeat) {
						this._beatGroove = 1.0;
					}
					if (this._beatGroove > 0.01) {
						this._applyBeatGroove(core, this._beatGroove);
						this._beatGroove *= 0.88;
					}
				}
			}
		};

		internal.on("beforeModelUpdate", this._onBeforeModelUpdate);
	}

	_applyBlink(core, blink) {
		if (typeof core.setParameterValueById === "function") {
			try {
				let curL = core.getParameterValueById("ParamEyeLOpen");
				let curR = core.getParameterValueById("ParamEyeROpen");
				if (curL === undefined || isNaN(curL)) curL = 1.0;
				if (curR === undefined || isNaN(curR)) curR = 1.0;

				core.setParameterValueById("ParamEyeLOpen", curL * blink.left);
				core.setParameterValueById("ParamEyeROpen", curR * blink.right);

				const blinkIds = this.model?.internalModel?.eyeBlinkIds;
				if (Array.isArray(blinkIds)) {
					for (const id of blinkIds) {
						if (id !== "ParamEyeLOpen" && id !== "ParamEyeROpen") {
							const v = core.getParameterValueById(id);
							core.setParameterValueById(id, (isNaN(v) ? 1.0 : v) * blink.left);
						}
					}
				}
			} catch {}
			return;
		}

		if (typeof core.setParamFloat === "function") {
			try {
				let curL = typeof core.getParamFloat === "function" ? core.getParamFloat("PARAM_EYE_L_OPEN") : 1.0;
				let curR = typeof core.getParamFloat === "function" ? core.getParamFloat("PARAM_EYE_R_OPEN") : 1.0;
				if (curL === undefined || isNaN(curL)) curL = 1.0;
				if (curR === undefined || isNaN(curR)) curR = 1.0;
				core.setParamFloat("PARAM_EYE_L_OPEN", curL * blink.left);
				core.setParamFloat("PARAM_EYE_R_OPEN", curR * blink.right);
			} catch {}
		}
	}

	_applyMouth(core, mouthOpen) {
		const v = Math.max(0.0, Math.min(1.0, mouthOpen * 1.25 + (mouthOpen > 0.03 ? 0.03 : 0)));
		if (typeof core.setParameterValueById === "function") {
			try {
				core.setParameterValueById("ParamMouthOpenY", v);
				core.setParameterValueById("PARAM_MOUTH_OPEN_Y", v);

				const lipSyncIds = this.model?.internalModel?.lipSyncIds;
				if (Array.isArray(lipSyncIds)) {
					for (const id of lipSyncIds) {
						core.setParameterValueById(id, v);
					}
				}
			} catch {}
			return;
		}

		if (typeof core.setParamFloat === "function") {
			try {
				core.setParamFloat("PARAM_MOUTH_OPEN_Y", v);
			} catch {}
			try {
				core.setParamFloat("ParamMouthOpenY", v);
			} catch {}
		}
	}

	_applyBeatGroove(core, groove) {
		const swayZ = Math.sin(performance.now() / 160) * groove * 1.5;
		const swayX = Math.cos(performance.now() / 200) * groove * 0.8;
		if (typeof core.addParameterValueById === "function") {
			try {
				core.addParameterValueById("ParamAngleZ", swayZ);
				core.addParameterValueById("ParamBodyAngleX", swayX);
			} catch {}
			return;
		}
		if (typeof core.addToParamFloat === "function") {
			try {
				core.addToParamFloat("PARAM_ANGLE_Z", swayZ);
			} catch {}
		}
	}

	triggerBlink() {
		this.eyeBlink?.triggerBlink();
	}

	triggerWink(side = "right") {
		this.eyeBlink?.triggerWink(side);
	}

	setAutoBlink(enabled) {
		this.eyeBlink?.setEnabled(enabled);
	}

	setLipSyncSensitivity(sens) {
		this.audioSync?.setSensitivity(sens);
	}

	setVoiceOnly(enabled) {
		this.audioSync?.setVoiceOnly(enabled);
	}

	_extractExpressions(model, modelConfig) {
		const set = new Set(modelConfig.expressions || []);
		try {
			const expManager = model.internalModel?.motionManager?.expressionManager;
			if (expManager?.definitions) {
				for (const def of expManager.definitions) {
					if (def.name) set.add(def.name);
				}
			}
		} catch {}
		return Array.from(set);
	}

	_extractMotions(model, modelConfig) {
		const list = [...(modelConfig.motions || [])];
		try {
			const motions = model.internalModel?.motionManager?.definitions;
			if (motions) {
				for (const group of Object.keys(motions)) {
					if (!list.includes(group)) list.push(group);
				}
			}
		} catch {}
		return list;
	}

	setMode(mode) {
		this.mode = mode;
		if (!this.model) return;
		if (mode === "idle") {
			this.model.focus(this.canvas.width / 2, this.canvas.height / 2);
		}
	}

	_handleMouseMove(e) {
		if (this.disposed || !this.model) return;
		if (this.app?.ticker && !this.app.ticker.started) return;

		const rect = this.canvas.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;

		if (this.mode === "mouse") {
			const x = e.clientX - rect.left;
			const y = e.clientY - rect.top;
			this.model.focus(x, y);
		}

		if (typeof this.onHoverPixel === "function") {
			const inside =
				e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
			if (inside) {
				this.onHoverPixel(this.isPixelTransparent(e.clientX, e.clientY));
			} else {
				this.onHoverPixel(null);
			}
		}
	}

	stop() {
		try {
			if (this.app?.ticker?.started) {
				this.app.ticker.stop();
			}
		} catch {}
	}

	start() {
		try {
			if (this.app?.ticker && !this.app.ticker.started) {
				this.app.ticker.start();
			}
		} catch {}
	}

	playExpression(nameOrAlias) {
		if (!this.model) return false;
		let targetExp = nameOrAlias;

		const lower = String(nameOrAlias).toLowerCase();
		if (EMOTION_ALIAS_MAP[lower]) {
			const candidates = EMOTION_ALIAS_MAP[lower];
			for (const c of candidates) {
				const found = this.expressions.find((e) => e.toLowerCase() === c.toLowerCase());
				if (found) {
					targetExp = found;
					break;
				}
			}
		} else {
			const found = this.expressions.find((e) => e.toLowerCase() === lower);
			if (found) targetExp = found;
		}

		try {
			this.model.expression(targetExp);
			return true;
		} catch (err) {
			console.warn("[live2d] 播放表情失败:", targetExp, err);
			return false;
		}
	}

	playMotion(group, index = 0) {
		if (!this.model) return false;
		let targetGroup = group;
		if (this.motions && this.motions.length > 0) {
			const lower = String(group).toLowerCase();
			const found = this.motions.find((m) => m.toLowerCase() === lower);
			if (found) targetGroup = found;
		}
		try {
			this.model.motion(targetGroup, index);
			return true;
		} catch (err) {
			console.warn("[live2d] 播放动作失败:", targetGroup, err);
			return false;
		}
	}

	hitTest(clientX, clientY) {
		if (!this.model) return null;
		const rect = this.canvas.getBoundingClientRect();
		const x = clientX - rect.left;
		const y = clientY - rect.top;

		try {
			const hitAreas = this.model.hitTest(x, y);
			if (hitAreas && hitAreas.length > 0) {
				const area = String(hitAreas[0]).toLowerCase();
				if (area.includes("head")) return "head";
				if (area.includes("body")) return "body";
				if (area.includes("mouth")) return "mouth";
				return hitAreas[0];
			}
		} catch {}

		const relY = y / rect.height;
		return relY < 0.35 ? "head" : "body";
	}

	resize(width, height) {
		if (!this.app) return;
		this.canvas.width = width;
		this.canvas.height = height;
		this.app.renderer.resize(width, height);
		if (this.model) {
			this.model.x = width / 2;
			this.model.y = height / 2;
		}
	}

	destroy() {
		this.disposed = true;
		window.removeEventListener("mousemove", this._onMouseMove);
		if (this.audioSync) {
			try {
				this.audioSync.destroy();
			} catch {}
			this.audioSync = null;
		}
		if (this.model) {
			try {
				this.model.destroy();
			} catch {}
			this.model = null;
		}
		if (this.app) {
			try {
				this.app.destroy(true, { children: true, texture: true, baseTexture: true });
			} catch {}
			this.app = null;
		}
	}
}
