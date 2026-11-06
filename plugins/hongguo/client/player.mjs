/** Native pi-web-ui player. The video element stays mounted across layout changes. */
const revision = new URL(import.meta.url).search;
const [{ css }, stateTools] = await Promise.all([import(`./styles.mjs${revision}`), import(`./state.mjs${revision}`)]);
const {
	PREFS_KEY,
	HISTORY_KEY,
	readStored,
	writeStored,
	layoutFor,
	resizeFloating,
	saveRecord,
	resumePosition,
	mergedRows,
} = stateTools;

const API = new URL("../../../plugins-api/hongguo/", import.meta.url);
const ICONS = {
	play: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 6 4-6 4Z"/>',
	close: '<path d="m6 6 12 12M6 18 18 6"/>',
	mini: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M13 13h6v5h-6z"/>',
	back: '<path d="m14 6-6 6 6 6"/>',
	search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
	person: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
	pip: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 12h7v6h-7z"/>',
};
function icon(name) {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	for (const [key, value] of Object.entries({
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		"stroke-width": "1.8",
		"stroke-linecap": "round",
		"stroke-linejoin": "round",
		"aria-hidden": "true",
	}))
		svg.setAttribute(key, value);
	svg.innerHTML = ICONS[name] ?? ICONS.play;
	return svg;
}
function el(tag, attrs = {}, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
		else if (key === "class") node.className = value;
		else if (key === "text") node.textContent = value;
		else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
	}
	for (const child of children.flat())
		if (child !== undefined && child !== null)
			node.append(typeof child === "string" ? document.createTextNode(child) : child);
	return node;
}
function button(label, action, options = {}) {
	return el("button", { type: "button", onclick: action, ...options }, label);
}

export function createPlayer(host, options = {}) {
	const storage =
		options.storage ??
		(() => {
			try {
				return localStorage;
			} catch {
				return { getItem() {}, setItem() {} };
			}
		})();
	const prefs = readStored(storage, PREFS_KEY, {});
	let history = readStored(storage, HISTORY_KEY, {});
	const state = {
		mode: prefs.mode === "split" ? "split" : "floating",
		open: false,
		mini: false,
		page: "library",
		tab: "recommend",
		items: [],
		query: "",
		searchType: "drama",
		actor: null,
		preloadState: "idle",
		cursor: "",
		hasMore: false,
		series: null,
		episodes: [],
		current: null,
		sources: [],
		source: null,
		busy: false,
	};
	const lifetime = new AbortController();
	const fetchImpl = options.fetch ?? fetch;
	let app,
		root,
		video,
		body,
		status,
		player,
		title,
		subtitle,
		overlay,
		controls,
		floatingButton,
		splitButton,
		miniButton;
	let lastFocus,
		observer,
		engine,
		gestureCleanup,
		listRequest,
		seriesRequest,
		playRequest,
		preloadRequest,
		preloadedFor;
	let destroyed = false,
		initialized = false,
		listLoaded = false,
		configLoaded = false,
		playVersion = 0,
		seriesVersion = 0,
		listVersion = 0,
		resumeAt = 0,
		lastSaved = 0;
	const previousPadding = new Map();
	const writtenPadding = new Map();
	const pendingScripts = new Map();
	const t = (zh, en) => (/^zh/i.test(host.getLocale?.() ?? document.documentElement.lang ?? "zh") ? zh : en);
	const savePrefs = () => {
		prefs.mode = state.mode;
		writeStored(storage, PREFS_KEY, prefs);
	};

	async function api(path, signal, { method = "GET", timeout = 60_000 } = {}) {
		const response = await fetchImpl(new URL(path, API), {
			method,
			credentials: "same-origin",
			signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]),
		});
		const data = await response.json();
		if (!response.ok || data.ok === false)
			throw new Error(data.error?.message ?? t("短剧服务暂时不可用", "Drama service unavailable"));
		return data;
	}
	function message(text = "", error = false) {
		if (status) {
			status.textContent = text;
			status.dataset.error = String(error);
		}
	}
	function padding(name, value) {
		if (!previousPadding.has(name))
			previousPadding.set(name, [app.style.getPropertyValue(name), app.style.getPropertyPriority(name)]);
		if (value) {
			const px = `${value}px`;
			app.style.setProperty(name, px);
			writtenPadding.set(name, px);
		} else if (writtenPadding.has(name)) {
			if (app.style.getPropertyValue(name) === writtenPadding.get(name)) {
				const [old, priority] = previousPadding.get(name);
				if (old) app.style.setProperty(name, old, priority);
				else app.style.removeProperty(name);
			}
			writtenPadding.delete(name);
		}
	}
	function windowPrefs() {
		return state.mini ? { ...prefs, compact: true, w: prefs.miniW, h: prefs.miniH } : { ...prefs, compact: false };
	}
	function layout() {
		if (!app || !root || destroyed) return;
		const rect = app.getBoundingClientRect();
		const box = layoutFor(
			state.mode,
			rect.width || window.innerWidth,
			rect.height || window.innerHeight,
			windowPrefs(),
		);
		root.classList.toggle("hg-split", state.mode === "split");
		root.classList.toggle("hg-vertical", box.axis === "y");
		root.classList.toggle("hg-mini", state.mini);
		Object.assign(root.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
		root.style.setProperty("--hg-video-height", `${Math.min(box.w * 0.625, box.h * 0.42)}px`);
		padding("padding-inline-end", state.open ? box.reserveRight : 0);
		padding("padding-block-end", state.open ? box.reserveBottom : 0);
		floatingButton.setAttribute("aria-pressed", String(state.mode === "floating"));
		splitButton.setAttribute("aria-pressed", String(state.mode === "split"));
		miniButton.disabled = state.mode === "split" || !state.current;
	}
	function setMode(mode) {
		gestureCleanup?.();
		state.mode = mode;
		if (mode === "split") state.mini = false;
		savePrefs();
		layout();
	}
	function startGesture(event, edge) {
		if (
			event.isPrimary === false ||
			event.button !== 0 ||
			(!edge && (state.mode === "split" || event.target.closest("button,input,select")))
		)
			return;
		const rect = app.getBoundingClientRect();
		const width = rect.width || window.innerWidth,
			height = rect.height || window.innerHeight;
		const box = layoutFor(state.mode, width, height, windowPrefs());
		if (state.mode === "split" && edge !== (box.axis === "x" ? "w" : "n")) return;
		event.preventDefault();
		event.stopPropagation();
		gestureCleanup?.();
		const owner = event.currentTarget;
		const startX = event.clientX,
			startY = event.clientY;
		let stopped = false;
		const move = (next) => {
			if (next.pointerId !== event.pointerId) return;
			const dx = next.clientX - startX,
				dy = next.clientY - startY;
			if (state.mode === "split") {
				if (box.axis === "x") prefs.splitWidth = box.w - dx;
				else prefs.splitHeight = box.h - dy;
			} else if (edge) {
				const resized = resizeFloating(box, edge, dx, dy, width, height, state.mini);
				prefs.x = resized.x;
				prefs.y = resized.y;
				if (state.mini) {
					prefs.miniW = resized.w;
					prefs.miniH = resized.h;
				} else {
					prefs.w = resized.w;
					prefs.h = resized.h;
				}
			} else {
				const moved = layoutFor("floating", width, height, { ...windowPrefs(), x: box.x + dx, y: box.y + dy });
				prefs.x = moved.x;
				prefs.y = moved.y;
			}
			layout();
		};
		const stop = (next) => {
			if (stopped || (next?.pointerId != null && next.pointerId !== event.pointerId)) return;
			stopped = true;
			window.removeEventListener("pointermove", move, true);
			window.removeEventListener("pointerup", stop, true);
			window.removeEventListener("pointercancel", stop, true);
			window.removeEventListener("blur", stop);
			owner.removeEventListener("lostpointercapture", stop);
			try {
				if (owner.hasPointerCapture?.(event.pointerId)) owner.releasePointerCapture(event.pointerId);
			} catch {
				/* capture can already be lost on close */
			}
			root.classList.remove("hg-dragging");
			gestureCleanup = null;
			savePrefs();
		};
		window.addEventListener("pointermove", move, true);
		window.addEventListener("pointerup", stop, true);
		window.addEventListener("pointercancel", stop, true);
		window.addEventListener("blur", stop);
		owner.addEventListener("lostpointercapture", stop);
		try {
			owner.setPointerCapture?.(event.pointerId);
		} catch {
			/* synthetic events may have no active pointer */
		}
		root.classList.add("hg-dragging");
		gestureCleanup = () => stop();
	}

	function saveProgress() {
		if (!video || !state.current || !state.series || !state.source || !video.readyState) return;
		history = saveRecord(history, state.series, state.current, video.currentTime, video.duration);
		writeStored(storage, HISTORY_KEY, history);
	}
	function stopPreload() {
		preloadRequest?.abort();
		preloadRequest = null;
		preloadedFor = null;
		state.preloadState = "idle";
	}
	async function prepareNext() {
		if (destroyed || !state.open || !state.source || prefs.preloadNext === false) return;
		const index = state.episodes.findIndex((episode) => episode.id === state.current?.id);
		const next = state.episodes[index + 1];
		if (index < 0 || !next || next.playable === false || preloadedFor === next.id) return;
		stopPreload();
		preloadedFor = next.id;
		preloadRequest = new AbortController();
		const request = preloadRequest;
		const version = playVersion;
		state.preloadState = "loading";
		renderControls();
		try {
			const data = await api(`preload?episode=${encodeURIComponent(next.id)}`, request.signal, {
				method: "POST",
				timeout: 360_000,
			});
			if (version !== playVersion || destroyed || !state.open || request !== preloadRequest) return;
			state.preloadState = data.ready ? "ready" : "idle";
		} catch (error) {
			if (version !== playVersion || destroyed || request !== preloadRequest || error.name === "AbortError") return;
			state.preloadState = "idle";
		} finally {
			if (version === playVersion && !destroyed && state.open && request === preloadRequest) renderControls();
		}
	}
	function clearSource() {
		stopPreload();
		state.source = null;
		engine?.destroy?.();
		engine?.reset?.();
		engine = null;
		if (video) {
			video.pause();
			video.removeAttribute("src");
			video.load();
		}
	}
	async function pip() {
		try {
			if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
			else if (video.requestPictureInPicture) await video.requestPictureInPicture();
			else if (video.webkitSetPresentationMode) video.webkitSetPresentationMode("picture-in-picture");
			else message(t("当前浏览器不支持画中画，请使用悬浮模式", "Picture-in-picture is unavailable; use floating mode"));
		} catch {
			message(t("视频加载后再尝试画中画", "Try picture-in-picture after the video loads"));
		}
	}
	function init() {
		if (initialized || destroyed) return initialized;
		app = host.dom?.anchors?.().app;
		if (!app) return false;
		root = el("section", { class: "hg-root", "aria-label": t("hongguo 播放器", "hongguo player"), hidden: "" });
		root.append(el("style", { text: css }));
		floatingButton = button(t("悬浮", "Float"), () => setMode("floating"), { "aria-pressed": "false" });
		splitButton = button(t("分屏", "Split"), () => setMode("split"), { "aria-pressed": "false" });
		miniButton = button(
			icon("mini"),
			() => {
				state.mini = !state.mini;
				layout();
			},
			{ class: "hg-icon", title: t("精简播放器", "Compact player"), "aria-label": t("精简播放器", "Compact player") },
		);
		const head = el(
			"header",
			{ class: "hg-head", onpointerdown: (event) => startGesture(event) },
			el(
				"div",
				{ class: "hg-brand" },
				icon("play"),
				t("红果", "Drama"),
				el("span", { class: "hg-label" }, t("短剧放映室", "HONGGUO")),
			),
			el(
				"div",
				{ class: "hg-modes", role: "group", "aria-label": t("播放布局", "Player layout") },
				floatingButton,
				splitButton,
			),
			miniButton,
			button(icon("close"), close, {
				class: "hg-icon",
				title: t("关闭并暂停", "Close and pause"),
				"aria-label": t("关闭并暂停", "Close and pause"),
			}),
		);
		video = el("video", {
			controls: "",
			playsinline: "",
			preload: "metadata",
			"aria-label": t("短剧视频", "Drama video"),
		});
		video.volume = Math.max(0, Math.min(1, Number.isFinite(prefs.volume) ? prefs.volume : 0.8));
		video.playbackRate = [0.75, 1, 1.25, 1.5, 2].includes(prefs.speed) ? prefs.speed : 1;
		overlay = el("div", { class: "hg-screen-overlay", role: "status" });
		title = el("div", { class: "hg-title" });
		subtitle = el("div", { class: "hg-subtle" });
		controls = el("div", { class: "hg-controls" });
		player = el(
			"div",
			{ class: "hg-player", hidden: "" },
			el("div", { class: "hg-screen" }, video, overlay),
			el("div", { class: "hg-playing-title" }, title, subtitle),
			controls,
		);
		body = el("div", { class: "hg-body" });
		status = el("div", { class: "hg-status", role: "status", "aria-live": "polite" });
		root.append(
			head,
			player,
			body,
			status,
			...["n", "e", "s", "w", "ne", "se", "sw", "nw"].map((edge) =>
				el("div", {
					class: `hg-resize hg-resize-${edge}`,
					"data-edge": edge,
					onpointerdown: (event) => startGesture(event, edge),
					title: t("拖动边缘调整大小", "Drag an edge to resize"),
				}),
			),
		);
		app.append(root);
		video.addEventListener("loadedmetadata", () => {
			if (resumeAt > 0) {
				video.currentTime = Math.min(resumeAt, Math.max(0, video.duration - 1)) || resumeAt;
				resumeAt = 0;
			}
		});
		video.addEventListener("playing", () => {
			overlay.textContent = "";
			message();
			void prepareNext();
		});
		video.addEventListener("waiting", () => {
			if (state.source) overlay.textContent = t("正在缓冲…", "Buffering…");
		});
		video.addEventListener("pause", saveProgress);
		video.addEventListener("timeupdate", () => {
			if (Math.abs(video.currentTime - lastSaved) > 4) {
				lastSaved = video.currentTime;
				saveProgress();
			}
		});
		video.addEventListener("volumechange", () => {
			prefs.volume = video.volume;
			savePrefs();
		});
		video.addEventListener("ended", () => {
			saveProgress();
			if (prefs.autoNext !== false && state.open) adjacent(1);
		});
		video.addEventListener("error", () => {
			if (state.source) {
				overlay.textContent = "";
				message(
					t(
						"视频加载失败，请重试或检查网络与 FFmpeg。",
						"Video failed to load. Retry or check the network and FFmpeg.",
					),
					true,
				);
				renderControls();
			}
		});
		window.addEventListener("resize", layout);
		window.addEventListener("pagehide", saveProgress);
		observer = typeof ResizeObserver === "function" ? new ResizeObserver(layout) : null;
		observer?.observe(app);
		initialized = true;
		return true;
	}
	function renderControls() {
		if (!controls) return;
		const index = state.episodes.findIndex((row) => row.id === state.current?.id);
		const prev = button(t("上一集", "Previous"), () => adjacent(-1));
		prev.disabled = index <= 0;
		const next = button(t("下一集", "Next"), () => adjacent(1));
		next.disabled = index < 0 || index >= state.episodes.length - 1;
		const speed = el(
			"select",
			{
				"aria-label": t("播放速度", "Playback speed"),
				onchange: (event) => {
					prefs.speed = Number(event.target.value);
					video.playbackRate = prefs.speed;
					savePrefs();
				},
			},
			[0.75, 1, 1.25, 1.5, 2].map((rate) => el("option", { value: rate }, `${rate}×`)),
		);
		speed.value = String(video.playbackRate);
		const auto = el("input", {
			type: "checkbox",
			onchange: (event) => {
				prefs.autoNext = event.target.checked;
				savePrefs();
			},
		});
		auto.checked = prefs.autoNext !== false;
		const items = [
			prev,
			next,
			speed,
			button(icon("pip"), pip, {
				title: t("系统画中画", "System picture-in-picture"),
				"aria-label": t("系统画中画", "System picture-in-picture"),
			}),
		];
		if (state.sources.length > 1) {
			const sources = el(
				"select",
				{
					"aria-label": t("播放线路", "Video source"),
					onchange: (event) => play(state.current, video.currentTime, Number(event.target.value)),
				},
				state.sources.map((source, i) => el("option", { value: i }, source.definition || `${source.kind} ${i + 1}`)),
			);
			sources.value = String(state.sources.indexOf(state.source));
			items.push(sources);
		}
		const preload = el("input", {
			type: "checkbox",
			onchange: (event) => {
				prefs.preloadNext = event.target.checked;
				savePrefs();
				if (prefs.preloadNext) void prepareNext();
				else {
					stopPreload();
					renderControls();
				}
			},
		});
		preload.checked = prefs.preloadNext !== false;
		items.push(
			button(t("重试", "Retry"), () => play(state.current, video.currentTime)),
			el(
				"div",
				{ class: "hg-options" },
				el("label", { class: "hg-auto" }, auto, t("自动连播", "Auto-next")),
				el("label", { class: "hg-auto hg-preload" }, preload, t("预载下一集", "Preload next")),
				el(
					"span",
					{ class: "hg-preload-state hg-subtle", role: "status" },
					state.preloadState === "ready"
						? t("下一集已就绪", "Next episode ready")
						: state.preloadState === "loading"
							? t("准备下一集…", "Preparing next…")
							: "",
				),
			),
		);
		controls.replaceChildren(...items);
	}
	async function loadVendor(kind) {
		if (kind === "dash") return import(new URL("./vendor/dash.all.min.mjs", import.meta.url).href);
		if (globalThis.mpegts) return globalThis.mpegts;
		if (!pendingScripts.has(kind))
			pendingScripts.set(
				kind,
				new Promise((resolve, reject) => {
					const script = el("script", { src: new URL("./vendor/mpegts.js", import.meta.url).href });
					script.onload = () => {
						script.remove();
						resolve(globalThis.mpegts);
					};
					script.onerror = () => {
						script.remove();
						pendingScripts.delete(kind);
						reject(new Error(t("播放器组件加载失败", "Player component failed to load")));
					};
					root.append(script);
				}),
			);
		return pendingScripts.get(kind);
	}
	async function attach(source, version) {
		const url = new URL(source.url, API).href;
		if (source.kind === "file" || (source.kind === "hls" && video.canPlayType("application/vnd.apple.mpegurl"))) {
			video.src = url;
			return;
		}
		const library = await loadVendor(source.kind);
		if (version !== playVersion || destroyed) return;
		if (source.kind === "hls") {
			engine = library.createPlayer(
				{ type: "mse", isLive: false, url, hasAudioTrack: true },
				{ autoCleanupSourceBuffer: true, lazyLoad: true },
			);
			engine.attachMediaElement(video);
			engine.load();
		} else {
			const factory = library.MediaPlayer ?? library.default?.MediaPlayer ?? library.default;
			engine = factory().create();
			engine.initialize(video, url, false);
		}
	}
	async function play(episode, position, sourceIndex = 0) {
		if (!episode || destroyed || !state.open) return;
		saveProgress();
		const version = ++playVersion;
		playRequest?.abort();
		playRequest = new AbortController();
		clearSource();
		state.current = episode;
		state.sources = [];
		const record = history[state.series.id];
		resumeAt = typeof position === "number" ? position : record?.episodeId === episode.id ? resumePosition(record) : 0;
		lastSaved = resumeAt;
		player.hidden = false;
		title.textContent = state.series.title;
		subtitle.textContent = t(`第 ${episode.number ?? "?"} 集`, `Episode ${episode.number ?? "?"}`);
		overlay.textContent = t("正在准备视频…", "Preparing video…");
		message();
		layout();
		render();
		renderControls();
		try {
			const data = await api(`play?episode=${encodeURIComponent(episode.id)}`, playRequest.signal);
			if (version !== playVersion || destroyed || !state.open) return;
			state.sources = data.streams ?? [];
			const source = state.sources[sourceIndex] ?? state.sources[0];
			if (!source) throw new Error(t("没有可用的视频线路", "No playable video source"));
			state.source = source;
			await attach(source, version);
			if (version !== playVersion || destroyed || !state.open) return;
			video.playbackRate = prefs.speed ?? 1;
			renderControls();
			try {
				await video.play();
			} catch {
				if (version === playVersion) {
					overlay.textContent = "";
					message(t("点击视频播放按钮开始观看", "Press play on the video to start"));
				}
			}
		} catch (error) {
			if (version !== playVersion || error.name === "AbortError" || destroyed) return;
			overlay.textContent = "";
			message(error.message, true);
			renderControls();
		}
	}
	function adjacent(offset) {
		const index = state.episodes.findIndex((row) => row.id === state.current?.id);
		const next = state.episodes[index + offset];
		if (index >= 0 && next) play(next, 0);
	}
	function empty(text, retry) {
		return el(
			"div",
			{ class: "hg-empty" },
			icon("play"),
			el("div", { text }),
			retry ? button(t("重试", "Retry"), retry) : null,
		);
	}
	function render() {
		if (!body || destroyed) return;
		if (state.page === "series") {
			const episodes = el(
				"div",
				{ class: "hg-episodes" },
				state.episodes.map((episode, index) => {
					const btn = button(String(episode.number ?? index + 1), () => play(episode), {
						title: episode.title || t(`第 ${episode.number ?? index + 1} 集`, `Episode ${episode.number ?? index + 1}`),
						"aria-current": String(state.current?.id === episode.id),
					});
					btn.disabled = episode.playable === false;
					return btn;
				}),
			);
			body.replaceChildren(
				el(
					"div",
					{ class: "hg-section-title" },
					button(
						icon("back"),
						() => {
							state.page = "library";
							render();
						},
						{ "aria-label": t("返回剧场", "Back to library") },
					),
					el("div", { class: "hg-title", text: state.series?.title ?? "" }),
					el("span", {
						class: "hg-subtle",
						text: t(`${state.episodes.length} 集`, `${state.episodes.length} episodes`),
					}),
				),
				state.busy
					? empty(t("正在加载剧集…", "Loading episodes…"))
					: state.episodes.length
						? episodes
						: empty(t("暂时没有剧集", "No episodes available"), () => openSeries(state.series)),
			);
			return;
		}
		const actors = state.searchType === "actor";
		const input = el("input", {
			type: "search",
			placeholder: actors
				? t("搜索演员姓名", "Search actors by name")
				: t("搜索剧名或关键词", "Search dramas or keywords"),
			"aria-label": actors ? t("搜索演员", "Search actors") : t("搜索短剧", "Search dramas"),
			value: state.query,
		});
		const searchType = el(
			"select",
			{
				"aria-label": t("搜索类型", "Search type"),
				onchange: (event) => {
					state.searchType = event.target.value;
					state.query = input.value.trim();
					state.actor = null;
					state.tab = "recommend";
					loadList();
				},
			},
			el("option", { value: "drama" }, t("剧名", "Drama")),
			el("option", { value: "actor" }, t("演员", "Actor")),
		);
		searchType.value = state.searchType;
		const form = el(
			"form",
			{
				class: "hg-search",
				onsubmit: (event) => {
					event.preventDefault();
					state.query = input.value.trim();
					state.actor = null;
					state.tab = "recommend";
					loadList();
				},
			},
			searchType,
			input,
			button(icon("search"), () => {}, { type: "submit", class: "hg-primary", "aria-label": t("搜索", "Search") }),
		);
		const toolbar = el("div", { class: "hg-toolbar" }, form);
		const tabs = el(
			"div",
			{ class: "hg-tabs" },
			button(
				t("推荐剧场", "Discover"),
				() => {
					state.tab = "recommend";
					state.query = "";
					state.actor = null;
					state.searchType = "drama";
					loadList();
				},
				{ "aria-pressed": String(state.tab === "recommend" && !state.query && !state.actor) },
			),
			button(
				t("观看记录", "History"),
				() => {
					saveProgress();
					state.tab = "history";
					render();
				},
				{ "aria-pressed": String(state.tab === "history") },
			),
		);
		if (state.current)
			tabs.append(
				button(
					t("正在播放", "Now playing"),
					() => {
						state.page = "series";
						render();
					},
					{ class: "hg-primary" },
				),
			);
		const rows =
			state.tab === "history"
				? Object.values(history)
						.filter((row) => row?.id)
						.sort((a, b) => b.at - a.at)
				: state.items;
		const cards = el(
			"div",
			{ class: "hg-cards" },
			rows.map((item) => {
				const actor = item.kind === "actor";
				const poster = el("div", { class: "hg-poster" }, icon(actor ? "person" : "play"));
				if (item.cover)
					poster.append(
						el("img", {
							src: new URL(`cover?u=${encodeURIComponent(item.cover)}`, API).href,
							alt: "",
							loading: "lazy",
							decoding: "async",
							onerror: (event) => event.target.remove(),
						}),
					);
				if (item.episodes && !actor)
					poster.append(el("span", { class: "hg-poster-tag", text: t(`${item.episodes}集`, `${item.episodes} ep`) }));
				const record = history[item.id];
				const meta = actor
					? t("查看参演作品", "View dramas")
					: record
						? t(`续播第 ${record.number ?? "?"} 集`, `Resume episode ${record.number ?? "?"}`)
						: t("点击选集", "Choose an episode");
				return button(
					[
						poster,
						el("span", { class: "hg-card-name", text: item.title }),
						el("span", { class: "hg-card-meta", text: meta }),
					],
					() => (actor ? openActor(item) : openSeries(item)),
					{ class: actor ? "hg-card hg-person-card" : "hg-card", title: item.title },
				);
			}),
		);
		const emptyText =
			state.tab === "history"
				? t("看过的短剧会出现在这里", "Your watched dramas will appear here")
				: state.actor
					? t("暂无公开参演作品", "No public dramas found for this actor")
					: actors
						? state.query
							? t("没有找到演员，试试完整姓名", "No actors found. Try their full name.")
							: t("输入演员姓名，查看参演短剧", "Enter an actor's name to find their dramas")
						: t("没有找到短剧，试试其他关键词", "No dramas found. Try another search.");
		const content =
			state.busy && !rows.length
				? empty(t("正在加载…", "Loading…"))
				: rows.length
					? cards
					: empty(emptyText, state.tab === "history" || (actors && !state.query) ? null : () => loadList());
		body.replaceChildren(toolbar, tabs);
		if (state.actor && state.tab !== "history")
			body.append(
				el(
					"div",
					{ class: "hg-section-title" },
					button(
						icon("back"),
						() => {
							state.actor = null;
							loadList();
						},
						{ "aria-label": t("返回演员搜索", "Back to actors") },
					),
					el("div", { class: "hg-title", text: t(`${state.actor.name}的作品`, `Dramas by ${state.actor.name}`) }),
				),
			);
		body.append(content);
		if (state.hasMore && state.tab !== "history") {
			const more = button(state.busy ? t("加载中…", "Loading…") : t("加载更多", "Load more"), () => loadList(true));
			more.disabled = state.busy;
			body.append(el("div", { class: "hg-more" }, more));
		}
	}

	async function loadList(more = false) {
		const version = ++listVersion;
		listRequest?.abort();
		listRequest = new AbortController();
		state.busy = true;
		if (!more) {
			state.items = [];
			state.cursor = "";
			state.hasMore = false;
		}
		render();
		message();
		try {
			if (state.searchType === "actor" && !state.query && !state.actor) return;
			const cursor = encodeURIComponent(more ? state.cursor : "");
			const path = state.actor
				? `actors/works?id=${encodeURIComponent(state.actor.id)}&cursor=${cursor}`
				: state.query
					? `search?q=${encodeURIComponent(state.query)}&type=${state.searchType}&cursor=${cursor}`
					: "list";
			const data = await api(path, listRequest.signal);
			if (version !== listVersion || destroyed) return;
			state.items = mergedRows(more ? state.items : [], data.items ?? []);
			if (state.actor && data.person) state.actor = { ...state.actor, ...data.person };
			state.cursor = data.cursor ?? "";
			state.hasMore = data.hasMore === true;
			listLoaded = true;
		} catch (error) {
			if (version === listVersion && error.name !== "AbortError" && !destroyed) message(error.message, true);
		} finally {
			if (version === listVersion && !destroyed) {
				state.busy = false;
				render();
			}
		}
	}
	function openActor(item) {
		state.actor = { id: item.id, name: item.name ?? item.title };
		state.tab = "recommend";
		state.page = "library";
		void loadList();
	}
	async function openSeries(item) {
		if (!item?.id) return;
		saveProgress();
		++playVersion;
		playRequest?.abort();
		++listVersion;
		listRequest?.abort();
		clearSource();
		player.hidden = true;
		state.current = null;
		state.sources = [];
		state.series = item;
		state.episodes = [];
		state.page = "series";
		state.busy = true;
		state.mini = false;
		const version = ++seriesVersion;
		seriesRequest?.abort();
		seriesRequest = new AbortController();
		render();
		message();
		layout();
		try {
			const data = await api(`series?id=${encodeURIComponent(item.id)}`, seriesRequest.signal);
			if (version !== seriesVersion || destroyed || !state.open) return;
			state.series = {
				...item,
				...data.series,
				title: data.series?.title && data.series.title !== "未命名短剧" ? data.series.title : item.title,
				cover: data.series?.cover || item.cover,
			};
			state.episodes = (data.episodes ?? []).map((episode, index) => ({
				...episode,
				id: String(episode.id),
				number: episode.number ?? index + 1,
			}));
			const record = history[item.id];
			const first =
				state.episodes.find((episode) => episode.id === record?.episodeId) ??
				state.episodes.find((episode) => episode.playable !== false);
			state.busy = false;
			render();
			if (first) await play(first, record?.episodeId === first.id ? resumePosition(record) : 0);
		} catch (error) {
			if (version === seriesVersion && error.name !== "AbortError" && !destroyed) message(error.message, true);
		} finally {
			if (version === seriesVersion && !destroyed) {
				state.busy = false;
				render();
			}
		}
	}
	function open() {
		if (destroyed || !init()) return;
		lastFocus = document.activeElement;
		state.open = true;
		root.hidden = false;
		layout();
		render();
		if (state.current) renderControls();
		root.querySelector(".hg-modes button")?.focus({ preventScroll: true });
		if (!configLoaded) {
			configLoaded = true;
			void api("config")
				.then((config) => {
					if (!config.ffmpegAvailable && !destroyed)
						message(
							t(
								"部分视频需要 FFmpeg，可在插件设置中配置路径",
								"Some videos need FFmpeg. Configure its path in plugin settings.",
							),
						);
				})
				.catch(() => {});
		}
		if (!listLoaded && state.page === "library") void loadList();
	}
	function close() {
		if (!root) return;
		saveProgress();
		state.open = false;
		stopPreload();
		++playVersion;
		playRequest?.abort();
		seriesRequest?.abort();
		video.pause();
		if (document.pictureInPictureElement === video) void document.exitPictureInPicture().catch(() => {});
		root.hidden = true;
		gestureCleanup?.();
		layout();
		lastFocus?.focus?.({ preventScroll: true });
	}
	function destroy() {
		if (destroyed) return;
		saveProgress();
		destroyed = true;
		++playVersion;
		lifetime.abort();
		gestureCleanup?.();
		observer?.disconnect();
		window.removeEventListener("resize", layout);
		window.removeEventListener("pagehide", saveProgress);
		if (document.pictureInPictureElement === video) void document.exitPictureInPicture().catch(() => {});
		clearSource();
		if (app) {
			padding("padding-inline-end", 0);
			padding("padding-block-end", 0);
		}
		root?.remove();
	}
	return {
		open,
		close,
		toggle() {
			if (state.open) close();
			else open();
		},
		destroy,
		setMode,
	};
}
