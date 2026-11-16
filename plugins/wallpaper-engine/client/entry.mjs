import { DRAWER_CSS, getGlassThemeCss } from "./styles.mjs?v=0.3.65";
import { esc as escapeHtml } from "@pi-web-ui/plugin-sdk/client";
import { makeT } from "./i18n.mjs";

/** 抽屉与检查器文案：语言解析 / 回退 / 插值都在 SDK 里，这里只按当前界面语言取词。 */
const t = makeT();

const RUNTIME_KEY = "__piWallpaperEngineRuntime";

function getApiBase(importMetaUrl = import.meta.url) {
	try {
		const u = new URL(importMetaUrl);
		const m = u.pathname.match(/^(.*?)\/plugins\/wallpaper-engine\b/);
		const root = m ? m[1] : "";
		return `${root}/plugins-api/wallpaper-engine`;
	} catch {
		return "/plugins-api/wallpaper-engine";
	}
}

function getClientBase(importMetaUrl = import.meta.url) {
	try {
		const u = new URL(importMetaUrl);
		const m = u.pathname.match(/^(.*?)\/plugins\/wallpaper-engine\b/);
		const root = m ? m[1] : "";
		return `${root}/plugins/wallpaper-engine/client`;
	} catch {
		return "/plugins/wallpaper-engine/client";
	}
}

const API_BASE = getApiBase();
const CLIENT_BASE = getClientBase();

const prev = globalThis[RUNTIME_KEY];
if (prev?.destroy) {
	try {
		prev.destroy();
	} catch (err) {
		// developer-facing, not UI: browser console only
		console.warn("[wallpaper-engine] 清理上一轮实例失败：", err);
	}
}

function ensureStyles() {
	let s = document.getElementById("pi-we-drawer-styles");
	if (!s) {
		s = document.createElement("style");
		s.id = "pi-we-drawer-styles";
		document.head.appendChild(s);
	}
	s.textContent = DRAWER_CSS;
}
ensureStyles();

function updateGlassStyle(
	blur,
	opacity,
	enabled = true,
	interactive = false,
	themeKey = "obsidian",
	lightWallpaperMode = false,
) {
	let s = document.getElementById("pi-we-glass-theme");
	if (!enabled) {
		s?.remove();
		return;
	}
	if (!s) {
		s = document.createElement("style");
		s.id = "pi-we-glass-theme";
		document.head.appendChild(s);
	}
	s.textContent = getGlassThemeCss(blur, opacity, interactive, themeKey, lightWallpaperMode);
}

let webwallglModule = null;

function loadScript(src) {
	return new Promise((resolve, reject) => {
		const s = document.createElement("script");
		s.src = src;
		s.async = true;
		s.onload = () => resolve();
		s.onerror = (err) => reject(err);
		document.head.appendChild(s);
	});
}

async function loadWebWallGL() {
	if (webwallglModule) return webwallglModule;
	if (globalThis.WebWallGL && typeof globalThis.WebWallGL.mount === "function") {
		webwallglModule = globalThis.WebWallGL;
		return webwallglModule;
	}

	try {
		await loadScript(`${CLIENT_BASE}/vendor/webwallgl.js`);
		if (globalThis.WebWallGL && typeof globalThis.WebWallGL.mount === "function") {
			webwallglModule = globalThis.WebWallGL;
			return webwallglModule;
		}
	} catch {}

	try {
		const mod = await import("https://esm.sh/webwallgl@3.0.0?bundle");
		if (mod && (typeof mod.mount === "function" || mod.default?.mount)) {
			webwallglModule = typeof mod.mount === "function" ? mod : mod.default;
			return webwallglModule;
		}
	} catch {}

	try {
		await loadScript("https://unpkg.com/webwallgl@3.0.0");
		if (globalThis.WebWallGL && typeof globalThis.WebWallGL.mount === "function") {
			webwallglModule = globalThis.WebWallGL;
			return webwallglModule;
		}
	} catch (err) {
		// developer-facing, not UI: browser console only
		console.warn("[wallpaper-engine] WebWallGL 模块加载失败，将自动降级为静态预览：", err);
	}

	return null;
}

function createAudioReactiveEngine(getBgLayer) {
	let active = false;
	let rafId = null;
	const spectrum = new Float32Array(64);
	const spectrumArray = new Array(64);

	function start() {
		if (active) return;
		active = true;
		tick();
	}

	function stop() {
		active = false;
		if (rafId) {
			cancelAnimationFrame(rafId);
			rafId = null;
		}
	}

	function tick() {
		if (!active) return;
		const time = Date.now() * 0.003;
		for (let i = 0; i < 64; i++) {
			const wave1 = Math.sin(time + i * 0.25) * 0.5 + 0.5;
			const wave2 = Math.cos(time * 0.7 - i * 0.15) * 0.5 + 0.5;
			const val = Math.min(1.0, Math.max(0.0, wave1 * 0.6 + wave2 * 0.4));
			spectrum[i] = val;
			spectrumArray[i] = val;
		}

		if (typeof window.__weAudioCb === "function") {
			try {
				window.__weAudioCb(spectrumArray);
			} catch {}
		}

		try {
			const layer = typeof getBgLayer === "function" ? getBgLayer() : null;
			layer?.dispatchAudio?.(spectrumArray);
		} catch {}

		rafId = requestAnimationFrame(tick);
	}

	return { start, stop };
}

const THEME_MAP = {
	obsidian: "wallpaper-obsidian",
};
const ALL_WE_THEMES = new Set([
	"wallpaper-obsidian",
	"wallpaper-engine",
	"wallpaper-synthwave",
	"wallpaper-aurora",
	"wallpaper-amber",
]);
const PREV_THEME_KEY = "pi-we-prev-theme";
let themeLockActive = false;

function getActiveThemeKey() {
	return "obsidian";
}

function getActiveThemeId() {
	return "wallpaper-obsidian";
}

function activateThemeLock() {
	themeLockActive = true;
	try {
		const curTheme = localStorage.getItem("pi-web-ui:theme");
		if (!ALL_WE_THEMES.has(curTheme) && sessionStorage.getItem(PREV_THEME_KEY) === null) {
			sessionStorage.setItem(PREV_THEME_KEY, curTheme || "dark");
		}
		const targetTheme = getActiveThemeId();
		if (curTheme !== targetTheme) {
			localStorage.setItem("pi-web-ui:theme", targetTheme);
			let link = document.getElementById("theme-stylesheet");
			if (!link) {
				link = document.createElement("link");
				link.id = "theme-stylesheet";
				link.rel = "stylesheet";
				document.head.appendChild(link);
			}
			const hostBase = API_BASE.replace(/\/plugins-api\/wallpaper-engine$/, "");
			link.href = `${hostBase}/themes/${encodeURIComponent(targetTheme)}.css?v=0.3.45`;
			window.dispatchEvent(new CustomEvent("pi-web-ui:theme-change"));
		}
	} catch {}
}

function deactivateThemeLock() {
	themeLockActive = false;
	try {
		const prevTheme = sessionStorage.getItem(PREV_THEME_KEY);
		sessionStorage.removeItem(PREV_THEME_KEY);
		if (prevTheme) {
			if (prevTheme === "dark" || prevTheme === "null" || !prevTheme) {
				localStorage.removeItem("pi-web-ui:theme");
				document.getElementById("theme-stylesheet")?.remove();
			} else {
				localStorage.setItem("pi-web-ui:theme", prevTheme);
				let link = document.getElementById("theme-stylesheet");
				if (!link) {
					link = document.createElement("link");
					link.id = "theme-stylesheet";
					link.rel = "stylesheet";
					document.head.appendChild(link);
				}
				const hostBase = API_BASE.replace(/\/plugins-api\/wallpaper-engine$/, "");
				link.href = `${hostBase}/themes/${encodeURIComponent(prevTheme)}.css`;
			}
			window.dispatchEvent(new CustomEvent("pi-web-ui:theme-change"));
		}
	} catch {}
}

function enforceThemeLock() {
	if (!themeLockActive) return;
	try {
		const targetTheme = getActiveThemeId();
		const curTheme = localStorage.getItem("pi-web-ui:theme");
		if (curTheme !== targetTheme) {
			localStorage.setItem("pi-web-ui:theme", targetTheme);
			let link = document.getElementById("theme-stylesheet");
			if (!link) {
				link = document.createElement("link");
				link.id = "theme-stylesheet";
				link.rel = "stylesheet";
				document.head.appendChild(link);
			}
			const hostBase = API_BASE.replace(/\/plugins-api\/wallpaper-engine$/, "");
			link.href = `${hostBase}/themes/${encodeURIComponent(targetTheme)}.css?v=0.3.45`;
			window.dispatchEvent(new CustomEvent("pi-web-ui:theme-change"));
		}
	} catch {}
}

window.addEventListener("pi-web-ui:theme-change", enforceThemeLock);
window.addEventListener("storage", (e) => {
	if (e.key === "pi-web-ui:theme") enforceThemeLock();
});

// developer-facing, not UI: profile labels are internal identifiers and never rendered
const QUALITY_PROFILES = {
	performance: {
		label: "节能极速",
		dprCap: 1.0,
		particles: "low",
		postProcessing: "low",
		videoTexScale: 1.0,
		defaultAa: "off",
	},
	balanced: {
		label: "平衡流畅",
		dprCap: 1.5,
		particles: "medium",
		postProcessing: "medium",
		videoTexScale: 1.0,
		defaultAa: "fxaa",
	},
	high: {
		label: "高清细腻",
		dprCap: 2.0,
		particles: "high",
		postProcessing: "high",
		videoTexScale: 1.0,
		defaultAa: "fxaa",
	},
	ultra: {
		label: "极致视网膜",
		dprCap: 2.5,
		particles: "high",
		postProcessing: "high",
		videoTexScale: 1.0,
		defaultAa: "msaa4",
	},
};

function getEffectiveQuality(settings = {}) {
	const presetKey = settings.qualityPreset in QUALITY_PROFILES ? settings.qualityPreset : "performance";
	const profile = QUALITY_PROFILES[presetKey];
	const aaMode = settings.antiAliasing || profile.defaultAa;
	const dpr = Math.min(profile.dprCap, Math.max(1.0, window.devicePixelRatio || 1));
	return {
		presetKey,
		profile,
		dpr,
		aaMode,
		particles: profile.particles,
		postProcessing: profile.postProcessing,
		videoTexScale: profile.videoTexScale,
	};
}

function createBackgroundLayer() {
	let container = document.getElementById("pi-we-bg-container");
	if (!container) {
		container = document.createElement("div");
		container.id = "pi-we-bg-container";
		document.body.prepend(container);
	}

	let currentMediaEl = null;
	let currentSceneInstance = null;
	let currentSceneResizeHandler = null;
	let currentPosterEl = null;
	let currentItem = null;
	let currentLoadEpoch = 0;

	function safeDestroyMedia(el, sceneInst, resizeHandler) {
		if (resizeHandler) {
			window.removeEventListener("resize", resizeHandler);
		}
		if (sceneInst) {
			try {
				sceneInst.destroy?.();
			} catch {}
		}
		if (el instanceof HTMLVideoElement) {
			try {
				el.pause();
				el.removeAttribute("src");
				el.load();
			} catch {}
		}
		try {
			el?.remove();
		} catch {}
	}

	function cleanupAll() {
		currentLoadEpoch++;
		safeDestroyMedia(currentMediaEl, currentSceneInstance, currentSceneResizeHandler);
		currentMediaEl = null;
		currentSceneInstance = null;
		currentSceneResizeHandler = null;
		if (currentPosterEl) {
			try {
				currentPosterEl.remove();
			} catch {}
			currentPosterEl = null;
		}
		container.innerHTML = "";
	}

	async function setWallpaper(item, settings) {
		const epoch = ++currentLoadEpoch;
		currentItem = item;

		if (!item) {
			cleanupAll();
			container.classList.remove("interactive");
			updateGlassStyle(0, 100, false);
			deactivateThemeLock();
			return;
		}

		activateThemeLock();

		if (settings.interactive) {
			container.classList.add("interactive");
		} else {
			container.classList.remove("interactive");
		}
		updateGlassStyle(
			settings.glassBlur,
			settings.glassOpacity,
			true,
			settings.interactive,
			settings.wallpaperTheme,
			settings.lightWallpaperMode,
		);

		const isColdStart = !currentMediaEl;
		let coldPoster = null;
		if (isColdStart) {
			coldPoster = document.createElement("img");
			coldPoster.className = "pi-we-poster";
			coldPoster.src = `${API_BASE}/api/preview?id=${encodeURIComponent(item.id)}`;
			container.appendChild(coldPoster);
		}

		const oldMediaEl = currentMediaEl;
		const oldSceneInst = currentSceneInstance;
		const oldResizeHandler = currentSceneResizeHandler;

		function markReady(newMediaEl, newSceneInst, newResizeHandler) {
			if (epoch !== currentLoadEpoch) {
				safeDestroyMedia(newMediaEl, newSceneInst, newResizeHandler);
				coldPoster?.remove();
				return false;
			}
			newMediaEl.classList.add("pi-we-ready");
			currentMediaEl = newMediaEl;
			currentSceneInstance = newSceneInst || null;
			currentSceneResizeHandler = newResizeHandler || null;

			if (oldMediaEl && oldMediaEl !== newMediaEl) {
				setTimeout(() => {
					safeDestroyMedia(oldMediaEl, oldSceneInst, oldResizeHandler);
				}, 350);
			}
			if (coldPoster) {
				setTimeout(() => {
					try {
						coldPoster.remove();
					} catch {}
				}, 350);
			}
			return true;
		}

		if (item.type === "video" || item.hasVideo) {
			const video = document.createElement("video");
			video.className = "pi-we-bg-media";
			video.src = `${API_BASE}/api/media?id=${encodeURIComponent(item.id)}`;
			video.autoplay = true;
			video.loop = true;
			video.muted = Boolean(settings.muteAudio);
			video.volume = settings.muteAudio ? 0 : 1;
			video.playsInline = true;
			video.disablePictureInPicture = true;
			video.preload = "auto";
			video.setAttribute("playsinline", "true");
			video.setAttribute("webkit-playsinline", "true");

			let activated = false;
			const activateVideo = () => {
				if (activated) return;
				activated = true;
				markReady(video);
			};
			video.oncanplay = activateVideo;
			video.onplaying = activateVideo;

			container.appendChild(video);
			video.play().catch(() => {
				video.muted = true;
				void video.play();
			});
			setTimeout(() => {
				if (epoch === currentLoadEpoch && !activated) activateVideo();
			}, 400);
			return;
		}

		if (item.type === "scene" || item.hasScene) {
			const mountEl = document.createElement("div");
			mountEl.className = "pi-we-scene-mount";
			container.appendChild(mountEl);

			try {
				const pkgUrl = `${API_BASE}/api/pkg?id=${encodeURIComponent(item.id)}`;
				const shouldTryPkg = Boolean(item.hasPkg) || (!item.isLooseScene && item.hasPkg !== false);

				const [engine, projectRes, pkgRes] = await Promise.all([
					loadWebWallGL(),
					fetch(`${API_BASE}/api/project?id=${encodeURIComponent(item.id)}`).catch(() => null),
					shouldTryPkg ? fetch(pkgUrl).catch(() => null) : Promise.resolve(null),
				]);

				if (epoch !== currentLoadEpoch) {
					mountEl.remove();
					coldPoster?.remove();
					return;
				}
				// developer-facing, not UI: thrown inside the guarded scene loader, never rendered
				if (!engine) throw new Error("WebWallGL 引擎未就绪");

				const projectJson = projectRes && projectRes.ok ? await projectRes.json().catch(() => null) : null;
				let source = null;

				if (pkgRes && pkgRes.ok) {
					try {
						const pkgBuffer = await pkgRes.arrayBuffer();
						if (epoch === currentLoadEpoch) {
							source = engine.bytesSource(pkgBuffer, projectJson, item.id);
						}
					} catch {
						source = null;
					}
				}

				if (!source && epoch === currentLoadEpoch) {
					const entryFile = (projectJson?.file || item.file || "scene.json").replace(/\\/g, "/");
					let totalBytes = 0;
					const fileCache = new Map();
					source = {
						key: item.id,
						async scenePkg() {
							return null;
						},
						async sceneDir(signal) {
							const read = async (relPath, sig) => {
								if (!relPath) return null;
								const safeRel = String(relPath).replace(/\\/g, "/").replace(/^\/+/, "");
								if (fileCache.has(safeRel)) return fileCache.get(safeRel);
								try {
									const res = await fetch(
										`${API_BASE}/api/scene-file?id=${encodeURIComponent(item.id)}&file=${encodeURIComponent(safeRel)}`,
										{ signal: sig || signal },
									);
									if (!res.ok) return null;
									const buf = new Uint8Array(await res.arrayBuffer());
									fileCache.set(safeRel, buf);
									totalBytes += buf.byteLength;
									return buf;
								} catch (err) {
									if (sig?.aborted || signal?.aborted) throw err;
									return null;
								}
							};
							const entryBuf = await read(entryFile, signal);
							return {
								entry: entryBuf ? entryFile : "scene.json",
								read,
								bytes: () => totalBytes,
							};
						},
						async project() {
							return projectJson;
						},
					};
				}

				if (epoch !== currentLoadEpoch || !source) {
					mountEl.remove();
					return;
				}

				const q = getEffectiveQuality(settings);
				const effectiveVolume = settings.muteAudio ? 0 : 1;
				const sceneInstance = await engine.mount(mountEl, {
					source,
					fit: "cover",
					renderDpr: q.dpr,
					fpsLimit: Number(settings.fpsLimit || 60),
					volume: effectiveVolume,
					quality: {
						antiAliasing: q.aaMode,
						particles: q.particles,
						postProcessing: q.postProcessing,
					},
					videoTexScale: q.videoTexScale,
				});

				if (epoch !== currentLoadEpoch) {
					sceneInstance?.destroy?.();
					mountEl.remove();
					return;
				}

				const resizeHandler = () => {
					if (sceneInstance && typeof sceneInstance.setRenderDpr === "function") {
						const curQ = getEffectiveQuality(settings);
						sceneInstance.setRenderDpr(curQ.dpr);
					}
				};
				window.addEventListener("resize", resizeHandler, { passive: true });

				markReady(mountEl, sceneInstance, resizeHandler);
				return;
			} catch (err) {
				// developer-facing, not UI: browser console only
				console.warn("[wallpaper-engine] Scene 壁纸渲染失败，平滑保持海报预览：", err);
				mountEl.remove();
				return;
			}
		}

		if (item.type === "web" || item.hasWeb) {
			const iframe = document.createElement("iframe");
			iframe.className = "pi-we-bg-media";
			const webFile = item.webFile || "index.html";
			iframe.src = `${API_BASE}/api/web?id=${encodeURIComponent(item.id)}&file=${encodeURIComponent(webFile)}`;
			iframe.sandbox = "allow-scripts allow-forms allow-popups allow-modals";
			iframe.setAttribute("allow", "autoplay; audio *");

			let activated = false;
			const activateWeb = () => {
				if (activated) return;
				activated = true;
				const vol = settings.muteAudio ? 0 : 1;
				try {
					iframe.contentWindow?.postMessage({ __we: 1, op: "setVolume", v: vol }, "*");
				} catch {}
				markReady(iframe);
			};

			iframe.onload = () => {
				setTimeout(() => {
					if (epoch === currentLoadEpoch) activateWeb();
				}, 60);
			};

			container.appendChild(iframe);
			setTimeout(() => {
				if (epoch === currentLoadEpoch && !activated) activateWeb();
			}, 500);
			return;
		}

		const img = document.createElement("img");
		img.className = "pi-we-bg-media";
		const mediaSrc = item.hasImage
			? `${API_BASE}/api/media?id=${encodeURIComponent(item.id)}`
			: `${API_BASE}/api/preview?id=${encodeURIComponent(item.id)}`;
		img.src = mediaSrc;
		img.onload = () => {
			markReady(img);
		};
		container.appendChild(img);
		if (img.complete) {
			markReady(img);
		}
	}

	function pause() {
		if (currentMediaEl instanceof HTMLVideoElement && !currentMediaEl.paused) {
			currentMediaEl.pause();
		}
		if (currentSceneInstance && typeof currentSceneInstance.pause === "function") {
			try {
				currentSceneInstance.pause();
			} catch {}
		}
	}

	function resume() {
		if (currentMediaEl instanceof HTMLVideoElement && currentMediaEl.paused) {
			currentMediaEl.play().catch(() => {});
		}
		if (currentSceneInstance && typeof currentSceneInstance.resume === "function") {
			try {
				currentSceneInstance.resume();
			} catch {}
		}
	}

	function setMuted(muted) {
		const vol = muted ? 0 : 1;
		if (currentMediaEl instanceof HTMLVideoElement) {
			currentMediaEl.muted = muted;
			currentMediaEl.volume = vol;
		}
		if (currentSceneInstance && typeof currentSceneInstance.setVolume === "function") {
			try {
				currentSceneInstance.setVolume(vol);
			} catch (err) {
				// developer-facing, not UI: browser console only
				console.warn("[wallpaper-engine] 设置 Scene 音量失败：", err);
			}
		}
		if (currentMediaEl instanceof HTMLIFrameElement) {
			try {
				currentMediaEl.contentWindow?.postMessage({ __we: 1, op: "setVolume", v: vol }, "*");
			} catch {}
		}
	}

	function setInteractive(interactive) {
		if (interactive) container.classList.add("interactive");
		else container.classList.remove("interactive");
	}

	function destroy() {
		cleanupCurrent();
		container?.remove();
		document.getElementById("pi-we-glass-theme")?.remove();
	}

	function dispatchAudio(spectrumArray) {
		if (currentMediaEl instanceof HTMLIFrameElement) {
			try {
				currentMediaEl.contentWindow?.__weReceiveAudio?.(spectrumArray);
			} catch {}
		}
	}

	function getCurrentItem() {
		return currentItem;
	}

	return { setWallpaper, pause, resume, setMuted, setInteractive, dispatchAudio, getCurrentItem, destroy };
}

function createDrawer(bgLayer, state, onStateChange, triggerRotate) {
	const backdrop = document.createElement("div");
	backdrop.className = "pi-we-backdrop";

	const drawer = document.createElement("div");
	drawer.className = "pi-we-drawer";

	let wallpapers = [];
	let currentFilter = "all";
	let searchKeyword = "";
	const PAGE_SIZE = 12;
	let currentPage = 1;
	let displayMode = "paged";

	drawer.innerHTML = `
		<div class="pi-we-header">
			<h3 class="pi-we-title" title="${t("libraryTitleTooltip")}">${t("libraryTitle")}</h3>
			<div class="pi-we-header-actions">
				<button class="pi-we-icon-btn" id="pi-we-toggle-settings-btn" title="${t("settingsToggleTooltip")}">⚙️ <span class="pi-we-btn-label">${t("settingsToggle")}</span> <span id="pi-we-toggle-settings-arrow">▾</span></button>
				<button class="pi-we-icon-btn" id="pi-we-rescan-btn" title="${t("rescanTooltip")}">🔄 <span class="pi-we-btn-label">${t("rescan")}</span></button>
				<button class="pi-we-icon-btn pi-we-close-btn" id="pi-we-close-btn" title="${t("closeLibraryTooltip")}">✕</button>
			</div>
		</div>

		<div class="pi-we-settings-bar">
			<div class="pi-we-slider-row">
				<span class="pi-we-slider-label">${t("themeLabel")}</span>
				<select class="pi-we-select" id="pi-we-theme-select" style="flex: 1;">
					<option value="obsidian" ${state.settings.wallpaperTheme === "obsidian" || !state.settings.wallpaperTheme ? "selected" : ""}>${t("themeObsidian")}</option>
					<option value="flow" ${state.settings.wallpaperTheme === "flow" || state.settings.wallpaperTheme === "compact-flow" ? "selected" : ""}>${t("themeFlow")}</option>
				</select>
			</div>
			<div class="pi-we-slider-row">
				<span class="pi-we-slider-label">${t("blurLabel")}</span>
				<input type="range" id="pi-we-blur-range" min="0" max="32" value="${state.settings.glassBlur}" />
				<span class="pi-we-slider-val" id="pi-we-blur-val">${state.settings.glassBlur}px</span>
			</div>
			<div class="pi-we-slider-row">
				<span class="pi-we-slider-label">${t("opacityLabel")}</span>
				<input type="range" id="pi-we-opacity-range" min="0" max="100" value="${state.settings.glassOpacity}" />
				<span class="pi-we-slider-val" id="pi-we-opacity-val">${state.settings.glassOpacity}%</span>
			</div>
			<div class="pi-we-slider-row">
				<span class="pi-we-slider-label">${t("rotateLabel")}</span>
				<select class="pi-we-select" id="pi-we-rotate-select">
					<option value="0" ${state.settings.autoRotateMinutes === "0" ? "selected" : ""}>${t("rotateOff")}</option>
					<option value="5" ${state.settings.autoRotateMinutes === "5" ? "selected" : ""}>${t("rotateEveryMinutes", { n: 5 })}</option>
					<option value="15" ${state.settings.autoRotateMinutes === "15" ? "selected" : ""}>${t("rotateEveryMinutes", { n: 15 })}</option>
					<option value="30" ${state.settings.autoRotateMinutes === "30" ? "selected" : ""}>${t("rotateEveryMinutes", { n: 30 })}</option>
					<option value="60" ${state.settings.autoRotateMinutes === "60" ? "selected" : ""}>${t("rotateEveryHour")}</option>
				</select>
				<span class="pi-we-slider-label" style="width: auto; margin-left: 8px;">${t("fpsLabel")}</span>
				<select class="pi-we-select" id="pi-we-fps-select">
					<option value="30" ${state.settings.fpsLimit === "30" ? "selected" : ""}>30 FPS</option>
					<option value="60" ${state.settings.fpsLimit === "60" ? "selected" : ""}>60 FPS</option>
					<option value="0" ${state.settings.fpsLimit === "0" || !state.settings.fpsLimit ? "selected" : ""}>${t("fpsUnlimited")}</option>
				</select>
			</div>
			<div class="pi-we-slider-row">
				<span class="pi-we-slider-label">${t("qualityLabel")}</span>
				<select class="pi-we-select" id="pi-we-quality-select" style="flex: 1;">
					<option value="performance" ${state.settings.qualityPreset === "performance" || !state.settings.qualityPreset ? "selected" : ""}>${t("qualityPerformance")}</option>
					<option value="balanced" ${state.settings.qualityPreset === "balanced" ? "selected" : ""}>${t("qualityBalanced")}</option>
					<option value="high" ${state.settings.qualityPreset === "high" ? "selected" : ""}>${t("qualityHigh")}</option>
					<option value="ultra" ${state.settings.qualityPreset === "ultra" ? "selected" : ""}>${t("qualityUltra")}</option>
				</select>
				<span class="pi-we-slider-label" style="width: auto; margin-left: 8px;">${t("aaLabel")}</span>
				<select class="pi-we-select" id="pi-we-aa-select">
					<option value="off" ${state.settings.antiAliasing === "off" || !state.settings.antiAliasing ? "selected" : ""}>${t("aaOff")}</option>
					<option value="fxaa" ${state.settings.antiAliasing === "fxaa" ? "selected" : ""}>${t("aaFxaa")}</option>
					<option value="msaa2" ${state.settings.antiAliasing === "msaa2" ? "selected" : ""}>MSAA 2x</option>
					<option value="msaa4" ${state.settings.antiAliasing === "msaa4" ? "selected" : ""}>MSAA 4x</option>
				</select>
			</div>
			<div class="pi-we-slider-row" style="justify-content: flex-start; gap: 14px;">
				<label class="pi-we-checkbox-row">
					<input type="checkbox" id="pi-we-interactive-check" ${state.settings.interactive ? "checked" : ""} />
					<span>${t("allowInteractive")}</span>
				</label>
				<label class="pi-we-checkbox-row">
					<input type="checkbox" id="pi-we-audio-check" ${state.settings.audioReactive ? "checked" : ""} />
					<span>${t("audioSpectrum")}</span>
				</label>
				<label class="pi-we-checkbox-row" title="${t("lightModeTooltip")}">
					<input type="checkbox" id="pi-we-lightmode-check" ${state.settings.lightWallpaperMode ? "checked" : ""} />
					<span>${t("lightMode")}</span>
				</label>
				<label class="pi-we-checkbox-row">
					<input type="checkbox" id="pi-we-mute-check" ${state.settings.muteAudio ? "checked" : ""} />
					<span>${t("mute")}</span>
				</label>
				<button class="pi-we-icon-btn" id="pi-we-clear-btn" style="margin-left: auto;">${t("closeWallpaper")}</button>
			</div>
			<div class="pi-we-preset-row">
				<button class="pi-we-icon-btn" id="pi-we-export-btn">${t("exportPreset")}</button>
				<button class="pi-we-icon-btn" id="pi-we-import-btn">${t("importPreset")}</button>
				<button class="pi-we-icon-btn" id="pi-we-rotate-now-btn" style="margin-left: auto;" title="${t("rotateNowTooltip")}">${t("rotateNow")}</button>
			</div>
		</div>

		<div class="pi-we-filter-bar">
			<input type="text" class="pi-we-search-input" id="pi-we-search" placeholder="${t("searchPlaceholder")}" />
			<div class="pi-we-tabs">
				<button class="pi-we-tab active" data-tab="all">${t("tabAll")}</button>
				<button class="pi-we-tab" data-tab="fav">${t("tabFavorites")}</button>
				<button class="pi-we-tab" data-tab="video">${t("tabVideo")}</button>
				<button class="pi-we-tab" data-tab="scene">${t("tabScene")}</button>
				<button class="pi-we-tab" data-tab="web">${t("tabWeb")}</button>
				<button class="pi-we-tab" data-tab="image">${t("tabImage")}</button>
				<button class="pi-we-mode-btn" id="pi-we-mode-btn" title="${t("modeTooltip")}">${t("modePaged")}</button>
			</div>
		</div>

		<div class="pi-we-body" id="pi-we-grid">
			<div class="pi-we-empty">
				<span>${t("loadingWallpapers")}</span>
			</div>
		</div>

		<div class="pi-we-pagination" id="pi-we-pagination" style="display: none;">
			<div class="pi-we-page-info">
				<span id="pi-we-page-stats">${t("pageStats", { n: 0 })}</span>
			</div>
			<div class="pi-we-page-nav">
				<button class="pi-we-page-btn" id="pi-we-page-prev" title="${t("pagePrevTooltip")}" disabled>${t("pagePrev")}</button>
				<div class="pi-we-page-numbers" id="pi-we-page-numbers"></div>
				<button class="pi-we-page-btn" id="pi-we-page-next" title="${t("pageNextTooltip")}" disabled>${t("pageNext")}</button>
			</div>
		</div>
	`;

	document.body.appendChild(backdrop);
	document.body.appendChild(drawer);

	const gridEl = drawer.querySelector("#pi-we-grid");
	const paginationEl = drawer.querySelector("#pi-we-pagination");
	const pageStatsEl = drawer.querySelector("#pi-we-page-stats");
	const pagePrevBtn = drawer.querySelector("#pi-we-page-prev");
	const pageNextBtn = drawer.querySelector("#pi-we-page-next");
	const pageNumbersEl = drawer.querySelector("#pi-we-page-numbers");
	const blurInput = drawer.querySelector("#pi-we-blur-range");
	const blurVal = drawer.querySelector("#pi-we-blur-val");
	const opacityInput = drawer.querySelector("#pi-we-opacity-range");
	const opacityVal = drawer.querySelector("#pi-we-opacity-val");
	const themeSelect = drawer.querySelector("#pi-we-theme-select");
	const fpsSelect = drawer.querySelector("#pi-we-fps-select");
	const qualitySelect = drawer.querySelector("#pi-we-quality-select");
	const aaSelect = drawer.querySelector("#pi-we-aa-select");
	const rotateSelect = drawer.querySelector("#pi-we-rotate-select");
	const interactiveCheck = drawer.querySelector("#pi-we-interactive-check");
	const audioCheck = drawer.querySelector("#pi-we-audio-check");
	const lightmodeCheck = drawer.querySelector("#pi-we-lightmode-check");
	const muteCheck = drawer.querySelector("#pi-we-mute-check");
	const searchInput = drawer.querySelector("#pi-we-search");
	const tabs = drawer.querySelectorAll(".pi-we-tab");
	const modeBtn = drawer.querySelector("#pi-we-mode-btn");

	let lastWallpapersFetchTime = 0;
	const WALLPAPERS_CACHE_TTL = 120_000;

	function open() {
		ensureStyles();
		backdrop.classList.add("open");
		drawer.classList.add("open");

		const now = Date.now();
		if (wallpapers.length > 0 && now - lastWallpapersFetchTime < WALLPAPERS_CACHE_TTL) {
			renderGrid();
			void loadWallpapers(true);
		} else {
			void loadWallpapers(false);
		}
	}

	function close() {
		backdrop.classList.remove("open");
		drawer.classList.remove("open");
	}

	function toggle() {
		if (drawer.classList.contains("open")) close();
		else open();
	}

	backdrop.addEventListener("click", close);
	drawer.querySelector("#pi-we-close-btn").addEventListener("click", close);

	const onKeyDown = (e) => {
		if (e.key === "Escape" && drawer.classList.contains("open")) {
			close();
		}
	};
	window.addEventListener("keydown", onKeyDown);

	blurInput.addEventListener("input", (e) => {
		const val = Number(e.target.value);
		blurVal.textContent = `${val}px`;
		state.settings.glassBlur = val;
		if (state.activeId)
			updateGlassStyle(
				val,
				state.settings.glassOpacity,
				true,
				state.settings.interactive,
				state.settings.wallpaperTheme,
				state.settings.lightWallpaperMode,
			);
		onStateChange();
	});

	opacityInput.addEventListener("input", (e) => {
		const val = Number(e.target.value);
		opacityVal.textContent = `${val}%`;
		state.settings.glassOpacity = val;
		if (state.activeId)
			updateGlassStyle(
				state.settings.glassBlur,
				val,
				true,
				state.settings.interactive,
				state.settings.wallpaperTheme,
				state.settings.lightWallpaperMode,
			);
		onStateChange();
	});

	if (themeSelect) {
		themeSelect.addEventListener("change", (e) => {
			state.settings.wallpaperTheme = e.target.value;
			if (state.activeId) {
				activateThemeLock();
				updateGlassStyle(
					state.settings.glassBlur,
					state.settings.glassOpacity,
					true,
					state.settings.interactive,
					state.settings.wallpaperTheme,
					state.settings.lightWallpaperMode,
				);
			}
			onStateChange();
		});
	}

	fpsSelect.addEventListener("change", (e) => {
		state.settings.fpsLimit = e.target.value;
		const cur = bgLayer.getCurrentItem();
		if (cur && (cur.type === "scene" || cur.hasScene)) {
			void bgLayer.setWallpaper(cur, state.settings);
		}
		onStateChange();
	});

	if (qualitySelect) {
		qualitySelect.addEventListener("change", (e) => {
			state.settings.qualityPreset = e.target.value;
			const cur = bgLayer.getCurrentItem();
			if (cur && (cur.type === "scene" || cur.hasScene)) {
				void bgLayer.setWallpaper(cur, state.settings);
			}
			onStateChange();
		});
	}

	if (aaSelect) {
		aaSelect.addEventListener("change", (e) => {
			state.settings.antiAliasing = e.target.value;
			const cur = bgLayer.getCurrentItem();
			if (cur && (cur.type === "scene" || cur.hasScene)) {
				void bgLayer.setWallpaper(cur, state.settings);
			}
			onStateChange();
		});
	}

	rotateSelect.addEventListener("change", (e) => {
		state.settings.autoRotateMinutes = e.target.value;
		onStateChange();
	});

	interactiveCheck.addEventListener("change", (e) => {
		state.settings.interactive = e.target.checked;
		bgLayer.setInteractive(e.target.checked);
		if (state.activeId)
			updateGlassStyle(
				state.settings.glassBlur,
				state.settings.glassOpacity,
				true,
				e.target.checked,
				state.settings.wallpaperTheme,
				state.settings.lightWallpaperMode,
			);
		onStateChange();
	});

	audioCheck.addEventListener("change", (e) => {
		state.settings.audioReactive = e.target.checked;
		onStateChange();
	});

	if (lightmodeCheck) {
		lightmodeCheck.addEventListener("change", (e) => {
			state.settings.lightWallpaperMode = e.target.checked;
			if (state.activeId) {
				updateGlassStyle(
					state.settings.glassBlur,
					state.settings.glassOpacity,
					true,
					state.settings.interactive,
					state.settings.wallpaperTheme,
					e.target.checked,
				);
			}
			onStateChange();
		});
	}

	muteCheck.addEventListener("change", (e) => {
		state.settings.muteAudio = e.target.checked;
		bgLayer.setMuted(e.target.checked);
		onStateChange();
	});

	drawer.querySelector("#pi-we-clear-btn").addEventListener("click", () => {
		state.activeId = "";
		bgLayer.setWallpaper(null, state.settings);
		renderGrid();
		onStateChange();
	});

	drawer.querySelector("#pi-we-rotate-now-btn").addEventListener("click", () => {
		triggerRotate();
	});

	drawer.querySelector("#pi-we-export-btn").addEventListener("click", async () => {
		try {
			const res = await fetch(`${API_BASE}/api/presets`);
			const json = await res.json();
			const text = JSON.stringify(json, null, 2);
			if (navigator.clipboard) {
				await navigator.clipboard.writeText(text);
				alert(t("presetCopied"));
			} else {
				prompt(t("presetCopyManual"), text);
			}
		} catch (err) {
			alert(t("exportFailed", { error: err.message }));
		}
	});

	drawer.querySelector("#pi-we-import-btn").addEventListener("click", async () => {
		const input = prompt(t("presetPaste"));
		if (!input) return;
		try {
			const parsed = JSON.parse(input);
			const res = await fetch(`${API_BASE}/api/presets`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(parsed),
			});
			const json = await res.json();
			if (json.ok) {
				state.activeId = json.activeId || "";
				state.settings = { ...state.settings, ...(json.settings || {}) };
				state.favorites = json.favorites || [];
				syncSettings(state);
				void loadWallpapers();
				alert(t("presetImported"));
			}
		} catch (err) {
			alert(t("importFailed", { error: err.message }));
		}
	});

	const settingsBar = drawer.querySelector(".pi-we-settings-bar");
	const toggleSettingsBtn = drawer.querySelector("#pi-we-toggle-settings-btn");
	const toggleSettingsArrow = drawer.querySelector("#pi-we-toggle-settings-arrow");

	const isMobile = typeof window !== "undefined" && window.innerWidth <= 480;
	const savedCollapsed = typeof localStorage !== "undefined" ? localStorage.getItem("pi-we:settings-collapsed") : null;
	let isSettingsCollapsed = savedCollapsed !== null ? savedCollapsed === "1" : isMobile;

	function applySettingsCollapsed(collapsed) {
		if (collapsed) {
			settingsBar?.classList.add("collapsed");
			toggleSettingsBtn?.classList.remove("active");
			if (toggleSettingsArrow) toggleSettingsArrow.textContent = "▾";
		} else {
			settingsBar?.classList.remove("collapsed");
			toggleSettingsBtn?.classList.add("active");
			if (toggleSettingsArrow) toggleSettingsArrow.textContent = "▴";
		}
	}
	applySettingsCollapsed(isSettingsCollapsed);

	toggleSettingsBtn?.addEventListener("click", () => {
		isSettingsCollapsed = !isSettingsCollapsed;
		applySettingsCollapsed(isSettingsCollapsed);
		try {
			localStorage.setItem("pi-we:settings-collapsed", isSettingsCollapsed ? "1" : "0");
		} catch {}
	});

	drawer.querySelector("#pi-we-rescan-btn").addEventListener("click", async () => {
		currentPage = 1;
		gridEl.innerHTML = `<div class="pi-we-empty"><span>${t("rescanning")}</span></div>`;
		updatePagination(0, 1, 1);
		try {
			const res = await fetch(`${API_BASE}/api/rescan`);
			const json = await res.json();
			if (json.ok) {
				wallpapers = json.wallpapers || [];
				state.favorites = json.favorites || [];
				renderGrid();
			}
		} catch (err) {
			gridEl.innerHTML = `<div class="pi-we-empty"><span>${t("rescanFailed", { error: err.message })}</span></div>`;
			updatePagination(0, 1, 1);
		}
	});

	searchInput.addEventListener("input", (e) => {
		searchKeyword = e.target.value.trim().toLowerCase();
		currentPage = 1;
		renderGrid();
	});

	tabs.forEach((tab) => {
		tab.addEventListener("click", () => {
			tabs.forEach((t) => t.classList.remove("active"));
			tab.classList.add("active");
			currentFilter = tab.getAttribute("data-tab");
			currentPage = 1;
			renderGrid();
		});
	});

	if (modeBtn) {
		modeBtn.addEventListener("click", () => {
			displayMode = displayMode === "paged" ? "all" : "paged";
			modeBtn.textContent = displayMode === "paged" ? t("modePaged") : t("modeAll");
			currentPage = 1;
			renderGrid();
			gridEl.scrollTop = 0;
		});
	}

	pagePrevBtn.addEventListener("click", () => {
		if (currentPage > 1) {
			currentPage--;
			renderGrid();
			gridEl.scrollTop = 0;
		}
	});

	pageNextBtn.addEventListener("click", () => {
		const filtered = getFilteredWallpapers();
		const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
		if (currentPage < totalPages) {
			currentPage++;
			renderGrid();
			gridEl.scrollTop = 0;
		}
	});

	function getFilteredWallpapers() {
		return wallpapers.filter((w) => {
			if (currentFilter === "fav") {
				if (!state.favorites.includes(w.id)) return false;
			} else if (currentFilter !== "all" && w.type !== currentFilter) {
				return false;
			}
			if (searchKeyword) {
				const matchTitle = w.title.toLowerCase().includes(searchKeyword);
				const matchTag = w.tags?.some((t) => t.toLowerCase().includes(searchKeyword));
				if (!matchTitle && !matchTag) return false;
			}
			return true;
		});
	}

	function updatePagination(totalCount, totalPages, curPage) {
		if (!paginationEl) return;
		if (totalCount === 0) {
			paginationEl.style.display = "none";
			return;
		}

		paginationEl.style.display = "flex";
		if (displayMode === "all") {
			if (pageStatsEl) {
				pageStatsEl.textContent = t("pageStatsAll", { total: totalCount });
			}
			if (pagePrevBtn) pagePrevBtn.disabled = true;
			if (pageNextBtn) pageNextBtn.disabled = true;
			if (pageNumbersEl) pageNumbersEl.innerHTML = "";
			return;
		}

		if (pageStatsEl) {
			pageStatsEl.textContent = t("pageStatsPaged", { total: totalCount, cur: curPage, totalPages });
		}
		if (pagePrevBtn) {
			pagePrevBtn.disabled = curPage <= 1;
		}
		if (pageNextBtn) {
			pageNextBtn.disabled = curPage >= totalPages;
		}

		if (pageNumbersEl) {
			pageNumbersEl.innerHTML = "";
			const pageList = getPageNumbers(curPage, totalPages);
			pageList.forEach((p) => {
				if (p === "...") {
					const span = document.createElement("span");
					span.className = "pi-we-page-ellipsis";
					span.textContent = "…";
					pageNumbersEl.appendChild(span);
				} else {
					const btn = document.createElement("button");
					btn.className = `pi-we-page-num ${p === curPage ? "active" : ""}`;
					btn.textContent = String(p);
					btn.addEventListener("click", () => {
						if (currentPage !== p) {
							currentPage = p;
							renderGrid();
							gridEl.scrollTop = 0;
						}
					});
					pageNumbersEl.appendChild(btn);
				}
			});
		}
	}

	function getPageNumbers(cur, total) {
		if (total <= 7) {
			return Array.from({ length: total }, (_, i) => i + 1);
		}
		const set = new Set([1, total, cur]);
		if (cur - 1 > 1) set.add(cur - 1);
		if (cur + 1 < total) set.add(cur + 1);
		if (cur <= 3) {
			set.add(2);
			set.add(3);
			set.add(4);
		}
		if (cur >= total - 2) {
			set.add(total - 1);
			set.add(total - 2);
			set.add(total - 3);
		}
		const sorted = Array.from(set).sort((a, b) => a - b);
		const result = [];
		let last = 0;
		for (const p of sorted) {
			if (last && p - last > 1) {
				result.push("...");
			}
			result.push(p);
			last = p;
		}
		return result;
	}

	async function loadWallpapers(silent = false) {
		if (!silent && wallpapers.length === 0) {
			gridEl.innerHTML = `<div class="pi-we-empty"><span>${t("loadingWallpapers")}</span></div>`;
		}
		try {
			const res = await fetch(`${API_BASE}/api/wallpapers`);
			const json = await res.json();
			if (json.ok) {
				wallpapers = json.wallpapers || [];
				state.favorites = json.favorites || [];
				lastWallpapersFetchTime = Date.now();
				if (!silent) currentPage = 1;
				renderGrid();
			} else if (!silent) {
				gridEl.innerHTML = `
					<div class="pi-we-empty">
						<span>${t("noSteam")}</span>
						<span class="pi-we-empty-sub">${t("noSteamHint")}</span>
					</div>
				`;
				updatePagination(0, 1, 1);
			}
		} catch (err) {
			if (!silent) {
				gridEl.innerHTML = `<div class="pi-we-empty"><span>${t("loadFailed", { error: err.message })}</span></div>`;
				updatePagination(0, 1, 1);
			}
		}
	}

	function renderGrid() {
		ensureStyles();
		const filtered = getFilteredWallpapers();
		const totalCount = filtered.length;
		const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

		if (currentPage > totalPages) currentPage = totalPages;
		if (currentPage < 1) currentPage = 1;

		if (totalCount === 0) {
			gridEl.innerHTML = `
				<div class="pi-we-empty">
					<span>${t("noMatch")}</span>
				</div>
			`;
			updatePagination(0, 1, 1);
			return;
		}

		gridEl.innerHTML = "";
		const startIdx = (currentPage - 1) * PAGE_SIZE;
		const pageItems = displayMode === "all" ? filtered : filtered.slice(startIdx, startIdx + PAGE_SIZE);

		pageItems.forEach((w) => {
			const card = document.createElement("div");
			const isActive = w.id === state.activeId;
			const isFav = state.favorites.includes(w.id);
			card.className = `pi-we-card pi-we-card-item ${isActive ? "active" : ""}`;
			card.tabIndex = 0;

			const previewUrl = w.hasPreview ? `${API_BASE}/api/preview?id=${encodeURIComponent(w.id)}` : "";

			card.innerHTML = `
				<div class="pi-we-thumb-wrap pi-we-cover-wrap">
					${previewUrl ? `<img class="pi-we-thumb pi-we-cover-img" src="${previewUrl}" alt="${w.title}" loading="lazy" decoding="async" fetchpriority="low" />` : ""}
					<span class="pi-we-badge ${w.type}">${w.type}</span>
					${isActive ? `<span class="pi-we-active-indicator">${t("activeBadge")}</span>` : ""}
				</div>
				<div class="pi-we-card-info pi-we-card-meta-bar">
					<div class="pi-we-card-title" title="${w.title}">${w.title}</div>
					<div class="pi-we-card-meta">
						<span>${w.rating || "Everyone"}</span>
						<button class="pi-we-fav-btn ${isFav ? "active" : ""}" title="${isFav ? t("removeFavorite") : t("addFavorite")}">${isFav ? "★" : "☆"}</button>
					</div>
				</div>
			`;

			const favBtn = card.querySelector(".pi-we-fav-btn");
			favBtn.addEventListener("click", async (e) => {
				e.stopPropagation();
				try {
					const res = await fetch(`${API_BASE}/api/favorite`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ id: w.id }),
					});
					const json = await res.json();
					if (json.ok) {
						state.favorites = json.favorites || [];
						renderGrid();
					}
				} catch {}
			});

			card.addEventListener("click", () => {
				state.activeId = w.id;
				void bgLayer.setWallpaper(w, state.settings);
				renderGrid();
				onStateChange();
			});

			gridEl.appendChild(card);
		});
	}

	function syncSettings(freshState) {
		if (!freshState?.settings) return;
		const s = freshState.settings;
		if (blurInput) blurInput.value = String(s.glassBlur ?? 0);
		if (blurVal) blurVal.textContent = `${s.glassBlur ?? 0}px`;
		if (opacityInput) opacityInput.value = String(s.glassOpacity ?? 40);
		if (opacityVal) opacityVal.textContent = `${s.glassOpacity ?? 40}%`;
		if (themeSelect) themeSelect.value = s.wallpaperTheme || "obsidian";
		if (fpsSelect) fpsSelect.value = String(s.fpsLimit ?? "0");
		if (qualitySelect) qualitySelect.value = s.qualityPreset || "performance";
		if (aaSelect) aaSelect.value = s.antiAliasing || "off";
		if (rotateSelect) rotateSelect.value = String(s.autoRotateMinutes ?? "0");
		if (interactiveCheck) interactiveCheck.checked = Boolean(s.interactive);
		if (audioCheck) audioCheck.checked = Boolean(s.audioReactive);
		if (lightmodeCheck) lightmodeCheck.checked = Boolean(s.lightWallpaperMode);
		if (muteCheck) muteCheck.checked = Boolean(s.muteAudio);
	}

	function destroy() {
		window.removeEventListener("keydown", onKeyDown);
		backdrop.remove();
		drawer.remove();
	}

	return { open, close, toggle, loadWallpapers, renderGrid, syncSettings, getWallpapers: () => wallpapers, destroy };
}

function createToolInspector() {
	if (globalThis.__piToolInspectorActive) {
		return {
			open: () => {},
			close: () => {},
			destroy: () => {},
			isOpen: () => false,
		};
	}

	const backdrop = document.createElement("div");
	backdrop.className = "pi-we-inspector-backdrop";

	const dialog = document.createElement("div");
	dialog.className = "pi-we-inspector-dialog";

	dialog.innerHTML = `
		<div class="pi-we-inspector-header">
			<div class="pi-we-inspector-title-group">
				<div class="pi-we-inspector-icon" id="pi-we-ins-icon">⚡</div>
				<div class="pi-we-inspector-title" id="pi-we-ins-title">${t("inspectorTitle")}</div>
				<div class="pi-we-inspector-badge" id="pi-we-ins-badge">${t("inspectorDone")}</div>
			</div>
			<div class="pi-we-inspector-actions">
				<button type="button" class="pi-we-inspector-btn" id="pi-we-ins-toggle-btn" style="display:none;">${t("toggleRaw")}</button>
				<button type="button" class="pi-we-inspector-btn" id="pi-we-ins-copy-btn">${t("copyAll")}</button>
				<button type="button" class="pi-we-inspector-btn pi-we-inspector-close" id="pi-we-ins-close-btn" title="${t("closeTooltip")}">✕</button>
			</div>
		</div>
		<div class="pi-we-inspector-body" id="pi-we-ins-body"></div>
	`;

	backdrop.appendChild(dialog);
	document.body.appendChild(backdrop);

	const iconEl = dialog.querySelector("#pi-we-ins-icon");
	const titleEl = dialog.querySelector("#pi-we-ins-title");
	const badgeEl = dialog.querySelector("#pi-we-ins-badge");
	const bodyEl = dialog.querySelector("#pi-we-ins-body");
	const toggleBtn = dialog.querySelector("#pi-we-ins-toggle-btn");
	const copyBtn = dialog.querySelector("#pi-we-ins-copy-btn");
	const closeBtn = dialog.querySelector("#pi-we-ins-close-btn");

	let currentCopyText = "";
	let currentData = null;
	let currentMode = "preview";

	function tryParsePresentArgs(argsStr) {
		if (!argsStr || typeof argsStr !== "string") return null;
		try {
			const obj = JSON.parse(argsStr);
			if (obj && Array.isArray(obj.items) && obj.items.length > 0) {
				return {
					title: typeof obj.title === "string" ? obj.title.trim() : "",
					note: typeof obj.note === "string" ? obj.note.trim() : "",
					items: obj.items
						.map((it) => {
							if (typeof it === "string") return { path: it.trim(), caption: "" };
							if (it && typeof it === "object") {
								return {
									path: String(it.path || "").trim(),
									caption: String(it.caption || "").trim(),
								};
							}
							return null;
						})
						.filter((it) => it && it.path),
				};
			}
		} catch {}
		return null;
	}

	function classifyMedia(filePath) {
		const ext = String(filePath || "")
			.split(".")
			.pop()
			.toLowerCase();
		const audioExts = ["aac", "mp3", "wav", "wave", "ogg", "oga", "opus", "m4a", "flac", "weba"];
		const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"];
		const videoExts = ["mp4", "webm", "mov", "mkv", "avi", "m4v"];
		if (audioExts.includes(ext)) return "audio";
		if (imageExts.includes(ext)) return "image";
		if (videoExts.includes(ext)) return "video";
		return "file";
	}

	function getMediaIcon(kind) {
		if (kind === "audio") return "🎵";
		if (kind === "image") return "🖼️";
		if (kind === "video") return "🎬";
		return "📄";
	}

	function buildFileUrl(filePath) {
		return `/api/file?path=${encodeURIComponent(filePath)}`;
	}

	function renderRawView(data) {
		const { name, args, output, images, error, statusClass } = data;
		let sectionsHtml = "";
		if (args) {
			sectionsHtml += `
				<div class="pi-we-inspector-section">
					<div class="pi-we-inspector-label">${t("argsLabel")}</div>
					<pre class="pi-we-inspector-codeblock" id="pi-we-ins-args-pre"></pre>
				</div>
			`;
		}
		if (images && images.length > 0) {
			sectionsHtml += `
				<div class="pi-we-inspector-section">
					<div class="pi-we-inspector-label">${t("imagesLabel", { n: images.length })}</div>
					<div class="pi-we-inspector-images" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;">
						${images.map((src, i) => `<img src="${src}" style="max-height:240px;max-width:100%;border-radius:6px;border:1px solid rgba(255,255,255,0.14);" alt="image ${i + 1}" />`).join("")}
					</div>
				</div>
			`;
		}
		sectionsHtml += `
			<div class="pi-we-inspector-section">
				<div class="pi-we-inspector-label">${error ? t("errorLabel") : t("outputLabel")}</div>
				<pre class="pi-we-inspector-codeblock" id="pi-we-ins-output-pre"></pre>
			</div>
		`;
		bodyEl.innerHTML = sectionsHtml;

		const argsPre = bodyEl.querySelector("#pi-we-ins-args-pre");
		if (argsPre) {
			let displayArgs = args;
			try {
				if (typeof args === "string" && (args.startsWith("{") || args.startsWith("["))) {
					displayArgs = JSON.stringify(JSON.parse(args), null, 2);
				}
			} catch {}
			argsPre.textContent = displayArgs;
		}

		const outPre = bodyEl.querySelector("#pi-we-ins-output-pre");
		if (outPre) {
			let displayOutput = output;
			try {
				if (typeof output === "string" && (output.startsWith("{") || output.startsWith("["))) {
					displayOutput = JSON.stringify(JSON.parse(output), null, 2);
				}
			} catch {}
			outPre.textContent = displayOutput || (statusClass === "run" ? t("runningOutput") : t("successNoText"));
		}
	}

	function renderPreviewView(presentData, data) {
		const { title, note, items } = presentData;
		const { error, output } = data;

		let html = `<div class="pi-we-ins-preview-wrap">`;

		if (title || note) {
			html += `
				<div class="pi-we-ins-preview-meta">
					${title ? `<div class="pi-we-ins-preview-title">📦 ${escapeHtml(title)}</div>` : ""}
					${note ? `<div class="pi-we-ins-preview-note">${escapeHtml(note)}</div>` : ""}
				</div>
			`;
		}

		for (const item of items) {
			const kind = classifyMedia(item.path);
			const icon = getMediaIcon(kind);
			const fileName = item.path.split(/[\\/]/).pop() || item.path;
			const fileUrl = buildFileUrl(item.path);

			html += `
				<div class="pi-we-ins-preview-card">
					<div class="pi-we-ins-preview-head">
						<div class="pi-we-ins-preview-info">
							<span class="pi-we-ins-preview-icon">${icon}</span>
							<span class="pi-we-ins-preview-name" title="${escapeHtml(item.path)}">${escapeHtml(fileName)}</span>
							${item.caption ? `<span class="pi-we-ins-preview-caption">${escapeHtml(item.caption)}</span>` : ""}
						</div>
						<div class="pi-we-ins-preview-actions">
							<a href="${fileUrl}&download=1" class="pi-we-ins-btn-sm" title="${t("downloadTooltip")}" download="${escapeHtml(fileName)}">${t("download")}</a>
							<button type="button" class="pi-we-ins-btn-sm pi-we-ins-copy-path" data-path="${escapeHtml(item.path)}" title="${t("copyPathTooltip")}">${t("copyPath")}</button>
						</div>
					</div>
					<div class="pi-we-ins-preview-media">
						${
							kind === "audio"
								? `<audio class="pi-we-ins-preview-audio" src="${fileUrl}" controls preload="metadata"></audio>`
								: kind === "image"
									? `<img class="pi-we-ins-preview-img" src="${fileUrl}" alt="${escapeHtml(fileName)}" loading="lazy" />`
									: kind === "video"
										? `<video class="pi-we-ins-preview-video" src="${fileUrl}" controls preload="metadata"></video>`
										: `<div style="font-size:12px;color:#94a3b8;font-family:var(--mono, monospace);word-break:break-all;">${escapeHtml(item.path)}</div>`
						}
					</div>
				</div>
			`;
		}

		if (error) {
			html += `
				<div class="pi-we-inspector-section" style="margin-top:8px;">
					<div class="pi-we-inspector-label">${t("errorLabel")}</div>
					<pre class="pi-we-inspector-codeblock">${escapeHtml(output)}</pre>
				</div>
			`;
		}

		html += `</div>`;
		bodyEl.innerHTML = html;

		bodyEl.querySelectorAll(".pi-we-ins-copy-path").forEach((btn) => {
			btn.addEventListener("click", () => {
				const p = btn.getAttribute("data-path");
				if (p) {
					void navigator.clipboard?.writeText?.(p);
					const orig = btn.textContent;
					btn.textContent = t("copied");
					setTimeout(() => {
						btn.textContent = orig;
					}, 1200);
				}
			});
		});
	}

	function close() {
		backdrop.classList.remove("open");
		currentData = null;
	}

	function open(data) {
		currentData = data;
		const { isThinking, name, status, statusClass, duration, args, output, images, error } = data;
		currentCopyText = "";

		if (isThinking) {
			toggleBtn.style.display = "none";
			iconEl.textContent = "💭";
			titleEl.textContent = t("thinkingTitle");
			badgeEl.textContent = duration || t("inspectorDone");
			badgeEl.className = "pi-we-inspector-badge ok";

			bodyEl.innerHTML = `
				<div class="pi-we-inspector-section">
					<div class="pi-we-inspector-label">${t("thinkingLabel")}</div>
					<div class="pi-we-inspector-thinking-text"></div>
				</div>
			`;
			const textEl = bodyEl.querySelector(".pi-we-inspector-thinking-text");
			if (textEl) textEl.textContent = output || t("thinkingEmpty");
			currentCopyText = output || "";
		} else {
			const toolIcons = {
				bash: "⚡",
				read: "📄",
				write: "✏️",
				edit: "✏️",
				edit_soft: "✏️",
				grep: "🔍",
				find: "🧭",
				codemode: "⚡",
				eval: "⚡",
				lsp: "💻",
				subagent: "👥",
				delegate_task: "👥",
				present_files: "📦",
				browser_search: "🔍",
				browser_use: "🌐",
				tunnel_fetch: "🌐",
				conversation_read: "💬",
				ask_user_question: "❓",
				claim_files: "🔒",
			};
			iconEl.textContent = toolIcons[name] || "🔧";
			titleEl.textContent = `${name}()`;

			badgeEl.className = `pi-we-inspector-badge ${statusClass || "ok"}`;
			badgeEl.textContent = duration
				? t("statusWithDuration", { status: status || t("statusDone"), duration })
				: status || t("statusDone");

			const presentData = name === "present_files" || args?.includes('"items"') ? tryParsePresentArgs(args) : null;

			if (presentData) {
				toggleBtn.style.display = "inline-flex";
				currentMode = "preview";
				toggleBtn.textContent = t("toggleRaw");
				toggleBtn.title = t("toggleRawTooltip");
				renderPreviewView(presentData, data);
			} else {
				toggleBtn.style.display = "none";
				currentMode = "raw";
				renderRawView(data);
			}

			currentCopyText = (args ? `[Arguments]\n${args}\n\n` : "") + `[Output]\n${output || ""}`;
		}

		backdrop.classList.add("open");
	}

	toggleBtn.addEventListener("click", () => {
		if (!currentData) return;
		const presentData = tryParsePresentArgs(currentData.args);
		if (!presentData) return;

		if (currentMode === "preview") {
			currentMode = "raw";
			toggleBtn.textContent = t("togglePreview");
			toggleBtn.title = t("togglePreviewTooltip");
			renderRawView(currentData);
		} else {
			currentMode = "preview";
			toggleBtn.textContent = t("toggleRaw");
			toggleBtn.title = t("toggleRawTooltip");
			renderPreviewView(presentData, currentData);
		}
	});

	copyBtn.addEventListener("click", () => {
		if (currentCopyText) {
			void navigator.clipboard?.writeText?.(currentCopyText);
			const orig = copyBtn.textContent;
			copyBtn.textContent = t("copied");
			setTimeout(() => {
				copyBtn.textContent = orig;
			}, 1200);
		}
	});

	closeBtn.addEventListener("click", close);
	backdrop.addEventListener("click", (e) => {
		if (e.target === backdrop) close();
	});

	function onKeyDown(e) {
		if (e.key === "Escape" && backdrop.classList.contains("open")) {
			e.stopPropagation();
			close();
		}
	}
	window.addEventListener("keydown", onKeyDown);

	function destroy() {
		window.removeEventListener("keydown", onKeyDown);
		backdrop.remove();
	}

	return { open, close, destroy, isOpen: () => backdrop.classList.contains("open") };
}

function setupToolInspectorClickListener(inspector, state) {
	if (globalThis.__piToolInspectorActive) {
		return () => {};
	}

	function onClickCapture(e) {
		const theme = state.settings?.wallpaperTheme;
		const docTheme = document.documentElement?.dataset?.theme || "";
		const linkHref = document.getElementById("theme-stylesheet")?.getAttribute("href") || "";
		const inToolsTrail = Boolean(e.target.closest?.(".turn-tools-trail"));
		const isFlow =
			theme === "flow" ||
			theme === "compact-flow" ||
			docTheme === "flow" ||
			docTheme === "flow-light" ||
			docTheme === "wallpaper-flow" ||
			linkHref.includes("flow") ||
			inToolsTrail;
		if (!isFlow) return;

		const toolEl = e.target.closest(".toolcall");
		const thinkEl = e.target.closest(".thinking");
		if (!toolEl && !thinkEl) return;

		if (e.target.closest(".toolcall-kill, .toolcall-open, button.toolcall-image, .toolcall-image")) {
			return;
		}

		e.preventDefault();
		e.stopPropagation();

		if (thinkEl) {
			const output =
				thinkEl.getAttribute("data-thinking") ||
				thinkEl.querySelector(".thinking-body")?.textContent?.trim() ||
				thinkEl.querySelector(".thinking-summary-text")?.textContent?.trim() ||
				thinkEl.querySelector(".thinking-label")?.textContent?.trim() ||
				"";
			const duration = thinkEl.querySelector(".thinking-summary")?.textContent?.trim() || "";
			inspector.open({
				isThinking: true,
				duration,
				output,
			});
			return;
		}

		if (toolEl) {
			const name = toolEl.querySelector(".toolcall-name")?.textContent?.trim() || "tool";
			const isError = toolEl.classList.contains("err");
			const isRun = toolEl.classList.contains("run");
			const isOk = toolEl.classList.contains("ok");
			const statusClass = isError ? "err" : isRun ? "run" : isOk ? "ok" : "idle";

			const statusTitle = toolEl.querySelector(".toolcall-status")?.getAttribute("title") || "";
			const duration = toolEl.querySelector(".toolcall-duration")?.textContent?.trim() || "";

			const payloadArgs = toolEl.querySelector(".toolcall-payload-args")?.textContent;
			const payloadOut = toolEl.querySelector(".toolcall-payload-output")?.textContent;

			let args = "";
			if (payloadArgs !== undefined && payloadArgs !== null && payloadArgs.trim()) {
				args = payloadArgs;
			} else {
				const argsPre = toolEl.querySelector(".toolcall-args pre");
				const cmdEl = toolEl.querySelector(".toolcall-args .terminal-cmd, .toolcall-cmd");
				if (argsPre) {
					args = argsPre.textContent || "";
				} else if (cmdEl) {
					args = cmdEl.textContent || "";
				} else {
					const pathEl = toolEl.querySelector(".toolcall-path");
					if (pathEl) args = pathEl.getAttribute("title") || pathEl.textContent || "";
				}
			}

			let output = "";
			if (payloadOut !== undefined && payloadOut !== null && payloadOut.trim()) {
				output = payloadOut;
			} else {
				const outPre = toolEl.querySelector(".toolcall-output pre");
				if (outPre) {
					output = outPre.textContent || "";
				}
			}

			const imgEls = toolEl.querySelectorAll(".toolcall-images img");
			const images = Array.from(imgEls)
				.map((img) => img.src)
				.filter(Boolean);

			inspector.open({
				isThinking: false,
				name,
				status: statusTitle || (isError ? t("statusFailed") : isRun ? t("statusRunning") : t("statusDone")),
				statusClass,
				duration,
				args: args.trim(),
				output: output.trim(),
				images,
				error: isError,
			});
		}
	}

	document.addEventListener("click", onClickCapture, true);
	return () => {
		document.removeEventListener("click", onClickCapture, true);
	};
}

const state = {
	activeId: "",
	favorites: [],
	settings: {
		glassBlur: 0,
		glassOpacity: 40,
		wallpaperTheme: "obsidian",
		fpsLimit: "0",
		qualityPreset: "performance",
		antiAliasing: "off",
		interactive: false,
		muteAudio: true,
		pauseOnHidden: true,
		audioReactive: false,
		autoRotateMinutes: "0",
		lightWallpaperMode: false,
	},
};

const bgLayer = createBackgroundLayer();
const audioEngine = createAudioReactiveEngine(() => bgLayer);

let saveTimer = null;
function onStateChange() {
	if (state.settings.audioReactive) audioEngine.start();
	else audioEngine.stop();

	scheduleAutoRotate();

	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		fetch(`${API_BASE}/api/active`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				activeId: state.activeId,
				favorites: state.favorites,
				settings: state.settings,
			}),
		}).catch(() => {});
	}, 300);
}

function triggerRotate() {
	const pool = drawer.getWallpapers();
	if (!pool.length) return;
	const candList = state.favorites.length ? pool.filter((w) => state.favorites.includes(w.id)) : pool;
	const candidates = candList.length ? candList : pool;
	if (!candidates.length) return;

	const curIdx = candidates.findIndex((w) => w.id === state.activeId);
	const nextIdx = (curIdx + 1) % candidates.length;
	const nextItem = candidates[nextIdx];

	if (nextItem) {
		state.activeId = nextItem.id;
		void bgLayer.setWallpaper(nextItem, state.settings);
		drawer.renderGrid();
		onStateChange();
	}
}

let autoRotateTimer = null;
function scheduleAutoRotate() {
	if (autoRotateTimer) {
		clearInterval(autoRotateTimer);
		autoRotateTimer = null;
	}
	const mins = Number(state.settings.autoRotateMinutes || 0);
	if (mins > 0) {
		autoRotateTimer = setInterval(
			() => {
				if (!document.hidden) {
					triggerRotate();
				}
			},
			mins * 60 * 1000,
		);
	}
}

const drawer = createDrawer(bgLayer, state, onStateChange, triggerRotate);
const toolInspector = createToolInspector();
const stopToolInspector = setupToolInspectorClickListener(toolInspector, state);

const onVisibilityChange = () => {
	if (state.settings.pauseOnHidden) {
		if (document.hidden) {
			bgLayer.pause();
			audioEngine.stop();
		} else {
			bgLayer.resume();
			if (state.settings.audioReactive) audioEngine.start();
		}
	}
};
document.addEventListener("visibilitychange", onVisibilityChange);

const teardown = [];
function whenBridge(fn, tries = 40) {
	const bridge = globalThis.window?.__piWebUiHost;
	if (bridge && typeof bridge === "object") {
		fn(bridge);
		return;
	}
	if (tries <= 0) return;
	const timer = setTimeout(() => whenBridge(fn, tries - 1), 250);
	teardown.push(() => clearTimeout(timer));
}

whenBridge((bridge) => {
	try {
		const off = bridge.onUiAction?.("wallpaper-engine:toggle", () => {
			drawer.toggle();
		});
		if (typeof off === "function") teardown.push(off);
	} catch {}
	try {
		const off = bridge.shortcuts?.register?.("ctrl+alt+w", () => {
			drawer.toggle();
		});
		if (typeof off === "function") teardown.push(off);
	} catch {}
});

function onInteractiveWheel(e) {
	if (!state.settings?.interactive || !state.activeId) return;

	const target = e.target;
	if (
		target &&
		target.closest &&
		target.closest(
			".pi-we-drawer, .pi-we-inspector-dialog, .panel, .dialog-inline, .modal, .modal-body, .menu, .dropdown-menu, .settings-modal, .msg, .msg-body, .inputbar, .terminal-pane, .xterm, textarea, input, select, pre",
		)
	) {
		return;
	}

	const messages = document.querySelector(".messages");
	if (messages) {
		let deltaY = e.deltaY;
		let deltaX = e.deltaX;
		if (e.deltaMode === 1) {
			deltaY *= 33;
			deltaX *= 33;
		} else if (e.deltaMode === 2) {
			deltaY *= 100;
			deltaX *= 100;
		}
		messages.scrollBy({
			top: deltaY,
			left: deltaX,
			behavior: "auto",
		});
	}
}
window.addEventListener("wheel", onInteractiveWheel, { passive: true });

globalThis[RUNTIME_KEY] = {
	drawer,
	bgLayer,
	state,
	toolInspector,
	destroy() {
		window.removeEventListener("wheel", onInteractiveWheel);
		stopToolInspector();
		toolInspector.destroy();
		for (const off of teardown.splice(0)) {
			try {
				off();
			} catch {}
		}
		if (autoRotateTimer) clearInterval(autoRotateTimer);
		audioEngine.stop();
		window.removeEventListener("pi-web-ui:theme-change", enforceThemeLock);
		document.removeEventListener("visibilitychange", onVisibilityChange);
		bgLayer.destroy();
		drawer.destroy();
	},
};

async function loadInitialState() {
	try {
		const res = await fetch(`${API_BASE}/api/active`);
		const json = await res.json();
		if (json.ok) {
			state.activeId = json.activeId || "";
			state.favorites = json.favorites || [];
			state.settings = { ...state.settings, ...(json.settings || {}) };
			drawer.syncSettings(state);
			if (state.settings.audioReactive) {
				audioEngine.start();
			}
			scheduleAutoRotate();

			if (json.activeWallpaper && json.activeWallpaper.id === state.activeId) {
				void bgLayer.setWallpaper(json.activeWallpaper, state.settings);
				if (json.activeWallpaper.type === "scene" || json.activeWallpaper.hasScene) {
					void loadWebWallGL();
				}
			}
		}
	} catch {}

	if (typeof window !== "undefined" && "requestIdleCallback" in window) {
		window.requestIdleCallback(() => void loadWebWallGL(), { timeout: 3000 });
	} else {
		setTimeout(() => void loadWebWallGL(), 1500);
	}
}

void loadInitialState();
