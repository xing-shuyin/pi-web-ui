/**
 * wallpaper-engine 客户端入口 (v0.3.13) —— 视频/WebGL2 Scene/Web 全能渲染、多套专属主题热切换、音频联动与自动轮播。
 */
import { DRAWER_CSS, getGlassThemeCss } from "./styles.mjs?v=0.3.65";
import { esc as escapeHtml } from "@pi-web-ui/plugin-sdk/client";

const RUNTIME_KEY = "__piWallpaperEngineRuntime";

/** 从 bundle 自己的 URL 推 API 前缀：<base>/plugins/wallpaper-engine/client/entry.mjs → <base>/plugins-api/wallpaper-engine */
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

// ------------------------------------------------------------ 清理上一轮实例（可重入保护）
const prev = globalThis[RUNTIME_KEY];
if (prev?.destroy) {
	try {
		prev.destroy();
	} catch (err) {
		console.warn("[wallpaper-engine] 清理上一轮实例失败：", err);
	}
}

// ------------------------------------------------------------ 样式注入
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

// ------------------------------------------------------------ WebWallGL 引擎动态载入（本地离线优先 + CDN 自动降级）
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

	// 1. 优先加载本地自带的离线包（零外网请求、零延迟、防 404 导致降级模糊）
	try {
		await loadScript(`${CLIENT_BASE}/vendor/webwallgl.js`);
		if (globalThis.WebWallGL && typeof globalThis.WebWallGL.mount === "function") {
			webwallglModule = globalThis.WebWallGL;
			return webwallglModule;
		}
	} catch {
		/* ignore local fail, try cdn */
	}

	// 2. 回退：esm.sh 自包含打包版本
	try {
		const mod = await import("https://esm.sh/webwallgl@3.0.0?bundle");
		if (mod && (typeof mod.mount === "function" || mod.default?.mount)) {
			webwallglModule = typeof mod.mount === "function" ? mod : mod.default;
			return webwallglModule;
		}
	} catch {
		/* ignore */
	}

	// 3. 回退：unpkg 全局 UMD 脚本
	try {
		await loadScript("https://unpkg.com/webwallgl@3.0.0");
		if (globalThis.WebWallGL && typeof globalThis.WebWallGL.mount === "function") {
			webwallglModule = globalThis.WebWallGL;
			return webwallglModule;
		}
	} catch (err) {
		console.warn("[wallpaper-engine] WebWallGL 模块加载失败，将自动降级为静态预览：", err);
	}

	return null;
}

// ------------------------------------------------------------ 音频响应律动模拟与采集
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
		// 动态声学频谱波形模拟（高频平滑渐变与律动震荡）
		const time = Date.now() * 0.003;
		for (let i = 0; i < 64; i++) {
			const wave1 = Math.sin(time + i * 0.25) * 0.5 + 0.5;
			const wave2 = Math.cos(time * 0.7 - i * 0.15) * 0.5 + 0.5;
			const val = Math.min(1.0, Math.max(0.0, wave1 * 0.6 + wave2 * 0.4));
			spectrum[i] = val;
			spectrumArray[i] = val;
		}

		// 注入至 Web 网页壁纸与 Scene 场景壁纸（复用固定数组，杜绝每帧 GC 压力）
		if (typeof window.__weAudioCb === "function") {
			try {
				window.__weAudioCb(spectrumArray);
			} catch {
				/* ignore */
			}
		}

		try {
			const layer = typeof getBgLayer === "function" ? getBgLayer() : null;
			layer?.dispatchAudio?.(spectrumArray);
		} catch {
			/* ignore */
		}

		rafId = requestAnimationFrame(tick);
	}

	return { start, stop };
}

// ------------------------------------------------------------ 专属黑曜冷月壁纸主题锁定机制
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
	} catch {
		/* ignore */
	}
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
	} catch {
		/* ignore */
	}
}

// 守卫：只要壁纸处于激活状态，任何尝试切换其他主题的行为自动锁定修正回当前选定的壁纸专属主题
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
	} catch {
		/* ignore */
	}
}

window.addEventListener("pi-web-ui:theme-change", enforceThemeLock);
window.addEventListener("storage", (e) => {
	if (e.key === "pi-web-ui:theme") enforceThemeLock();
});

// ------------------------------------------------------------ 场景画质档位与智能性能配置
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

// ------------------------------------------------------------ 背景播放层管理
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
			} catch {
				/* ignore */
			}
		}
		if (el instanceof HTMLVideoElement) {
			try {
				el.pause();
				el.removeAttribute("src");
				el.load();
			} catch {
				/* ignore */
			}
		}
		try {
			el?.remove();
		} catch {
			/* ignore */
		}
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

		// 自动且只能使用专属主题
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

		// 只有在冷启动（当前没有任何壁纸在播放）时，才需要一张海报做瞬时垫底；
		// 若当前已有壁纸在播放，旧的高清壁纸继续保持渲染过渡，绝不中途插入低清糊图！
		const isColdStart = !currentMediaEl;
		let coldPoster = null;
		if (isColdStart) {
			coldPoster = document.createElement("img");
			coldPoster.className = "pi-we-poster";
			coldPoster.src = `${API_BASE}/api/preview?id=${encodeURIComponent(item.id)}`;
			container.appendChild(coldPoster);
		}

		// 保存旧媒体的引用，待新媒体准备好后再平滑销毁（无缝双缓冲过渡）
		const oldMediaEl = currentMediaEl;
		const oldSceneInst = currentSceneInstance;
		const oldResizeHandler = currentSceneResizeHandler;

		// 标记媒体就绪并淡入激活
		function markReady(newMediaEl, newSceneInst, newResizeHandler) {
			if (epoch !== currentLoadEpoch) {
				// 已被后续切换作废，清理新创建的资源
				safeDestroyMedia(newMediaEl, newSceneInst, newResizeHandler);
				coldPoster?.remove();
				return false;
			}
			newMediaEl.classList.add("pi-we-ready");
			currentMediaEl = newMediaEl;
			currentSceneInstance = newSceneInst || null;
			currentSceneResizeHandler = newResizeHandler || null;

			// 旧媒体与冷启动海报延时 350ms 平滑移除，保证交叉淡入动画无缝完成
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

		// 1. 视频壁纸播放（硬件直通与原生无损分辨率）
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
			// 兜底：如果 400ms 内因浏览器策略未触发 oncanplay，强制淡入显示
			setTimeout(() => {
				if (epoch === currentLoadEpoch && !activated) activateVideo();
			}, 400);
			return;
		}

		// 2. Scene 场景壁纸（原生全量支持打包的 scene.pkg 与官方内置/松散 scene.json 散装工程）
		if (item.type === "scene" || item.hasScene) {
			const mountEl = document.createElement("div");
			mountEl.className = "pi-we-scene-mount";
			container.appendChild(mountEl);

			try {
				const pkgUrl = `${API_BASE}/api/pkg?id=${encodeURIComponent(item.id)}`;
				const shouldTryPkg = Boolean(item.hasPkg) || (!item.isLooseScene && item.hasPkg !== false);

				// 完全并行流水线：并发拉取 WebGL 引擎、工程配置与 scene.pkg 二进制流，消除串行瀑布
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
				if (!engine) throw new Error("WebWallGL 引擎未就绪");

				const projectJson = projectRes && projectRes.ok ? await projectRes.json().catch(() => null) : null;
				let source = null;

				// 1. 对于打包版壁纸，优先尝试构建 bytesSource
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

				// 2. 散装 scene.json 工程处理
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

				// 场景渲染挂载完成，平滑淡入激活！
				markReady(mountEl, sceneInstance, resizeHandler);
				return;
			} catch (err) {
				console.warn("[wallpaper-engine] Scene 壁纸渲染失败，平滑保持海报预览：", err);
				mountEl.remove();
				return;
			}
		}

		// 3. Web 网页壁纸（沙箱 iframe 挂载，注入高清视口与音频权限）
		if (item.type === "web" || item.hasWeb) {
			const iframe = document.createElement("iframe");
			iframe.className = "pi-we-bg-media";
			const webFile = item.webFile || "index.html";
			iframe.src = `${API_BASE}/api/web?id=${encodeURIComponent(item.id)}&file=${encodeURIComponent(webFile)}`;
			// 网页壁纸在独立 sandbox origin 渲染（禁 same-origin），与响应头 CSP sandbox 双保险：
			// 壁纸脚本无法读取应用页面/存储/API。
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
				// onload 触发后延时 60ms 确保脚本完成首帧布局与渲染，然后丝滑淡入
				setTimeout(() => {
					if (epoch === currentLoadEpoch) activateWeb();
				}, 60);
			};

			container.appendChild(iframe);
			// 兜底：如果外部资源慢，最多 500ms 强制淡入，杜绝停滞
			setTimeout(() => {
				if (epoch === currentLoadEpoch && !activated) activateWeb();
			}, 500);
			return;
		}

		// 4. 静态图片或高清原图展示
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
			} catch {
				/* ignore */
			}
		}
	}

	function resume() {
		if (currentMediaEl instanceof HTMLVideoElement && currentMediaEl.paused) {
			currentMediaEl.play().catch(() => {});
		}
		if (currentSceneInstance && typeof currentSceneInstance.resume === "function") {
			try {
				currentSceneInstance.resume();
			} catch {
				/* ignore */
			}
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
			} catch {
				/* ignore */
			}
		}
	}

	function getCurrentItem() {
		return currentItem;
	}

	return { setWallpaper, pause, resume, setMuted, setInteractive, dispatchAudio, getCurrentItem, destroy };
}

// ------------------------------------------------------------ 壁纸库抽屉组件
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
	let displayMode = "paged"; // "paged" | "all"

	drawer.innerHTML = `
		<div class="pi-we-header">
			<h3 class="pi-we-title" title="Wallpaper Engine 壁纸库">🖼️ 壁纸库</h3>
			<div class="pi-we-header-actions">
				<button class="pi-we-icon-btn" id="pi-we-toggle-settings-btn" title="折叠/展开外观与渲染配置">⚙️ <span class="pi-we-btn-label">配置</span> <span id="pi-we-toggle-settings-arrow">▾</span></button>
				<button class="pi-we-icon-btn" id="pi-we-rescan-btn" title="重新扫描壁纸">🔄 <span class="pi-we-btn-label">刷新</span></button>
				<button class="pi-we-icon-btn pi-we-close-btn" id="pi-we-close-btn" title="关闭壁纸库">✕</button>
			</div>
		</div>

		<div class="pi-we-settings-bar">
			<div class="pi-we-slider-row">
				<span class="pi-we-slider-label">专属主题:</span>
				<select class="pi-we-select" id="pi-we-theme-select" style="flex: 1;">
					<option value="obsidian" ${state.settings.wallpaperTheme === "obsidian" || !state.settings.wallpaperTheme ? "selected" : ""}>🌑 黑曜冷月（纯黑极简微透）</option>
					<option value="flow" ${state.settings.wallpaperTheme === "flow" || state.settings.wallpaperTheme === "compact-flow" ? "selected" : ""}>🖋️ 极简行文（极致紧凑·无界正文）</option>
				</select>
			</div>
			<div class="pi-we-slider-row">
				<span class="pi-we-slider-label">毛玻璃模糊度:</span>
				<input type="range" id="pi-we-blur-range" min="0" max="32" value="${state.settings.glassBlur}" />
				<span class="pi-we-slider-val" id="pi-we-blur-val">${state.settings.glassBlur}px</span>
			</div>
			<div class="pi-we-slider-row">
				<span class="pi-we-slider-label">界面不透明度:</span>
				<input type="range" id="pi-we-opacity-range" min="0" max="100" value="${state.settings.glassOpacity}" />
				<span class="pi-we-slider-val" id="pi-we-opacity-val">${state.settings.glassOpacity}%</span>
			</div>
			<div class="pi-we-slider-row">
				<span class="pi-we-slider-label">自动轮播:</span>
				<select class="pi-we-select" id="pi-we-rotate-select">
					<option value="0" ${state.settings.autoRotateMinutes === "0" ? "selected" : ""}>关闭轮播</option>
					<option value="5" ${state.settings.autoRotateMinutes === "5" ? "selected" : ""}>每 5 分钟</option>
					<option value="15" ${state.settings.autoRotateMinutes === "15" ? "selected" : ""}>每 15 分钟</option>
					<option value="30" ${state.settings.autoRotateMinutes === "30" ? "selected" : ""}>每 30 分钟</option>
					<option value="60" ${state.settings.autoRotateMinutes === "60" ? "selected" : ""}>每 1 小时</option>
				</select>
				<span class="pi-we-slider-label" style="width: auto; margin-left: 8px;">帧率:</span>
				<select class="pi-we-select" id="pi-we-fps-select">
					<option value="30" ${state.settings.fpsLimit === "30" ? "selected" : ""}>30 FPS</option>
					<option value="60" ${state.settings.fpsLimit === "60" ? "selected" : ""}>60 FPS</option>
					<option value="0" ${state.settings.fpsLimit === "0" || !state.settings.fpsLimit ? "selected" : ""}>无限制</option>
				</select>
			</div>
			<div class="pi-we-slider-row">
				<span class="pi-we-slider-label">场景画质:</span>
				<select class="pi-we-select" id="pi-we-quality-select" style="flex: 1;">
					<option value="performance" ${state.settings.qualityPreset === "performance" || !state.settings.qualityPreset ? "selected" : ""}>⚡ 节能极速（核显推荐）</option>
					<option value="balanced" ${state.settings.qualityPreset === "balanced" ? "selected" : ""}>⚖️ 平衡流畅（默认推荐）</option>
					<option value="high" ${state.settings.qualityPreset === "high" ? "selected" : ""}>🎨 高清细腻（独显）</option>
					<option value="ultra" ${state.settings.qualityPreset === "ultra" ? "selected" : ""}>🌟 极致视网膜</option>
				</select>
				<span class="pi-we-slider-label" style="width: auto; margin-left: 8px;">抗锯齿:</span>
				<select class="pi-we-select" id="pi-we-aa-select">
					<option value="off" ${state.settings.antiAliasing === "off" || !state.settings.antiAliasing ? "selected" : ""}>关闭</option>
					<option value="fxaa" ${state.settings.antiAliasing === "fxaa" ? "selected" : ""}>FXAA 快速</option>
					<option value="msaa2" ${state.settings.antiAliasing === "msaa2" ? "selected" : ""}>MSAA 2x</option>
					<option value="msaa4" ${state.settings.antiAliasing === "msaa4" ? "selected" : ""}>MSAA 4x</option>
				</select>
			</div>
			<div class="pi-we-slider-row" style="justify-content: flex-start; gap: 14px;">
				<label class="pi-we-checkbox-row">
					<input type="checkbox" id="pi-we-interactive-check" ${state.settings.interactive ? "checked" : ""} />
					<span>允许交互</span>
				</label>
				<label class="pi-we-checkbox-row">
					<input type="checkbox" id="pi-we-audio-check" ${state.settings.audioReactive ? "checked" : ""} />
					<span>音乐频谱 🎵</span>
				</label>
				<label class="pi-we-checkbox-row" title="在纯白、日光或高光壁纸下启用微描边锐化与微偏光，保证白字清晰易读">
					<input type="checkbox" id="pi-we-lightmode-check" ${state.settings.lightWallpaperMode ? "checked" : ""} />
					<span>☀️ 亮色增强</span>
				</label>
				<label class="pi-we-checkbox-row">
					<input type="checkbox" id="pi-we-mute-check" ${state.settings.muteAudio ? "checked" : ""} />
					<span>静音</span>
				</label>
				<button class="pi-we-icon-btn" id="pi-we-clear-btn" style="margin-left: auto;">关闭壁纸</button>
			</div>
			<div class="pi-we-preset-row">
				<button class="pi-we-icon-btn" id="pi-we-export-btn">📤 导出预设</button>
				<button class="pi-we-icon-btn" id="pi-we-import-btn">📥 导入预设</button>
				<button class="pi-we-icon-btn" id="pi-we-rotate-now-btn" style="margin-left: auto;" title="立即随机切换下一张壁纸">🎲 切下一张</button>
			</div>
		</div>

		<div class="pi-we-filter-bar">
			<input type="text" class="pi-we-search-input" id="pi-we-search" placeholder="搜索壁纸名称或标签..." />
			<div class="pi-we-tabs">
				<button class="pi-we-tab active" data-tab="all">全部</button>
				<button class="pi-we-tab" data-tab="fav">⭐ 收藏</button>
				<button class="pi-we-tab" data-tab="video">视频</button>
				<button class="pi-we-tab" data-tab="scene">场景</button>
				<button class="pi-we-tab" data-tab="web">网页</button>
				<button class="pi-we-tab" data-tab="image">静态图</button>
				<button class="pi-we-mode-btn" id="pi-we-mode-btn" title="点击切换分页浏览与全部显示模式">📑 分页模式</button>
			</div>
		</div>

		<div class="pi-we-body" id="pi-we-grid">
			<div class="pi-we-empty">
				<span>正在加载壁纸...</span>
			</div>
		</div>

		<div class="pi-we-pagination" id="pi-we-pagination" style="display: none;">
			<div class="pi-we-page-info">
				<span id="pi-we-page-stats">共 0 张</span>
			</div>
			<div class="pi-we-page-nav">
				<button class="pi-we-page-btn" id="pi-we-page-prev" title="上一页" disabled>◀ 上一页</button>
				<div class="pi-we-page-numbers" id="pi-we-page-numbers"></div>
				<button class="pi-we-page-btn" id="pi-we-page-next" title="下一页" disabled>下一页 ▶</button>
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
			// 瞬时呈现已缓存的壁纸列表，零等待！
			renderGrid();
			// 后台静默刷新最新数据
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

	// 导出预设
	drawer.querySelector("#pi-we-export-btn").addEventListener("click", async () => {
		try {
			const res = await fetch(`${API_BASE}/api/presets`);
			const json = await res.json();
			const text = JSON.stringify(json, null, 2);
			if (navigator.clipboard) {
				await navigator.clipboard.writeText(text);
				alert("外观预设已成功复制到剪贴板！");
			} else {
				prompt("请复制外观预设 JSON：", text);
			}
		} catch (err) {
			alert(`导出失败：${err.message}`);
		}
	});

	// 导入预设
	drawer.querySelector("#pi-we-import-btn").addEventListener("click", async () => {
		const input = prompt("请粘贴外观预设 JSON 内容：");
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
				alert("外观预设导入成功！");
			}
		} catch (err) {
			alert(`导入失败：${err.message}`);
		}
	});

	const settingsBar = drawer.querySelector(".pi-we-settings-bar");
	const toggleSettingsBtn = drawer.querySelector("#pi-we-toggle-settings-btn");
	const toggleSettingsArrow = drawer.querySelector("#pi-we-toggle-settings-arrow");

	// 配置项支持优雅折叠：默认在小屏幕下折叠以给壁纸列表最大的纵向可视浏览空间
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
		} catch {
			/* ignore */
		}
	});

	drawer.querySelector("#pi-we-rescan-btn").addEventListener("click", async () => {
		currentPage = 1;
		gridEl.innerHTML = `<div class="pi-we-empty"><span>正在全盘重新扫描...</span></div>`;
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
			gridEl.innerHTML = `<div class="pi-we-empty"><span>扫描失败：${err.message}</span></div>`;
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
			modeBtn.textContent = displayMode === "paged" ? "📑 分页模式" : "📜 全部显示";
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
				pageStatsEl.textContent = `共 ${totalCount} 张 · 已全部展示 (点击顶栏切回分页)`;
			}
			if (pagePrevBtn) pagePrevBtn.disabled = true;
			if (pageNextBtn) pageNextBtn.disabled = true;
			if (pageNumbersEl) pageNumbersEl.innerHTML = "";
			return;
		}

		if (pageStatsEl) {
			pageStatsEl.textContent = `共 ${totalCount} 张 · 第 ${curPage}/${totalPages} 页`;
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
			gridEl.innerHTML = `<div class="pi-we-empty"><span>正在加载壁纸...</span></div>`;
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
						<span>未检测到 Steam 或创意工坊壁纸</span>
						<span class="pi-we-empty-sub">请确认已安装 Steam 并订阅了 Wallpaper Engine 壁纸，或在插件设置中指定自定义路径。</span>
					</div>
				`;
				updatePagination(0, 1, 1);
			}
		} catch (err) {
			if (!silent) {
				gridEl.innerHTML = `<div class="pi-we-empty"><span>加载失败：${err.message}</span></div>`;
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
					<span>未找到匹配的壁纸</span>
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
					${isActive ? `<span class="pi-we-active-indicator">✓ 使用中</span>` : ""}
				</div>
				<div class="pi-we-card-info pi-we-card-meta-bar">
					<div class="pi-we-card-title" title="${w.title}">${w.title}</div>
					<div class="pi-we-card-meta">
						<span>${w.rating || "Everyone"}</span>
						<button class="pi-we-fav-btn ${isFav ? "active" : ""}" title="${isFav ? "取消收藏" : "加入收藏"}">${isFav ? "★" : "☆"}</button>
					</div>
				</div>
			`;

			// 收藏按钮点击事件（阻止卡片点击冒泡）
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
				} catch {
					/* ignore */
				}
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

// ------------------------------------------------------------ 工具调用与思考流详情检查器（Inline Code Pill Inspector）
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
				<div class="pi-we-inspector-title" id="pi-we-ins-title">工具详情</div>
				<div class="pi-we-inspector-badge" id="pi-we-ins-badge">已完成</div>
			</div>
			<div class="pi-we-inspector-actions">
				<button type="button" class="pi-we-inspector-btn" id="pi-we-ins-toggle-btn" style="display:none;">⚙️ 原始参数</button>
				<button type="button" class="pi-we-inspector-btn" id="pi-we-ins-copy-btn">📋 复制全部</button>
				<button type="button" class="pi-we-inspector-btn pi-we-inspector-close" id="pi-we-ins-close-btn" title="关闭 (ESC)">✕</button>
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
	let currentMode = "preview"; // "preview" | "raw"

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
					<div class="pi-we-inspector-label">⚡ 调用入参 / 命令 (Arguments)</div>
					<pre class="pi-we-inspector-codeblock" id="pi-we-ins-args-pre"></pre>
				</div>
			`;
		}
		if (images && images.length > 0) {
			sectionsHtml += `
				<div class="pi-we-inspector-section">
					<div class="pi-we-inspector-label">🖼️ 工具输出图片 (${images.length})</div>
					<div class="pi-we-inspector-images" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;">
						${images.map((src, i) => `<img src="${src}" style="max-height:240px;max-width:100%;border-radius:6px;border:1px solid rgba(255,255,255,0.14);" alt="image ${i + 1}" />`).join("")}
					</div>
				</div>
			`;
		}
		sectionsHtml += `
			<div class="pi-we-inspector-section">
				<div class="pi-we-inspector-label">${error ? "❌ 执行报错 (Error Output)" : "📄 执行输出 (Output)"}</div>
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
			outPre.textContent =
				displayOutput || (statusClass === "run" ? "正在执行中，等待实时输出..." : "(执行成功，无文本返回)");
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
							<a href="${fileUrl}&download=1" class="pi-we-ins-btn-sm" title="下载文件" download="${escapeHtml(fileName)}">⬇️ 下载</a>
							<button type="button" class="pi-we-ins-btn-sm pi-we-ins-copy-path" data-path="${escapeHtml(item.path)}" title="复制相对路径">📋 路径</button>
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
					<div class="pi-we-inspector-label">❌ 执行报错 (Error Output)</div>
					<pre class="pi-we-inspector-codeblock">${escapeHtml(output)}</pre>
				</div>
			`;
		}

		html += `</div>`;
		bodyEl.innerHTML = html;

		// 绑定复制路径事件
		bodyEl.querySelectorAll(".pi-we-ins-copy-path").forEach((btn) => {
			btn.addEventListener("click", () => {
				const p = btn.getAttribute("data-path");
				if (p) {
					void navigator.clipboard?.writeText?.(p);
					const orig = btn.textContent;
					btn.textContent = "✓ 已复制";
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
			titleEl.textContent = "思考过程 (Thinking)";
			badgeEl.textContent = duration || "已完成";
			badgeEl.className = "pi-we-inspector-badge ok";

			bodyEl.innerHTML = `
				<div class="pi-we-inspector-section">
					<div class="pi-we-inspector-label">💭 思考链路与分析过程</div>
					<div class="pi-we-inspector-thinking-text"></div>
				</div>
			`;
			const textEl = bodyEl.querySelector(".pi-we-inspector-thinking-text");
			if (textEl) textEl.textContent = output || "(暂无思考文本)";
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
			badgeEl.textContent = duration ? `${status || "完成"} · ${duration}` : status || "完成";

			const presentData = name === "present_files" || args?.includes('"items"') ? tryParsePresentArgs(args) : null;

			if (presentData) {
				// 支持切换展示视图与原有视图
				toggleBtn.style.display = "inline-flex";
				currentMode = "preview";
				toggleBtn.textContent = "⚙️ 原始参数";
				toggleBtn.title = "点击切换回原有代码块展示";
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
			toggleBtn.textContent = "🖼️ 文件展示";
			toggleBtn.title = "点击切换回富媒体文件展示";
			renderRawView(currentData);
		} else {
			currentMode = "preview";
			toggleBtn.textContent = "⚙️ 原始参数";
			toggleBtn.title = "点击切换回原有代码块展示";
			renderPreviewView(presentData, currentData);
		}
	});

	copyBtn.addEventListener("click", () => {
		if (currentCopyText) {
			void navigator.clipboard?.writeText?.(currentCopyText);
			const orig = copyBtn.textContent;
			copyBtn.textContent = "✓ 已复制";
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

		// 豁免：如果点击了关闭/中断 bash 按钮或图片缩略图，不拦截，保证原生交互与大图灯箱有效
		if (e.target.closest(".toolcall-kill, .toolcall-open, button.toolcall-image, .toolcall-image")) {
			return;
		}

		// 拦截默认原地展开
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
				status: statusTitle || (isError ? "执行出错" : isRun ? "运行中" : "已完成"),
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

// ------------------------------------------------------------ 运行时主流程（同步初始化 + 异步非阻塞加载）
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

// 轮播触发器
function triggerRotate() {
	const pool = drawer.getWallpapers();
	if (!pool.length) return;
	const candList = state.favorites.length ? pool.filter((w) => state.favorites.includes(w.id)) : pool;
	const candidates = candList.length ? candList : pool;
	if (!candidates.length) return;

	// 选取下一张（若当前在列表里则取下一个，否则随机取）
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

// 自动轮播定时器调度
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

// 同步创建抽屉面板（确保 UI 结构与事件监听立即就绪）
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

// ------------------------------------------------------------ 宿主动作桥（模块顶层同步注册，锁定作用域）
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

// 模块求值阶段直接执行，确保 registerPluginTopbarAction 在当前 pluginScope 下执行
whenBridge((bridge) => {
	try {
		const off = bridge.onUiAction?.("wallpaper-engine:toggle", () => {
			drawer.toggle();
		});
		if (typeof off === "function") teardown.push(off);
	} catch {
		/* ignore */
	}
	// 快捷键支持：Ctrl/Cmd+Alt+W 唤起壁纸抽屉
	try {
		const off = bridge.shortcuts?.register?.("ctrl+alt+w", () => {
			drawer.toggle();
		});
		if (typeof off === "function") teardown.push(off);
	} catch {
		/* ignore */
	}
});

// ------------------------------------------------------------ 交互模式穿透滚轮转发
// 当用户在动态壁纸中开启了「允许交互」时，.messages 会被设为 pointer-events: none 以便让鼠标
// 事件穿透到底层动态场景；此时若在两侧空白区域滚动滚轮，事件落到了底层穿透层，原生无法滚动消息区。
// 此处监听 wheel 并智能转发给当前活动的聊天滚动容器（.messages），兼顾粒子交互与自由滚动。
function onInteractiveWheel(e) {
	if (!state.settings?.interactive || !state.activeId) return;

	const target = e.target;
	// 如果事件目标本身在某个正常接收鼠标事件的 UI 部件或内部滚动区中，由其自身处理
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

// 注册当前运行时（支持热重载与实例清理）
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
			} catch {
				/* ignore */
			}
		}
		if (autoRotateTimer) clearInterval(autoRotateTimer);
		audioEngine.stop();
		window.removeEventListener("pi-web-ui:theme-change", enforceThemeLock);
		document.removeEventListener("visibilitychange", onVisibilityChange);
		bgLayer.destroy();
		drawer.destroy();
	},
};

// ------------------------------------------------------------ 异步拉取激活状态与壁纸（极速秒开起播）
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

			// 极速起播：若 /api/active 已直出激活壁纸的完整元数据，立即开播，彻底消除串行等待！
			if (json.activeWallpaper && json.activeWallpaper.id === state.activeId) {
				void bgLayer.setWallpaper(json.activeWallpaper, state.settings);
				if (json.activeWallpaper.type === "scene" || json.activeWallpaper.hasScene) {
					void loadWebWallGL();
				}
			}
		}
	} catch {
		/* ignore */
	}

	// 闲时后台静默预热 WebWallGL 运行时引擎
	if (typeof window !== "undefined" && "requestIdleCallback" in window) {
		window.requestIdleCallback(() => void loadWebWallGL(), { timeout: 3000 });
	} else {
		setTimeout(() => void loadWebWallGL(), 1500);
	}
}

void loadInitialState();
