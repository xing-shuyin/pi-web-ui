/**
 * 洛雪音乐 (LX Music) 客户端入口 —— 全功能专业音乐播放器
 * 特性：一键播放全部、静默添加队列(无阻断弹窗)、多源搜索、热歌榜单、收藏夹持久化、播放队列抽屉、画中画桌面浮动歌词、音质切换、歌曲下载、快捷键
 */

import { loadPlayer, savePlayer, PLAYER_STORAGE_KEY } from "./player-storage.mjs";

let globalAudio = null;
let storageKey = PLAYER_STORAGE_KEY;
let restored = false;
let lastProgressSave = 0;
let storageWarningShown = false;
let removeKeyboardListener = null;
let isRecovering = false;
let recoverAttempts = 0;
let stallTimer = null;
let watchdogTimer = null;
let lastProgressCheck = { time: 0, stamp: 0 };

function clearStallTimers() {
	if (stallTimer) {
		clearTimeout(stallTimer);
		stallTimer = null;
	}
}

async function attemptRecoverPlayback(reason = "stall") {
	if (isRecovering) return;
	if (!globalState.isPlaying || !globalState.currentSong) return;
	isRecovering = true;
	clearStallTimers();

	const targetSong = globalState.currentSong;
	const resumeTime = globalAudio ? globalAudio.currentTime : globalState.currentTime;

	try {
		recoverAttempts++;
		console.warn(`[LX-Music] 触发播放自愈 (${reason}, 第 ${recoverAttempts} 次, 进度: ${formatTime(resumeTime)})`);

		if (recoverAttempts <= 1 && targetSong._realPlayUrl) {
			showToast("网络流异常，正在重连当前进度...", 1800);
			const retryUrl = `${apiBaseUrl}/stream?url=${encodeURIComponent(targetSong._realPlayUrl)}&source=${targetSong.source}&_retry=${Date.now()}`;
			globalAudio.src = retryUrl;
			if (resumeTime > 0) {
				globalAudio.addEventListener(
					"loadedmetadata",
					() => {
						globalAudio.currentTime = Math.min(
							resumeTime,
							Number.isFinite(globalAudio.duration) ? Math.max(0, globalAudio.duration - 0.1) : resumeTime,
						);
					},
					{ once: true },
				);
			}
			await globalAudio.play().catch(() => {});
			return;
		}

		showToast("正在重新解析音源并恢复播放...", 2000);
		const urlRes = await fetch(
			`${apiBaseUrl}/song-url?source=${targetSong.source}&songId=${encodeURIComponent(targetSong.id)}&name=${encodeURIComponent(targetSong.name)}&singer=${encodeURIComponent(targetSong.singer)}&album=${encodeURIComponent(targetSong.album || "")}&quality=${globalState.quality}&_refresh=1`,
		).then((r) => r.json());

		if (urlRes?.ok && urlRes?.url) {
			targetSong._realPlayUrl = urlRes.url;
			targetSong._realQuality = urlRes.quality || globalState.quality;
			renderPlayerBarInfo();
			const newStreamUrl = `${apiBaseUrl}/stream?url=${encodeURIComponent(urlRes.url)}&source=${targetSong.source}&_refresh=${Date.now()}`;
			globalAudio.src = newStreamUrl;
			if (resumeTime > 0) {
				globalAudio.addEventListener(
					"loadedmetadata",
					() => {
						globalAudio.currentTime = Math.min(
							resumeTime,
							Number.isFinite(globalAudio.duration) ? Math.max(0, globalAudio.duration - 0.1) : resumeTime,
						);
					},
					{ once: true },
				);
			}
			await globalAudio.play().catch(() => {});
			recoverAttempts = 0;
			showToast("播放已恢复", 1500);
		} else {
			showToast(`播放中断，建议在右上角切换音源或重试`, 3500);
		}
	} catch (err) {
		console.error("[LX-Music] 恢复失败:", err);
	} finally {
		setTimeout(() => {
			isRecovering = false;
		}, 1500);
	}
}
function persistPlayer() {
	if (!restored) return;
	try {
		if (savePlayer(window.localStorage, globalState, storageKey)) return;
	} catch {}
	if (!storageWarningShown) {
		storageWarningShown = true;
		showToast("播放数据保存失败，请检查浏览器存储空间或权限", 5000);
	}
}
function resumePlayback() {
	if (!globalState.currentSong) return;
	if (!globalAudio?.getAttribute("src")) {
		return playSong(globalState.currentSong, false, globalState.currentTime);
	}
	return globalAudio.play().catch(() => showToast("播放失败，请重试"));
}
let globalState = {
	currentSong: null,
	isPlaying: false,
	currentTime: 0,
	duration: 0,
	playMode: "loop", // loop | random | single
	queue: [],
	history: [],
	searchKeyword: "",
	favorites: [],
	searchResults: [],
	source: "wy",
	lyrics: [],
	currentLrcIndex: -1,
	volume: 0.8,
	quality: "128k", // 128k | 320k | flac
	activeUserApi: null,
	activeViewTab: "search", // search | top | playlist | favorites | queue | history
	topChartType: "hot", // 兼容旧状态
	topChartSource: "wy",
	topChartBangId: "hot",
	topListsMap: {},
	topChartSongs: [],
	playlistSource: "wy",
	playlistTag: "全部",
	playlistTagsMap: {},
	playlists: [],
	activePlaylistDetail: null,
};

const transientKeys = new Set([
	"isPlaying",
	"lyrics",
	"currentLrcIndex",
	"activeUserApi",
	"topListsMap",
	"topChartSongs",
	"playlistTagsMap",
	"playlists",
	"activePlaylistDetail",
]);
globalState = new Proxy(globalState, {
	set(target, key, value) {
		target[key] = value;
		if (!transientKeys.has(key)) {
			if (key !== "currentTime" && key !== "duration") persistPlayer();
			else if (Date.now() - lastProgressSave >= 3000) {
				lastProgressSave = Date.now();
				persistPlayer();
			}
		}
		return true;
	},
});

// ==============================
// 轻量无阻断 Toast 提示系统 (不弹 alert)
// ==============================
let toastTimer = null;
function showToast(message, duration = 1800) {
	if (!activeRootEl) return;
	let toast = activeRootEl.querySelector("#lx-toast");
	if (!toast) {
		toast = document.createElement("div");
		toast.id = "lx-toast";
		toast.className = "lx-toast";
		activeRootEl.appendChild(toast);
	}
	toast.textContent = message;
	toast.classList.add("show");

	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		toast.classList.remove("show");
	}, duration);
}

// ==============================
// 画中画桌面歌词 (Picture-in-Picture)
// ==============================
let pipVideo = null;
let pipCanvas = null;
let pipCtx = null;
let isPipActive = false;

function initPipEngine() {
	if (!pipCanvas) {
		pipCanvas = document.createElement("canvas");
		pipCanvas.width = 640;
		pipCanvas.height = 140;
		pipCtx = pipCanvas.getContext("2d");
	}
	if (!pipVideo) {
		pipVideo = document.createElement("video");
		pipVideo.muted = true;
		pipVideo.playsInline = true;
		const stream = pipCanvas.captureStream(15);
		pipVideo.srcObject = stream;
		pipVideo.play().catch(() => {});

		pipVideo.addEventListener("enterpictureinpicture", () => {
			isPipActive = true;
			updatePipBtnState();
		});
		pipVideo.addEventListener("leavepictureinpicture", () => {
			isPipActive = false;
			updatePipBtnState();
		});
	}
}

function updatePipLyric(mainText, subText = "") {
	if (!pipCtx) return;
	pipCtx.fillStyle = "#14161d";
	pipCtx.fillRect(0, 0, 640, 140);

	pipCtx.strokeStyle = "rgba(255,255,255,0.08)";
	pipCtx.lineWidth = 2;
	pipCtx.strokeRect(1, 1, 638, 138);

	pipCtx.fillStyle = "#88c0d0";
	pipCtx.font = "bold 24px -apple-system, BlinkMacSystemFont, sans-serif";
	pipCtx.textAlign = "center";
	pipCtx.textBaseline = "middle";
	pipCtx.fillText(mainText || "洛雪音乐", 320, 52);

	pipCtx.fillStyle = "#7e8798";
	pipCtx.font = "15px sans-serif";
	pipCtx.fillText(
		subText || (globalState.currentSong ? `${globalState.currentSong.name} - ${globalState.currentSong.singer}` : ""),
		320,
		96,
	);
}

async function togglePictureInPicture() {
	initPipEngine();
	try {
		if (document.pictureInPictureElement) {
			await document.exitPictureInPicture();
		} else {
			updatePipLyric(
				globalState.lyrics[globalState.currentLrcIndex]?.text || "正在播放",
				globalState.currentSong ? `${globalState.currentSong.name} - ${globalState.currentSong.singer}` : "",
			);
			await pipVideo.requestPictureInPicture();
		}
	} catch (err) {
		showToast(`画中画启动失败: ${err.message}`);
	}
}

function updatePipBtnState() {
	if (!activeRootEl) return;
	const btn = activeRootEl.querySelector("#lx-pip-btn");
	if (btn) {
		if (isPipActive) btn.classList.add("active");
		else btn.classList.remove("active");
	}
}

// ==============================
// 播放核心与事件总线
// ==============================
function ensureGlobalAudio(apiBase) {
	if (!globalAudio) {
		globalAudio = new Audio();
		globalAudio.volume = globalState.volume;

		globalAudio.addEventListener("timeupdate", () => {
			clearStallTimers();
			if (globalAudio.currentTime > lastProgressCheck.time + 0.5) {
				recoverAttempts = 0;
			}
			lastProgressCheck = { time: globalAudio.currentTime, stamp: Date.now() };
			globalState.currentTime = globalAudio.currentTime;
			globalState.duration = globalAudio.duration || globalState.currentSong?.durationSec || 0;
			updateProgressBar();
			updateCurrentLyric(globalAudio.currentTime);
		});

		globalAudio.addEventListener("play", () => {
			globalState.isPlaying = true;
			clearStallTimers();
			updatePlayButtonState();
			updateMediaSession();
		});

		globalAudio.addEventListener("pause", () => {
			globalState.isPlaying = false;
			clearStallTimers();
			persistPlayer();
			updatePlayButtonState();
			updateMediaSession();
		});

		globalAudio.addEventListener("ended", () => {
			clearStallTimers();
			playNextSong();
		});

		globalAudio.addEventListener("waiting", () => {
			if (globalState.isPlaying && !stallTimer) {
				stallTimer = setTimeout(() => {
					attemptRecoverPlayback("waiting_timeout");
				}, 4000);
			}
		});

		globalAudio.addEventListener("stalled", () => {
			if (globalState.isPlaying && !stallTimer) {
				stallTimer = setTimeout(() => {
					attemptRecoverPlayback("stalled");
				}, 4000);
			}
		});

		globalAudio.addEventListener("error", (e) => {
			console.warn("[LX-Music] Audio error, attempting recovery...", e);
			clearStallTimers();
			if (globalState.isPlaying) {
				attemptRecoverPlayback("audio_error");
			}
		});

		if (!watchdogTimer && typeof setInterval === "function") {
			watchdogTimer = setInterval(() => {
				if (!globalState.isPlaying || !globalAudio || globalAudio.paused || globalAudio.ended) return;
				if (isRecovering) return;
				const cur = globalAudio.currentTime;
				if (cur > 0 && cur === lastProgressCheck.time && Date.now() - lastProgressCheck.stamp >= 5000) {
					attemptRecoverPlayback("watchdog_hang");
				}
			}, 3000);
		}
	}
	return globalAudio;
}

function parseLrc(lrcText) {
	if (!lrcText) return [{ time: 0, text: "暂无歌词" }];
	const lines = lrcText.split("\n");
	const result = [];
	const timeReg = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/g;

	for (const line of lines) {
		const matches = [...line.matchAll(timeReg)];
		const text = line.replace(timeReg, "").trim();
		if (!text) continue;

		for (const m of matches) {
			const min = parseInt(m[1], 10);
			const sec = parseInt(m[2], 10);
			const ms = m[3] ? parseInt(m[3].padEnd(3, "0"), 10) : 0;
			const totalSec = min * 60 + sec + ms / 1000;
			result.push({ time: totalSec, text });
		}
	}

	result.sort((a, b) => a.time - b.time);
	return result.length ? result : [{ time: 0, text: "暂无有效歌词" }];
}

function formatTime(sec) {
	if (isNaN(sec) || sec < 0) return "00:00";
	const s = Math.floor(sec);
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

let activeRootEl = null;
let apiBaseUrl = "";

function updatePlayButtonState() {
	if (!activeRootEl) return;
	const btn = activeRootEl.querySelector("#lx-play-btn");
	const coverDisc = activeRootEl.querySelector("#lx-cover-disc");
	if (btn) {
		btn.innerHTML = globalState.isPlaying
			? `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
			: `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
		btn.title = globalState.isPlaying ? "暂停 (Space)" : "播放 (Space)";
	}
	if (coverDisc) {
		if (globalState.isPlaying) coverDisc.classList.add("playing");
		else coverDisc.classList.remove("playing");
	}
}

function updateProgressBar() {
	if (!activeRootEl) return;
	const curText = activeRootEl.querySelector("#lx-cur-time");
	const durText = activeRootEl.querySelector("#lx-dur-time");
	const progressInner = activeRootEl.querySelector("#lx-progress-bar-inner");

	if (curText) curText.textContent = formatTime(globalState.currentTime);
	if (durText) durText.textContent = formatTime(globalState.duration);
	if (progressInner && globalState.duration > 0) {
		const pct = Math.min(100, Math.max(0, (globalState.currentTime / globalState.duration) * 100));
		progressInner.style.width = `${pct}%`;
	}
}

function updateCurrentLyric(currentTime) {
	if (!activeRootEl || !globalState.lyrics.length) return;
	let idx = -1;
	for (let i = 0; i < globalState.lyrics.length; i++) {
		if (currentTime >= globalState.lyrics[i].time) {
			idx = i;
		} else {
			break;
		}
	}
	if (idx !== globalState.currentLrcIndex && idx !== -1) {
		globalState.currentLrcIndex = idx;
		const curLine = globalState.lyrics[idx];
		const nextLine = globalState.lyrics[idx + 1];

		updatePipLyric(curLine.text, nextLine ? nextLine.text : "");

		const lrcContainer = activeRootEl.querySelector("#lx-lyrics-scroll");
		if (lrcContainer) {
			const items = lrcContainer.querySelectorAll(".lx-lrc-line");
			items.forEach((item, i) => {
				if (i === idx) {
					item.classList.add("active");
					const containerHeight = lrcContainer.clientHeight;
					const itemTop = item.offsetTop;
					lrcContainer.scrollTo({
						top: itemTop - containerHeight / 2 + item.clientHeight / 2,
						behavior: "smooth",
					});
				} else {
					item.classList.remove("active");
				}
			});
		}
	}
}

function updateMediaSession() {
	if ("mediaSession" in navigator && globalState.currentSong) {
		const s = globalState.currentSong;
		navigator.mediaSession.metadata = new MediaMetadata({
			title: s.name,
			artist: s.singer,
			album: s.album || "洛雪音乐",
			artwork: s.pic ? [{ src: s.pic, sizes: "300x300", type: "image/jpeg" }] : [],
		});
		navigator.mediaSession.setActionHandler("play", () => {
			if (globalAudio) globalAudio.play();
		});
		navigator.mediaSession.setActionHandler("pause", () => {
			if (globalAudio) globalAudio.pause();
		});
		navigator.mediaSession.setActionHandler("previoustrack", () => {
			playPrevSong();
		});
		navigator.mediaSession.setActionHandler("nexttrack", () => {
			playNextSong();
		});
	}
}

async function playSong(song, addToQueue = true, resumeTime = 0) {
	const audio = ensureGlobalAudio(apiBaseUrl);
	globalState.currentSong = song;
	globalState.currentTime = resumeTime;
	globalState.duration = song.durationSec || 0;
	recoverAttempts = 0;
	lastProgressCheck = { time: resumeTime, stamp: Date.now() };

	if (addToQueue) {
		const exists = globalState.queue.find((item) => item.id === song.id && item.source === song.source);
		if (!exists) {
			globalState.queue.push(song);
			updateQueueBadge();
		}
	}

	renderPlayerBarInfo();
	updatePlayButtonState();
	renderCurrentTable();

	// 1. 获取歌词
	try {
		const lrcRes = await fetch(`${apiBaseUrl}/lyric?source=${song.source}&songId=${encodeURIComponent(song.id)}`).then(
			(r) => r.json(),
		);
		if (lrcRes.ok && lrcRes.lyric) {
			globalState.lyrics = parseLrc(lrcRes.lyric);
		} else {
			globalState.lyrics = [{ time: 0, text: `${song.name} - ${song.singer} (暂无歌词)` }];
		}
	} catch {
		globalState.lyrics = [{ time: 0, text: "歌词加载失败" }];
	}
	renderLyrics();

	// 2. 获取真实音频链接
	try {
		const urlRes = await fetch(
			`${apiBaseUrl}/song-url?source=${song.source}&songId=${encodeURIComponent(song.id)}&name=${encodeURIComponent(song.name)}&singer=${encodeURIComponent(song.singer)}&album=${encodeURIComponent(song.album || "")}&quality=${globalState.quality}`,
		).then((r) => r.json());

		if (urlRes.ok && urlRes.url) {
			song._realPlayUrl = urlRes.url;
			song._realQuality = urlRes.quality || globalState.quality;
			renderPlayerBarInfo();
			const streamUrl = `${apiBaseUrl}/stream?url=${encodeURIComponent(urlRes.url)}&source=${song.source}`;
			audio.src = streamUrl;
			if (resumeTime > 0) {
				audio.addEventListener(
					"loadedmetadata",
					() => {
						audio.currentTime = Math.min(
							resumeTime,
							Number.isFinite(audio.duration) ? Math.max(0, audio.duration - 0.1) : resumeTime,
						);
					},
					{ once: true },
				);
			}
			await audio.play();
			globalState.history = [
				song,
				...globalState.history.filter((s) => s.id !== song.id || s.source !== song.source),
			].slice(0, 500);
			renderCurrentTable();
		} else {
			showToast(`无法获取播放链接: ${song.name}（若当前音源失效，可在右上角切换为 Fish 音源）`, 3500);
		}
	} catch (err) {
		console.error("Play error:", err);
	}
}

function playNextSong() {
	if (!globalState.queue.length) return;
	let idx = globalState.queue.findIndex(
		(s) => s.id === globalState.currentSong?.id && s.source === globalState.currentSong?.source,
	);
	if (globalState.playMode === "random") {
		idx = Math.floor(Math.random() * globalState.queue.length);
	} else if (globalState.playMode === "single") {
		if (globalAudio?.getAttribute("src")) {
			globalAudio.currentTime = 0;
			globalAudio.play();
			return;
		}
	} else {
		idx = (idx + 1) % globalState.queue.length;
	}
	playSong(globalState.queue[idx], false);
}

function playPrevSong() {
	if (!globalState.queue.length) return;
	let idx = globalState.queue.findIndex(
		(s) => s.id === globalState.currentSong?.id && s.source === globalState.currentSong?.source,
	);
	idx = (idx - 1 + globalState.queue.length) % globalState.queue.length;
	playSong(globalState.queue[idx], false);
}

function isFavorited(song) {
	if (!song) return false;
	return globalState.favorites.some((f) => f.id === song.id && f.source === song.source);
}

async function toggleFavorite(song) {
	const idx = globalState.favorites.findIndex((f) => f.id === song.id && f.source === song.source);
	if (idx >= 0) {
		globalState.favorites.splice(idx, 1);
		showToast(`已从收藏夹移除: ${song.name}`);
	} else {
		globalState.favorites.push(song);
		showToast(`已收藏: ${song.name}`);
	}
	renderCurrentTable();

	try {
		await fetch(`${apiBaseUrl}/favorites`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ favorites: globalState.favorites }),
		});
	} catch {}
}

async function downloadCurrentSong(song) {
	try {
		let url = song._realPlayUrl;
		if (!url) {
			const urlRes = await fetch(
				`${apiBaseUrl}/song-url?source=${song.source}&songId=${encodeURIComponent(song.id)}&name=${encodeURIComponent(song.name)}&singer=${encodeURIComponent(song.singer)}`,
			).then((r) => r.json());
			if (urlRes.ok && urlRes.url) url = urlRes.url;
		}
		if (!url) return showToast("获取下载链接失败");

		showToast(`正在开始下载: ${song.name}`);
		const downloadUrl = `${apiBaseUrl}/download?url=${encodeURIComponent(url)}&name=${encodeURIComponent(song.name)}&singer=${encodeURIComponent(song.singer)}`;
		const a = document.createElement("a");
		a.href = downloadUrl;
		a.download = `${song.name} - ${song.singer}.mp3`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	} catch (err) {
		showToast(`下载出错: ${err.message}`);
	}
}

// ==============================
// 列表与队列批量操作核心
// ==============================
function getCurrentViewSongs() {
	if (globalState.activeViewTab === "search") {
		return globalState.searchResults || [];
	} else if (globalState.activeViewTab === "top") {
		return globalState.topChartSongs || [];
	} else if (globalState.activeViewTab === "playlist") {
		return globalState.activePlaylistDetail?.songs || [];
	} else if (globalState.activeViewTab === "favorites") {
		return globalState.favorites || [];
	} else if (globalState.activeViewTab === "history") {
		return globalState.history;
	} else if (globalState.activeViewTab === "queue") {
		return globalState.queue || [];
	}
	return [];
}

/** 一键播放整个列表 */
function playAllCurrentList() {
	const songs = getCurrentViewSongs();
	if (!songs || songs.length === 0) {
		return showToast("当前列表没有可播放的歌曲");
	}

	// 将当前整个列表载入播放队列并立即从第 1 首播放
	globalState.queue = [...songs];
	updateQueueBadge();
	playSong(songs[0], false);
	showToast(`开始播放全部 (共 ${songs.length} 首)`);
}

/** 全部直接加入队列（静默添加，无阻断确认框） */
function addAllCurrentToQueue() {
	const songs = getCurrentViewSongs();
	if (!songs || songs.length === 0) {
		return showToast("当前列表没有歌曲");
	}

	let addedCount = 0;
	songs.forEach((s) => {
		const exists = globalState.queue.find((item) => item.id === s.id && item.source === s.source);
		if (!exists) {
			globalState.queue.push(s);
			addedCount++;
		}
	});

	updateQueueBadge();
	showToast(`已追加 ${addedCount} 首歌曲至播放队列`);
}

/** 直接添加单曲到队列（无任何 confirm/alert 阻断弹窗） */
function addSingleToQueueDirectly(song) {
	const exists = globalState.queue.find((item) => item.id === song.id && item.source === song.source);
	if (exists) {
		showToast(`该歌曲已在队列中: ${song.name}`);
	} else {
		globalState.queue.push(song);
		updateQueueBadge();
		showToast(`已加入播放队列: ${song.name}`);
	}
}

/** 清空当前播放队列 */
function clearQueue() {
	globalState.queue = [];
	updateQueueBadge();
	renderCurrentTable();
	showToast("播放队列已清空");
}

function renderPlayerBarInfo() {
	if (!activeRootEl) return;
	const s = globalState.currentSong;
	const nameEl = activeRootEl.querySelector("#lx-bar-song-name");
	const singerEl = activeRootEl.querySelector("#lx-bar-singer");
	const coverEl = activeRootEl.querySelector("#lx-bar-cover");
	const discImg = activeRootEl.querySelector("#lx-disc-img");

	if (!s) {
		if (nameEl) nameEl.textContent = "洛雪音乐";
		if (singerEl) singerEl.textContent = "选择一首歌曲开始播放";
		if (coverEl)
			coverEl.src =
				"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'><path d='M9 18V5l12-2v13'/><circle cx='6' cy='18' r='3'/><circle cx='18' cy='16' r='3'/></svg>";
		return;
	}

	if (nameEl) nameEl.textContent = s.name;
	const qualityBadge = s._realQuality ? ` [${s._realQuality.toUpperCase()}]` : "";
	if (singerEl) singerEl.textContent = `${s.singer} · ${s.album || "精选"}${qualityBadge}`;
	const defaultCover =
		"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='1.5'><path d='M9 18V5l12-2v13'/><circle cx='6' cy='18' r='3'/><circle cx='18' cy='16' r='3'/></svg>";
	if (coverEl) coverEl.src = s.pic || defaultCover;
	if (discImg) discImg.src = s.pic || defaultCover;
}

function renderLyrics() {
	if (!activeRootEl) return;
	const container = activeRootEl.querySelector("#lx-lyrics-scroll");
	if (!container) return;
	container.innerHTML = "";
	globalState.currentLrcIndex = -1;

	globalState.lyrics.forEach((line) => {
		const div = document.createElement("div");
		div.className = "lx-lrc-line";
		div.textContent = line.text;
		div.title = `点击跳转到 ${formatTime(line.time)}`;
		div.addEventListener("click", () => {
			if (globalAudio) {
				globalAudio.currentTime = line.time;
				if (!globalState.isPlaying) globalAudio.play();
			}
		});
		container.appendChild(div);
	});
}

function updateUserApiBadge() {
	if (!activeRootEl) return;
	const badge = activeRootEl.querySelector("#lx-active-api-badge");
	if (!badge) return;
	if (globalState.activeUserApi) {
		badge.textContent = `⚡ 音源: ${globalState.activeUserApi.name} (${globalState.activeUserApi.version})`;
		badge.style.display = "inline-flex";
	} else {
		badge.style.display = "none";
	}
}

function updateQueueBadge() {
	persistPlayer();
	if (!activeRootEl) return;
	const queueNavTab = activeRootEl.querySelector(".lx-nav-tab[data-tab='queue']");
	if (queueNavTab) {
		queueNavTab.innerHTML = `<span>📋 播放队列</span><span class="lx-badge-count">${globalState.queue.length}</span>`;
	}
}

function renderCurrentTable() {
	persistPlayer();
	if (!activeRootEl) return;
	const tbody = activeRootEl.querySelector("#lx-song-table-body");
	const listCountEl = activeRootEl.querySelector("#lx-list-count");
	const clearQueueBtn = activeRootEl.querySelector("#lx-clear-queue-btn");
	const songs = getCurrentViewSongs();

	if (listCountEl) {
		listCountEl.textContent = `共 ${songs.length} 首歌曲`;
	}
	if (clearQueueBtn) {
		clearQueueBtn.style.display = globalState.activeViewTab === "queue" && songs.length > 0 ? "inline-flex" : "none";
	}

	if (!songs || songs.length === 0) {
		const tips = {
			search: "输入关键词开始搜索音乐",
			top: "正在加载排行榜...",
			playlist: "歌单内暂无歌曲或正在加载中...",
			favorites: "暂无收藏歌曲，点击歌曲行 ❤️ 即可收藏",
			queue: "播放队列为空，点击歌曲直接入队",
			history: "暂无播放记录，成功播放的歌曲会自动保存在这里",
		};
		tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-faint, #7e8798); padding: 40px;">${tips[globalState.activeViewTab] || "无数据"}</td></tr>`;
		return;
	}

	tbody.innerHTML = "";
	songs.forEach((song, idx) => {
		const isCur =
			globalState.currentSong &&
			globalState.currentSong.id === song.id &&
			globalState.currentSong.source === song.source;
		const isFav = isFavorited(song);

		const tr = document.createElement("tr");
		if (isCur) tr.classList.add("playing-row");
		tr.title = "双击播放";

		tr.innerHTML = `
			<td style="width: 44px; text-align: center;">
				${
					isCur
						? `<div class="lx-spectrum-anim">
								<div class="lx-spectrum-bar"></div>
								<div class="lx-spectrum-bar"></div>
								<div class="lx-spectrum-bar"></div>
						   </div>`
						: `<span class="lx-row-idx">${idx + 1}</span>`
				}
			</td>
			<td>
				<div class="lx-song-name">
					<button class="lx-fav-btn ${isFav ? "active" : ""}" title="${isFav ? "取消收藏" : "收藏"}">
						${isFav ? "❤️" : "🤍"}
					</button>
					<span class="lx-song-title-text" style="${isCur ? "color: var(--accent, #60a5fa); font-weight: 700;" : ""}" title="${song.name}">${song.name}</span>
					<span class="lx-sq-badge">SQ</span>
				</div>
			</td>
			<td class="lx-singer" title="${song.singer}">${song.singer}</td>
			<td class="lx-album" title="${song.album || "-"}">${song.album || "-"}</td>
			<td class="lx-duration">${song.duration}</td>
			<td style="text-align: right;">
				<div class="lx-table-actions" style="justify-content: flex-end;">
					<button class="lx-icon-btn btn-play" title="立即播放">
						<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
					</button>
					<button class="lx-icon-btn btn-add" title="直接加入播放队列(不弹窗)">
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
					</button>
					<button class="lx-icon-btn btn-down" title="下载音频">
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
					</button>
				</div>
			</td>
		`;

		tr.addEventListener("dblclick", (e) => {
			if (e.target.closest("button")) return;
			playSong(song);
		});
		tr.querySelector(".btn-play").addEventListener("click", () => playSong(song));
		// 直接静默加入队列，不弹任何 alert 确认窗！
		tr.querySelector(".btn-add").addEventListener("click", () => addSingleToQueueDirectly(song));
		tr.querySelector(".btn-down").addEventListener("click", () => downloadCurrentSong(song));
		tr.querySelector(".lx-fav-btn").addEventListener("click", () => toggleFavorite(song));
		tbody.appendChild(tr);
	});
}

function buildStyles() {
	return `
		.lx-wrap {
			display: flex;
			flex-direction: column;
			height: 100%;
			min-height: 100%;
			background: var(--bg, #0b0d14);
			color: var(--text, #f8fafc);
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
			user-select: none;
			overflow: hidden;
			box-sizing: border-box;
			position: relative;
		}

		/* 精细暗色原生滚动条 */
		.lx-wrap *::-webkit-scrollbar {
			width: 6px;
			height: 6px;
		}
		.lx-wrap *::-webkit-scrollbar-track {
			background: transparent;
		}
		.lx-wrap *::-webkit-scrollbar-thumb {
			background: rgba(255, 255, 255, 0.14);
			border-radius: 4px;
		}
		.lx-wrap *::-webkit-scrollbar-thumb:hover {
			background: rgba(255, 255, 255, 0.28);
		}

		/* 弥散背景动态流光 (方案 A: Liquid Glass) */
		.lx-ambient-glow {
			position: absolute;
			top: 0;
			left: 0;
			width: 100%;
			height: 100%;
			pointer-events: none;
			overflow: hidden;
			z-index: 0;
		}
		.lx-glow-orb-1 {
			position: absolute;
			top: -10%;
			right: -10%;
			width: 480px;
			height: 480px;
			border-radius: 50%;
			background: radial-gradient(circle, rgba(59, 130, 246, 0.2) 0%, rgba(139, 92, 246, 0.08) 50%, transparent 75%);
			filter: blur(55px);
			animation: lxFloatGlow 16s ease-in-out infinite alternate;
		}
		.lx-glow-orb-2 {
			position: absolute;
			bottom: -15%;
			left: -5%;
			width: 420px;
			height: 420px;
			border-radius: 50%;
			background: radial-gradient(circle, rgba(236, 72, 153, 0.12) 0%, rgba(99, 102, 241, 0.06) 50%, transparent 75%);
			filter: blur(60px);
			animation: lxFloatGlow 20s ease-in-out infinite alternate-reverse;
		}
		@keyframes lxFloatGlow {
			0% { transform: translate(0, 0) scale(1); }
			100% { transform: translate(-30px, 30px) scale(1.08); }
		}

		/* 顶部操作条 */
		.lx-header {
			position: relative;
			z-index: 10;
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 10px 20px;
			background: var(--card, rgba(20, 24, 38, 0.72));
			backdrop-filter: blur(24px);
			-webkit-backdrop-filter: blur(24px);
			border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
			flex-shrink: 0;
			gap: 14px;
		}
		.lx-brand {
			display: flex;
			align-items: center;
			gap: 8px;
			font-weight: 700;
			font-size: 15px;
			color: #ffffff;
			letter-spacing: -0.01em;
			flex-shrink: 0;
		}
		.lx-brand-icon {
			width: 26px;
			height: 26px;
			border-radius: 7px;
			background: linear-gradient(135deg, var(--accent, #3b82f6), #8b5cf6);
			display: flex;
			align-items: center;
			justify-content: center;
			box-shadow: 0 4px 10px rgba(59, 130, 246, 0.4);
		}
		.lx-nav-tabs {
			display: flex;
			background: rgba(0, 0, 0, 0.35);
			border-radius: 8px;
			padding: 3px;
			gap: 2px;
			border: 1px solid rgba(255, 255, 255, 0.05);
			flex-shrink: 0;
		}
		.lx-nav-tab {
			border: none;
			background: transparent;
			color: var(--text-faint, #94a3b8);
			padding: 5px 12px;
			font-size: 12px;
			font-weight: 500;
			border-radius: 6px;
			cursor: pointer;
			transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
			display: flex;
			align-items: center;
			gap: 5px;
			white-space: nowrap;
		}
		.lx-nav-tab:hover {
			color: #ffffff;
		}
		.lx-nav-tab.active {
			background: rgba(255, 255, 255, 0.14);
			color: #ffffff;
			font-weight: 600;
			box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
		}
		.lx-badge-count {
			background: rgba(255, 255, 255, 0.18);
			color: inherit;
			font-size: 10px;
			padding: 1px 5px;
			border-radius: 10px;
		}
		.lx-search-box {
			display: flex;
			align-items: center;
			background: rgba(0, 0, 0, 0.3);
			border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
			border-radius: 8px;
			padding: 0 10px;
			flex: 1;
			max-width: 280px;
			min-width: 150px;
			transition: all 0.2s;
		}
		.lx-search-box:focus-within {
			border-color: var(--accent, #3b82f6);
			box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.35);
			background: rgba(0, 0, 0, 0.45);
		}
		.lx-search-input {
			flex: 1;
			background: transparent;
			border: none;
			color: #ffffff;
			font-size: 12px;
			padding: 6px 4px;
			outline: none;
		}
		.lx-search-btn {
			background: transparent;
			border: none;
			color: var(--text-faint, #94a3b8);
			cursor: pointer;
			display: flex;
			align-items: center;
			padding: 3px;
		}
		.lx-search-btn:hover {
			color: var(--accent, #3b82f6);
		}
		.lx-action-btns {
			display: flex;
			align-items: center;
			gap: 8px;
			flex-shrink: 0;
		}
		.lx-api-badge {
			font-size: 11px;
			padding: 3px 8px;
			border-radius: 12px;
			background: rgba(59, 130, 246, 0.15);
			color: var(--accent, #60a5fa);
			border: 1px solid rgba(59, 130, 246, 0.3);
			display: none;
			white-space: nowrap;
		}
		.lx-btn {
			border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
			background: rgba(255, 255, 255, 0.05);
			color: var(--text, #f8fafc);
			border-radius: 6px;
			padding: 5px 11px;
			font-size: 11.5px;
			font-weight: 500;
			cursor: pointer;
			display: flex;
			align-items: center;
			gap: 5px;
			transition: all 0.2s;
			white-space: nowrap;
			backdrop-filter: blur(8px);
		}
		.lx-btn:hover {
			background: rgba(255, 255, 255, 0.1);
			border-color: rgba(255, 255, 255, 0.18);
		}
		.lx-btn-primary {
			border: none;
			background: linear-gradient(135deg, var(--accent, #3b82f6), #6366f1);
			color: var(--accent-contrast, #ffffff);
			border-radius: 16px;
			padding: 6px 14px;
			font-size: 12px;
			font-weight: 600;
			cursor: pointer;
			display: flex;
			align-items: center;
			gap: 6px;
			box-shadow: 0 3px 12px rgba(59, 130, 246, 0.35);
			transition: transform 0.15s, box-shadow 0.15s;
			white-space: nowrap;
		}
		.lx-btn-primary:hover {
			transform: scale(1.02);
		}

		/* 次级工具栏 (音源切换/榜单切换) */
		.lx-sub-bar {
			position: relative;
			z-index: 5;
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 7px 20px;
			background: rgba(14, 18, 28, 0.5);
			backdrop-filter: blur(12px);
			border-bottom: 1px solid rgba(255, 255, 255, 0.04);
			font-size: 11.5px;
			flex-shrink: 0;
		}
		.lx-pill-group {
			display: flex;
			align-items: center;
			gap: 6px;
		}
		.lx-pill-btn {
			border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
			background: rgba(255, 255, 255, 0.03);
			color: var(--text-faint, #94a3b8);
			border-radius: 12px;
			padding: 2px 10px;
			font-size: 11px;
			cursor: pointer;
			transition: all 0.2s;
			white-space: nowrap;
		}
		.lx-pill-btn:hover {
			color: #ffffff;
			background: rgba(255, 255, 255, 0.08);
		}
		.lx-pill-btn.active {
			background: linear-gradient(135deg, var(--accent, #3b82f6), #2563eb);
			color: var(--accent-contrast, #ffffff);
			border-color: transparent;
			font-weight: 600;
			box-shadow: 0 2px 6px rgba(37, 99, 235, 0.35);
		}
		.lx-pill-subgroup {
			display: inline-flex;
			align-items: center;
			gap: 4px;
			overflow-x: auto;
			max-width: 100%;
			scrollbar-width: none;
		}
		.lx-pill-subgroup::-webkit-scrollbar {
			display: none;
		}
		.lx-pill-divider {
			width: 1px;
			height: 14px;
			background: var(--border, rgba(255, 255, 255, 0.12));
			margin: 0 4px;
		}

		/* 歌单网格流 */
		.lx-playlist-grid-wrap {
			flex: 1;
			overflow-y: auto;
			padding: 16px 20px;
			min-width: 0;
			display: flex;
			flex-direction: column;
			gap: 14px;
		}
		.lx-playlist-grid-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			flex-wrap: wrap;
			gap: 10px;
		}
		.lx-playlist-category-title {
			font-size: 15px;
			font-weight: 700;
			color: var(--text, #f8fafc);
			letter-spacing: 0.3px;
		}
		.lx-playlist-cards {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
			gap: 16px;
		}
		.lx-playlist-card {
			background: rgba(255, 255, 255, 0.03);
			border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
			border-radius: 12px;
			padding: 10px;
			cursor: pointer;
			transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), background 0.2s, box-shadow 0.2s;
			display: flex;
			flex-direction: column;
			position: relative;
			overflow: hidden;
		}
		.lx-playlist-card:hover {
			transform: translateY(-4px);
			background: rgba(255, 255, 255, 0.07);
			border-color: rgba(255, 255, 255, 0.16);
			box-shadow: 0 10px 25px rgba(0, 0, 0, 0.35);
		}
		.lx-playlist-cover-wrap {
			position: relative;
			width: 100%;
			aspect-ratio: 1;
			border-radius: 8px;
			overflow: hidden;
			background: rgba(0, 0, 0, 0.2);
			margin-bottom: 8px;
		}
		.lx-playlist-cover {
			width: 100%;
			height: 100%;
			object-fit: cover;
			display: block;
			transition: transform 0.3s;
		}
		.lx-playlist-card:hover .lx-playlist-cover {
			transform: scale(1.05);
		}
		.lx-playlist-playcount {
			position: absolute;
			right: 6px;
			top: 6px;
			background: rgba(0, 0, 0, 0.55);
			backdrop-filter: blur(6px);
			color: #ffffff;
			font-size: 10px;
			padding: 2px 6px;
			border-radius: 10px;
			display: flex;
			align-items: center;
			gap: 3px;
		}
		.lx-playlist-play-hover {
			position: absolute;
			right: 10px;
			bottom: 10px;
			width: 36px;
			height: 36px;
			border-radius: 50%;
			background: var(--accent, #3b82f6);
			color: var(--accent-contrast, #ffffff);
			display: flex;
			align-items: center;
			justify-content: center;
			opacity: 0;
			transform: translateY(6px);
			transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
			box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
		}
		.lx-playlist-card:hover .lx-playlist-play-hover {
			opacity: 1;
			transform: translateY(0);
		}
		.lx-playlist-card-title {
			font-size: 12px;
			font-weight: 500;
			color: var(--text, #f8fafc);
			line-height: 1.4;
			height: 34px;
			overflow: hidden;
			text-overflow: ellipsis;
			display: -webkit-box;
			-webkit-line-clamp: 2;
			-webkit-box-orient: vertical;
			margin-bottom: 4px;
		}
		.lx-playlist-card-sub {
			font-size: 11px;
			color: var(--text-faint, #64748b);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		/* 歌单详情 Banner */
		.lx-playlist-detail-banner {
			display: flex;
			align-items: flex-start;
			gap: 16px;
			padding: 12px 14px;
			background: rgba(255, 255, 255, 0.02);
			border: 1px solid var(--border, rgba(255, 255, 255, 0.06));
			border-radius: 10px;
			flex-shrink: 0;
			margin-bottom: 12px;
		}
		.lx-detail-cover {
			width: 90px;
			height: 90px;
			border-radius: 8px;
			object-fit: cover;
			box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
			flex-shrink: 0;
		}
		.lx-detail-info {
			flex: 1;
			min-width: 0;
			display: flex;
			flex-direction: column;
			gap: 4px;
		}
		.lx-detail-title {
			font-size: 15px;
			font-weight: 700;
			color: var(--text, #f8fafc);
			margin: 0;
			line-height: 1.3;
		}
		.lx-detail-meta {
			font-size: 11.5px;
			color: var(--text-faint, #94a3b8);
			display: flex;
			align-items: center;
			gap: 10px;
			flex-wrap: wrap;
		}
		.lx-detail-desc {
			font-size: 11px;
			color: var(--text-faint, #64748b);
			line-height: 1.45;
			max-height: 32px;
			overflow: hidden;
			text-overflow: ellipsis;
			display: -webkit-box;
			-webkit-line-clamp: 2;
			-webkit-box-orient: vertical;
			margin: 0;
		}
		.lx-back-btn {
			align-self: flex-start;
		}

		/* 列表操作顶栏 */
		.lx-list-action-bar {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding-bottom: 8px;
			margin-bottom: 6px;
			border-bottom: 1px solid rgba(255, 255, 255, 0.04);
		}
		.lx-list-left-actions {
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.lx-list-count {
			font-size: 11.5px;
			color: var(--text-faint, #64748b);
			white-space: nowrap;
		}

		/* 主体内容布局 */
		.lx-main {
			position: relative;
			z-index: 5;
			display: flex;
			flex: 1;
			min-height: 0;
			overflow: hidden;
		}
		.lx-song-list-wrap {
			flex: 1;
			overflow-y: auto;
			padding: 12px 20px;
			min-width: 0;
		}
		.lx-lyrics-panel {
			width: 290px;
			max-width: 34%;
			background: var(--card, rgba(20, 24, 38, 0.72));
			backdrop-filter: blur(28px);
			-webkit-backdrop-filter: blur(28px);
			border-left: 1px solid var(--border, rgba(255, 255, 255, 0.08));
			display: flex;
			flex-direction: column;
			align-items: center;
			padding: 18px 16px;
			overflow: hidden;
			flex-shrink: 0;
		}
		@media (max-width: 860px) {
			.lx-lyrics-panel {
				display: none;
			}
		}

		/* 歌曲表格 - 悬浮圆角卡片化，定宽防纵向折行 */
		.lx-table {
			width: 100%;
			table-layout: fixed;
			border-collapse: separate;
			border-spacing: 0 4px;
			font-size: 12px;
		}
		.lx-table th {
			text-align: left;
			padding: 6px 10px;
			color: var(--text-faint, #64748b);
			font-weight: 500;
			font-size: 11px;
			border-bottom: 1px solid rgba(255, 255, 255, 0.04);
			white-space: nowrap;
		}
		.lx-table tr {
			border-radius: 6px;
			cursor: pointer;
			transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
		}
		.lx-table td {
			padding: 8px 10px;
			color: var(--text, #f8fafc);
			background: rgba(255, 255, 255, 0.015);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			vertical-align: middle;
		}
		.lx-table tr td:first-child {
			border-top-left-radius: 6px;
			border-bottom-left-radius: 6px;
		}
		.lx-table tr td:last-child {
			border-top-right-radius: 6px;
			border-bottom-right-radius: 6px;
		}
		.lx-table tr:hover td {
			background: rgba(255, 255, 255, 0.07);
		}
		.lx-table tr:active td {
			background: rgba(255, 255, 255, 0.11);
		}
		.lx-table tr.playing-row td {
			background: rgba(59, 130, 246, 0.14);
		}
		.lx-row-idx {
			color: var(--text-faint, #64748b);
		}
		.lx-song-name {
			font-weight: 600;
			color: #ffffff;
			display: flex;
			align-items: center;
			gap: 8px;
			overflow: hidden;
		}
		.lx-song-title-text {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.lx-sq-badge {
			font-size: 9.5px;
			padding: 1px 4px;
			border-radius: 3px;
			background: rgba(245, 158, 11, 0.15);
			color: #fbbf24;
			border: 1px solid rgba(245, 158, 11, 0.3);
			font-weight: 600;
			flex-shrink: 0;
		}
		.lx-fav-btn {
			background: transparent;
			border: none;
			cursor: pointer;
			padding: 2px;
			font-size: 13px;
			transition: transform 0.15s;
			flex-shrink: 0;
		}
		.lx-fav-btn:hover {
			transform: scale(1.2);
		}
		.lx-singer {
			color: var(--text-faint, #94a3b8);
		}
		.lx-album {
			color: var(--text-faint, #64748b);
		}
		.lx-duration {
			color: var(--text-faint, #64748b);
			font-variant-numeric: tabular-nums;
		}
		.lx-table-actions {
			display: flex;
			gap: 4px;
			justify-content: flex-end;
		}
		.lx-icon-btn {
			background: transparent;
			border: none;
			color: var(--text-faint, #94a3b8);
			cursor: pointer;
			padding: 4px;
			border-radius: 4px;
			display: flex;
			align-items: center;
			transition: all 0.2s;
		}
		.lx-icon-btn:hover {
			color: #ffffff;
			background: rgba(255, 255, 255, 0.1);
		}

		/* 正在播放的 3 段动态音频跳动频谱柱 (Equalizer) */
		.lx-spectrum-anim {
			display: inline-flex;
			align-items: flex-end;
			gap: 2px;
			height: 12px;
			width: 12px;
			flex-shrink: 0;
		}
		.lx-spectrum-bar {
			width: 2.5px;
			background: var(--accent, #60a5fa);
			border-radius: 1px;
			animation: lxEqWave 0.9s ease-in-out infinite alternate;
		}
		.lx-spectrum-bar:nth-child(1) { height: 40%; animation-duration: 0.6s; }
		.lx-spectrum-bar:nth-child(2) { height: 95%; animation-duration: 0.8s; }
		.lx-spectrum-bar:nth-child(3) { height: 65%; animation-duration: 0.5s; }
		@keyframes lxEqWave {
			0% { height: 20%; }
			100% { height: 100%; }
		}

		/* 歌词与唱片右面板 */
		.lx-cover-ambient-wrap {
			position: relative;
			margin-bottom: 14px;
			display: flex;
			justify-content: center;
		}
		.lx-cover-ambient-glow {
			position: absolute;
			width: 120px;
			height: 120px;
			border-radius: 50%;
			background: radial-gradient(circle, rgba(59, 130, 246, 0.45) 0%, transparent 70%);
			filter: blur(22px);
			z-index: 1;
		}
		.lx-cover-disc {
			position: relative;
			z-index: 2;
			width: 120px;
			height: 120px;
			border-radius: 10px;
			background: #0f121a;
			box-shadow: 0 10px 24px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.1);
			overflow: hidden;
			display: flex;
			align-items: center;
			justify-content: center;
			animation: lxRotateDisc 18s linear infinite;
			animation-play-state: paused;
		}
		.lx-cover-disc.playing {
			animation-play-state: running;
		}
		.lx-cover-disc img {
			width: 100%;
			height: 100%;
			object-fit: cover;
		}
		@keyframes lxRotateDisc {
			from { transform: rotate(0deg); }
			to { transform: rotate(360deg); }
		}
		.lx-lyrics-scroll {
			flex: 1;
			width: 100%;
			overflow-y: auto;
			text-align: center;
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 12px;
			padding: 16px 0;
			mask-image: linear-gradient(to bottom, transparent 0%, black 18%, black 82%, transparent 100%);
			-webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 18%, black 82%, transparent 100%);
		}
		.lx-lrc-line {
			color: rgba(255, 255, 255, 0.32);
			font-size: 13px;
			font-weight: 500;
			cursor: pointer;
			transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
			line-height: 1.4;
		}
		.lx-lrc-line:hover {
			color: rgba(255, 255, 255, 0.7);
		}
		.lx-lrc-line.active {
			color: #ffffff;
			font-weight: 700;
			font-size: 15.5px;
			transform: scale(1.06);
			text-shadow: 0 2px 14px rgba(96, 165, 250, 0.5);
		}

		/* 底部播放条 */
		.lx-footer {
			position: relative;
			z-index: 10;
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 10px 20px;
			background: var(--card, rgba(20, 24, 38, 0.72));
			backdrop-filter: blur(28px);
			-webkit-backdrop-filter: blur(28px);
			border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
			flex-shrink: 0;
			gap: 14px;
		}
		.lx-footer-left {
			display: flex;
			align-items: center;
			gap: 10px;
			width: 220px;
			min-width: 160px;
			overflow: hidden;
		}
		.lx-bar-cover {
			width: 40px;
			height: 40px;
			border-radius: 6px;
			object-fit: cover;
			background: #1e293b;
			box-shadow: 0 3px 8px rgba(0, 0, 0, 0.3);
			flex-shrink: 0;
		}
		.lx-bar-info {
			display: flex;
			flex-direction: column;
			gap: 2px;
			min-width: 0;
			overflow: hidden;
		}
		.lx-bar-song-name {
			font-size: 12.5px;
			font-weight: 600;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			color: #ffffff;
		}
		.lx-bar-singer {
			font-size: 11px;
			color: var(--text-faint, #94a3b8);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.lx-footer-center {
			flex: 1;
			max-width: 500px;
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 6px;
		}
		.lx-ctrl-btns {
			display: flex;
			align-items: center;
			gap: 16px;
		}
		.lx-play-main-btn {
			width: 36px;
			height: 36px;
			border-radius: 50%;
			background: #ffffff;
			color: #0f172a;
			border: none;
			display: flex;
			align-items: center;
			justify-content: center;
			cursor: pointer;
			box-shadow: 0 3px 12px rgba(255, 255, 255, 0.25);
			transition: transform 0.15s;
		}
		.lx-play-main-btn:hover {
			transform: scale(1.08);
		}
		.lx-progress-bar-wrap {
			width: 100%;
			display: flex;
			align-items: center;
			gap: 10px;
			font-size: 10.5px;
			color: var(--text-faint, #64748b);
			font-variant-numeric: tabular-nums;
		}
		.lx-progress-track {
			flex: 1;
			height: 4px;
			background: rgba(255, 255, 255, 0.12);
			border-radius: 3px;
			position: relative;
			cursor: pointer;
			transition: height 0.15s;
		}
		.lx-progress-track:hover {
			height: 6px;
		}
		.lx-progress-inner {
			position: absolute;
			left: 0;
			top: 0;
			height: 100%;
			width: 0%;
			background: linear-gradient(90deg, var(--accent, #3b82f6), #818cf8);
			border-radius: 3px;
		}
		.lx-footer-right {
			display: flex;
			align-items: center;
			gap: 12px;
			width: 220px;
			justify-content: flex-end;
		}
		.lx-vol-slider {
			width: 65px;
			accent-color: var(--accent, #3b82f6);
			cursor: pointer;
		}
		.lx-quality-select {
			color-scheme: dark;
			background: var(--card, #1a1e2e);
			border: 1px solid var(--border, rgba(255, 255, 255, 0.15));
			color: var(--text, #f8fafc);
			border-radius: 4px;
			padding: 2px 6px;
			font-size: 11px;
			outline: none;
			cursor: pointer;
		}
		.lx-quality-select option {
			background: #141724;
			color: #f8fafc;
			padding: 4px 8px;
		}

		/* 轻量非阻断 Toast 提示框 */
		.lx-toast {
			position: absolute;
			bottom: 75px;
			left: 50%;
			transform: translateX(-50%) translateY(20px);
			background: rgba(20, 24, 38, 0.94);
			border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
			color: var(--text, #f8fafc);
			padding: 7px 16px;
			border-radius: 20px;
			font-size: 12px;
			box-shadow: 0 8px 24px rgba(0,0,0,0.4);
			pointer-events: none;
			opacity: 0;
			transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
			z-index: 99999;
			backdrop-filter: blur(10px);
		}
		.lx-toast.show {
			opacity: 1;
			transform: translateX(-50%) translateY(0);
		}

		/* 模态框 */
		.lx-modal-mask {
			position: fixed;
			top: 0;
			left: 0;
			width: 100%;
			height: 100%;
			background: rgba(0,0,0,0.65);
			backdrop-filter: blur(4px);
			display: none;
			align-items: center;
			justify-content: center;
			z-index: 9999;
		}
		.lx-modal {
			background: var(--card, #141826);
			border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
			border-radius: 12px;
			width: 540px;
			max-width: 92%;
			max-height: 85vh;
			overflow-y: auto;
			padding: 20px;
			display: flex;
			flex-direction: column;
			gap: 14px;
			box-shadow: 0 20px 40px rgba(0,0,0,0.6);
		}
		.lx-modal-title {
			font-size: 15px;
			font-weight: 700;
		}
		.lx-userapi-section {
			display: flex;
			flex-direction: column;
			gap: 8px;
		}
		.lx-userapi-sec-title {
			font-size: 13px;
			font-weight: 600;
			color: var(--text, #f8fafc);
			display: flex;
			align-items: center;
			justify-content: space-between;
		}
		.lx-userapi-rec-card {
			display: flex;
			align-items: center;
			justify-content: space-between;
			background: rgba(255, 255, 255, 0.04);
			border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
			border-radius: 8px;
			padding: 8px 12px;
			gap: 10px;
		}
		.lx-userapi-rec-info {
			display: flex;
			flex-direction: column;
			gap: 2px;
			flex: 1;
			min-width: 0;
		}
		.lx-userapi-rec-name {
			font-size: 13px;
			font-weight: 600;
			display: flex;
			align-items: center;
			gap: 6px;
		}
		.lx-userapi-rec-desc {
			font-size: 11px;
			color: var(--text-faint, #7e8798);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.lx-status-pill {
			font-size: 10px;
			padding: 1px 6px;
			border-radius: 4px;
			font-weight: 500;
		}
		.lx-status-healthy {
			background: rgba(34, 197, 94, 0.15);
			color: #4ade80;
			border: 1px solid rgba(34, 197, 94, 0.3);
		}
		.lx-status-dead {
			background: rgba(239, 68, 68, 0.15);
			color: #f87171;
			border: 1px solid rgba(239, 68, 68, 0.3);
		}
		.lx-textarea {
			width: 100%;
			height: 140px;
			background: rgba(0, 0, 0, 0.3);
			border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
			color: var(--text, #f8fafc);
			border-radius: 6px;
			padding: 8px;
			font-family: monospace;
			font-size: 12px;
			resize: vertical;
			outline: none;
		}
		.lx-textarea:focus {
			border-color: var(--accent, #3b82f6);
		}
	`;
}

function renderApp(el) {
	el.innerHTML = `
		<style>${buildStyles()}</style>
		<div class="lx-wrap">
			<!-- 弥散背景动态流光 (方案 A: Liquid Glass) -->
			<div class="lx-ambient-glow">
				<div class="lx-glow-orb-1"></div>
				<div class="lx-glow-orb-2"></div>
			</div>

			<!-- 头部主导航 -->
			<div class="lx-header">
				<div class="lx-brand">
					<div class="lx-brand-icon">
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
							<path d="M9 18V5l12-2v13"></path>
							<circle cx="6" cy="18" r="3"></circle>
							<circle cx="18" cy="16" r="3"></circle>
						</svg>
					</div>
					<span>洛雪音乐</span>
				</div>

				<div class="lx-nav-tabs" id="lx-nav-tabs">
					<button class="lx-nav-tab active" data-tab="search">🔍 搜索</button>
					<button class="lx-nav-tab" data-tab="top">🔥 排行榜</button>
					<button class="lx-nav-tab" data-tab="playlist">🎶 歌单</button>
					<button class="lx-nav-tab" data-tab="favorites">❤️ 我的收藏</button>
					<button class="lx-nav-tab" data-tab="queue">📋 播放队列</button>
					<button class="lx-nav-tab" data-tab="history">🕘 播放记录</button>
				</div>

				<div class="lx-search-box" id="lx-search-box-wrap">
					<input type="text" id="lx-search-input" class="lx-search-input" placeholder="搜索歌曲、歌手、专辑..." />
					<button id="lx-search-btn" class="lx-search-btn" title="搜索">
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
					</button>
				</div>

				<div class="lx-action-btns">
					<span class="lx-api-badge" id="lx-active-api-badge">⚡ 自定义源</span>
					<button class="lx-btn" id="lx-open-userapi-btn">
						<span>🧩</span>
						<span>音源管理</span>
					</button>
				</div>
			</div>

			<!-- 次级栏 (音源、榜单与歌单分类) -->
			<div class="lx-sub-bar" id="lx-sub-bar">
				<!-- 搜索源 Pills -->
				<div class="lx-pill-group" id="lx-source-pills">
					<span style="color: var(--text-faint, #64748b); margin-right: 4px;">音源平台:</span>
					<button class="lx-pill-btn active" data-src="wy">网易云</button>
					<button class="lx-pill-btn" data-src="tx">QQ音乐</button>
					<button class="lx-pill-btn" data-src="kw">酷我</button>
					<button class="lx-pill-btn" data-src="kg">酷狗</button>
					<button class="lx-pill-btn" data-src="mg">咪咕</button>
				</div>

				<!-- 排行榜的平台与榜单选择 Pills -->
				<div class="lx-pill-group" id="lx-top-pills" style="display: none; flex-wrap: wrap; gap: 6px;">
					<div class="lx-pill-subgroup">
						<span style="color: var(--text-faint, #64748b); margin-right: 4px;">平台:</span>
						<button class="lx-pill-btn active" data-top-src="wy">网易云</button>
						<button class="lx-pill-btn" data-top-src="tx">QQ音乐</button>
						<button class="lx-pill-btn" data-top-src="kw">酷我</button>
						<button class="lx-pill-btn" data-top-src="kg">酷狗</button>
					</div>
					<div class="lx-pill-divider"></div>
					<div class="lx-pill-subgroup" id="lx-top-board-pills">
						<span style="color: var(--text-faint, #64748b); margin-right: 4px;">榜单:</span>
						<button class="lx-pill-btn active" data-chart="hot">🔥 热歌榜</button>
						<button class="lx-pill-btn" data-chart="soar">🚀 飙升榜</button>
						<button class="lx-pill-btn" data-chart="new">🌟 新歌榜</button>
					</div>
				</div>

				<!-- 歌单的平台与分类标签 Pills -->
				<div class="lx-pill-group" id="lx-playlist-pills" style="display: none; flex-wrap: wrap; gap: 6px;">
					<div class="lx-pill-subgroup">
						<span style="color: var(--text-faint, #64748b); margin-right: 4px;">平台:</span>
						<button class="lx-pill-btn active" data-pl-src="wy">网易云</button>
						<button class="lx-pill-btn" data-pl-src="tx">QQ音乐</button>
						<button class="lx-pill-btn" data-pl-src="kw">酷我</button>
						<button class="lx-pill-btn" data-pl-src="kg">酷狗</button>
					</div>
					<div class="lx-pill-divider"></div>
					<div class="lx-pill-subgroup" id="lx-playlist-tag-pills">
						<span style="color: var(--text-faint, #64748b); margin-right: 4px;">分类:</span>
						<button class="lx-pill-btn active" data-pl-tag="全部">全部</button>
					</div>
				</div>

				<div style="color: var(--text-faint, #64748b); font-size: 11px; margin-left: auto;">
					快捷键: 空格(播放/暂停) · 方向键(快进/音量)
				</div>
			</div>

			<!-- 中间主视图 -->
			<div class="lx-main">
				<!-- 歌单卡片网格列表视图 -->
				<div class="lx-playlist-grid-wrap" id="lx-playlist-grid-wrap" style="display: none;">
					<div class="lx-playlist-grid-header">
						<div style="display: flex; align-items: center; gap: 10px;">
							<span id="lx-playlist-category-title" class="lx-playlist-category-title">精选热门歌单</span>
							<span id="lx-playlist-count-badge" class="lx-pill-btn" style="font-size: 10.5px; pointer-events: none;">0 个歌单</span>
						</div>
						<div style="display: flex; gap: 8px;">
							<button class="lx-btn" id="lx-import-playlist-btn" title="输入网易云/QQ/酷我/酷狗歌单链接或ID快速打开">
								<span>🔗</span>
								<span>导入/直达歌单</span>
							</button>
							<button class="lx-btn" id="lx-refresh-playlist-btn" title="刷新歌单列表">
								<span>🔄</span>
								<span>刷新</span>
							</button>
						</div>
					</div>
					<div class="lx-playlist-cards" id="lx-playlist-cards">
						<!-- 动态渲染歌单卡片 -->
					</div>
				</div>

				<!-- 歌曲列表包裹层 (支持歌单详情 Banner 和歌曲表格) -->
				<div class="lx-song-list-wrap" id="lx-song-list-wrap">
					<!-- 歌单详情 Banner (当在歌单详情中时展示) -->
					<div class="lx-playlist-detail-banner" id="lx-playlist-detail-banner" style="display: none;">
						<img id="lx-detail-cover" class="lx-detail-cover" src="" alt="cover" />
						<div class="lx-detail-info">
							<div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
								<h2 id="lx-detail-title" class="lx-detail-title">歌单详情</h2>
								<button class="lx-btn lx-back-btn" id="lx-back-playlist-btn" title="返回歌单列表">
									<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
									<span>返回歌单</span>
								</button>
							</div>
							<div class="lx-detail-meta" id="lx-detail-meta"></div>
							<p class="lx-detail-desc" id="lx-detail-desc"></p>
						</div>
					</div>

					<!-- 列表操作顶栏 (一键播放全部) -->
					<div class="lx-list-action-bar">
						<div class="lx-list-left-actions">
							<button class="lx-btn-primary" id="lx-play-all-btn">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
								<span>播放全部</span>
							</button>
							<button class="lx-btn" id="lx-add-all-btn" title="将当前列表整张加入播放队列(无确认框)">
								<span>➕ 全部入队</span>
							</button>
							<button class="lx-btn" id="lx-clear-queue-btn" style="display: none;" title="清空播放队列">
								<span>🗑️ 清空队列</span>
							</button>
						</div>
						<div class="lx-list-count" id="lx-list-count">共 0 首歌曲</div>
					</div>

					<table class="lx-table">
						<colgroup>
							<col style="width: 44px;">
							<col style="width: 42%;">
							<col style="width: 22%;">
							<col style="width: 20%;">
							<col style="width: 60px;">
							<col style="width: 100px;">
						</colgroup>
						<thead>
							<tr>
								<th style="text-align: center;">#</th>
								<th>歌曲标题</th>
								<th>歌手</th>
								<th>专辑</th>
								<th>时长</th>
								<th style="text-align: right;">操作</th>
							</tr>
						</thead>
						<tbody id="lx-song-table-body">
							<tr>
								<td colspan="6" style="text-align: center; color: var(--text-faint, #7e8798); padding: 40px;">
									输入关键词开始搜索音乐
								</td>
							</tr>
						</tbody>
					</table>
				</div>

				<!-- 歌词与唱片右面板 -->
				<div class="lx-lyrics-panel">
					<div class="lx-cover-ambient-wrap">
						<div class="lx-cover-ambient-glow"></div>
						<div class="lx-cover-disc" id="lx-cover-disc">
							<img id="lx-disc-img" src="" alt="Album Cover" />
						</div>
					</div>
					<div class="lx-lyrics-scroll" id="lx-lyrics-scroll">
						<div class="lx-lrc-line">暂无歌词</div>
					</div>
				</div>
			</div>

			<!-- 底部播放栏 -->
			<div class="lx-footer">
				<div class="lx-footer-left">
					<img class="lx-bar-cover" id="lx-bar-cover" src="" alt="Cover" />
					<div class="lx-bar-info">
						<div class="lx-bar-song-name" id="lx-bar-song-name">洛雪音乐</div>
						<div class="lx-bar-singer" id="lx-bar-singer">选择一首歌曲开始播放</div>
					</div>
				</div>

				<div class="lx-footer-center">
					<div class="lx-ctrl-btns">
						<button class="lx-icon-btn" id="lx-mode-btn" title="列表循环">
							<span id="lx-mode-icon">🔁</span>
						</button>
						<button class="lx-icon-btn" id="lx-prev-btn" title="上一首 (Ctrl+Left)">
							<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" stroke-width="2.5"/></svg>
						</button>
						<button class="lx-play-main-btn" id="lx-play-btn" title="播放/暂停 (Space)">
							<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
						</button>
						<button class="lx-icon-btn" id="lx-next-btn" title="下一首 (Ctrl+Right)">
							<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2.5"/></svg>
						</button>
						<button class="lx-icon-btn" id="lx-pip-btn" title="开启桌面画中画悬浮歌词">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><rect x="12" y="9" width="8" height="6" rx="1"/></svg>
						</button>
					</div>

					<div class="lx-progress-bar-wrap">
						<span id="lx-cur-time">00:00</span>
						<div class="lx-progress-track" id="lx-progress-track">
							<div class="lx-progress-inner" id="lx-progress-bar-inner"></div>
						</div>
						<span id="lx-dur-time">00:00</span>
					</div>
				</div>

				<div class="lx-footer-right">
					<select class="lx-quality-select" id="lx-quality-select" title="音质选择">
						<option value="128k">标准 128k</option>
						<option value="320k" selected>高品 320k</option>
						<option value="flac">无损 FLAC</option>
						<option value="hires">Hi-Res 母带</option>
					</select>

					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
					<input type="range" class="lx-vol-slider" id="lx-vol-slider" min="0" max="1" step="0.05" value="0.8" />
				</div>
			</div>

			<!-- 自定义音源弹窗 (支持社区推荐优质源与在线健康诊断) -->
			<div class="lx-modal-mask" id="lx-userapi-modal">
				<div class="lx-modal">
					<div class="lx-modal-title">自定义音源与高音质管理</div>

					<!-- 当前音源状态与测试 -->
					<div class="lx-userapi-section" id="lx-current-api-section" style="display: none; background: rgba(0,0,0,0.25); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;">
						<div class="lx-userapi-sec-title">
							<span>当前活跃音源</span>
							<button class="lx-btn" id="lx-probe-btn" style="padding: 2px 8px; font-size: 11px;">🔍 测试可用性</button>
						</div>
						<div id="lx-current-api-desc" style="font-size: 12px; color: var(--text-faint);"></div>
						<div id="lx-probe-result" style="font-size: 11px; display: none; margin-top: 4px; padding: 4px 8px; border-radius: 4px;"></div>
					</div>

					<!-- 社区推荐可用音源 -->
					<div class="lx-userapi-section">
						<div class="lx-userapi-sec-title">
							<span>社区精选音源 (来自 lx-music-source)</span>
							<span style="font-size: 11px; color: var(--text-faint);">实时稳定 · 高品质推荐</span>
						</div>
						<div id="lx-rec-sources-list" style="display: flex; flex-direction: column; gap: 6px;">
							<!-- 动态注入推荐音源卡片 -->
						</div>
					</div>

					<!-- 手动自定义导入 -->
					<div class="lx-userapi-section">
						<div class="lx-userapi-sec-title">
							<span>手动导入脚本或 URL</span>
						</div>
						<div style="font-size: 11px; color: var(--text-faint, #7e8798);">
							支持直接粘贴音源 JS 代码，或输入 GitHub raw 脚本 URL。
						</div>
						<textarea class="lx-textarea" id="lx-userapi-script" style="height: 80px;" placeholder="粘贴 JS 源码，或输入 https://raw.githubusercontent.com/..."></textarea>
					</div>

					<div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px;">
						<button class="lx-btn" id="lx-modal-close-btn">关闭</button>
						<button class="lx-btn" id="lx-modal-save-btn" style="background: var(--accent); color: var(--accent-contrast);">导入并激活</button>
					</div>
				</div>
			</div>

			<!-- 导入/直达歌单弹窗 -->
			<div class="lx-modal-mask" id="lx-import-playlist-modal">
				<div class="lx-modal" style="width: 460px;">
					<div class="lx-modal-title">🔗 导入 / 直达歌单</div>
					<div style="font-size: 11.5px; color: var(--text-faint, #94a3b8); line-height: 1.5;">
						输入各大音乐平台的歌单分享链接或歌单 ID，即可立即在线解析并试听整份歌单：
					</div>
					<div style="display: flex; gap: 8px; align-items: center;">
						<span style="font-size: 12px; color: var(--text-faint, #64748b);">所属平台:</span>
						<select class="lx-quality-select" id="lx-import-source" style="flex: 1;">
							<option value="wy">网易云音乐 (163.com)</option>
							<option value="tx">QQ音乐 (qq.com)</option>
							<option value="kw">酷我音乐 (kuwo.cn)</option>
							<option value="kg">酷狗音乐 (kugou.com)</option>
						</select>
					</div>
					<input type="text" class="lx-search-input" id="lx-import-input" style="width: 100%; border-radius: 6px;" placeholder="粘贴歌单链接或纯数字歌单ID..." />
					<div style="font-size: 10.5px; color: var(--text-faint, #64748b);">
						支持如：https://music.163.com/#/playlist?id=3778678 或直接输入 3778678
					</div>
					<div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px;">
						<button class="lx-btn" id="lx-import-modal-close-btn">取消</button>
						<button class="lx-btn-primary" id="lx-import-modal-confirm-btn">立即打开</button>
					</div>
				</div>
			</div>
		</div>
	`;
}

function bindEvents(rootEl) {
	// 1. 页签导航切换 (搜索 / 排行榜 / 我的收藏 / 播放队列)
	// 格式化播放量
	const formatPlayCount = (num) => {
		const n = parseInt(num || "0", 10);
		if (isNaN(n) || n <= 0) return "";
		if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
		if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
		return String(n);
	};

	const sourcePills = rootEl.querySelector("#lx-source-pills");
	const topPills = rootEl.querySelector("#lx-top-pills");
	const topBoardPills = rootEl.querySelector("#lx-top-board-pills");
	const playlistPills = rootEl.querySelector("#lx-playlist-pills");
	const playlistTagPills = rootEl.querySelector("#lx-playlist-tag-pills");
	const searchBoxWrap = rootEl.querySelector("#lx-search-box-wrap");
	const playlistGridWrap = rootEl.querySelector("#lx-playlist-grid-wrap");
	const playlistCards = rootEl.querySelector("#lx-playlist-cards");
	const playlistDetailBanner = rootEl.querySelector("#lx-playlist-detail-banner");
	const songListWrap = rootEl.querySelector("#lx-song-list-wrap");

	// 1. 页签导航切换 (搜索 / 排行榜 / 歌单 / 我的收藏 / 播放队列 / 播放记录)
	const tabs = rootEl.querySelectorAll(".lx-nav-tab");

	const updateViewTabUI = () => {
		const tab = globalState.activeViewTab;
		sourcePills.style.display = tab === "search" ? "flex" : "none";
		topPills.style.display = tab === "top" ? "flex" : "none";
		playlistPills.style.display = tab === "playlist" ? "flex" : "none";
		searchBoxWrap.style.display = tab === "search" ? "flex" : "none";

		if (tab === "playlist") {
			if (globalState.activePlaylistDetail) {
				playlistGridWrap.style.display = "none";
				playlistDetailBanner.style.display = "flex";
				songListWrap.style.display = "block";
				renderCurrentTable();
			} else {
				playlistGridWrap.style.display = "flex";
				playlistDetailBanner.style.display = "none";
				songListWrap.style.display = "none";
				loadPlaylistTags(globalState.playlistSource);
				loadPlaylists(globalState.playlistSource, globalState.playlistTag);
			}
		} else {
			playlistGridWrap.style.display = "none";
			playlistDetailBanner.style.display = "none";
			songListWrap.style.display = "block";

			if (tab === "top") {
				loadTopLists(globalState.topChartSource);
			} else {
				renderCurrentTable();
			}
		}
	};

	tabs.forEach((tab) => {
		tab.addEventListener("click", () => {
			tabs.forEach((t) => t.classList.remove("active"));
			tab.classList.add("active");
			globalState.activeViewTab = tab.dataset.tab;
			updateViewTabUI();
		});
	});

	// 2. 音源平台切换 (搜索)
	const srcBtns = rootEl.querySelectorAll(".lx-pill-btn[data-src]");
	srcBtns.forEach((btn) => {
		btn.addEventListener("click", () => {
			srcBtns.forEach((b) => b.classList.remove("active"));
			btn.classList.add("active");
			globalState.source = btn.dataset.src;
			triggerSearch();
		});
	});

	// 3. 排行榜平台切换与榜单动态渲染
	const topSrcBtns = rootEl.querySelectorAll(".lx-pill-btn[data-top-src]");
	topSrcBtns.forEach((btn) => {
		btn.addEventListener("click", () => {
			topSrcBtns.forEach((b) => b.classList.remove("active"));
			btn.classList.add("active");
			globalState.topChartSource = btn.dataset.topSrc;
			globalState.topChartBangId = "";
			loadTopLists(globalState.topChartSource);
		});
	});

	const loadTopLists = async (source) => {
		topBoardPills.innerHTML = `<span style="color: var(--text-faint, #64748b); margin-right: 4px;">榜单:</span><span style="color: var(--text-faint); font-size: 11px;">加载中...</span>`;
		let boards = globalState.topListsMap[source];
		if (!boards || !boards.length) {
			try {
				const res = await fetch(`${apiBaseUrl}/top-lists?source=${source}`).then((r) => r.json());
				if (res.ok && res.lists) {
					boards = res.lists;
					globalState.topListsMap[source] = boards;
				}
			} catch {}
		}

		if (!boards || !boards.length) {
			boards = [
				{ id: "hot", name: "🔥 热歌榜" },
				{ id: "soar", name: "🚀 飙升榜" },
				{ id: "new", name: "🌟 新歌榜" },
			];
		}

		if (!globalState.topChartBangId || !boards.some((b) => b.id === globalState.topChartBangId)) {
			globalState.topChartBangId = boards[0].id;
		}

		topBoardPills.innerHTML = `<span style="color: var(--text-faint, #64748b); margin-right: 4px;">榜单:</span>`;
		boards.slice(0, 16).forEach((board) => {
			const bBtn = document.createElement("button");
			bBtn.className = `lx-pill-btn ${board.id === globalState.topChartBangId ? "active" : ""}`;
			bBtn.textContent = board.name;
			bBtn.title = board.name;
			bBtn.addEventListener("click", () => {
				topBoardPills.querySelectorAll(".lx-pill-btn").forEach((b) => b.classList.remove("active"));
				bBtn.classList.add("active");
				globalState.topChartBangId = board.id;
				loadTopChart(source, board.id);
			});
			topBoardPills.appendChild(bBtn);
		});

		loadTopChart(source, globalState.topChartBangId);
	};

	const loadTopChart = async (source, bangId) => {
		const tbody = rootEl.querySelector("#lx-song-table-body");
		tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 40px; color: var(--text-faint);">正在获取排行榜歌曲...</td></tr>`;
		try {
			const res = await fetch(
				`${apiBaseUrl}/top-list?source=${source}&bangId=${encodeURIComponent(bangId)}&limit=60`,
			).then((r) => r.json());
			if (res.ok && res.songs) {
				globalState.topChartSongs = res.songs;
				renderCurrentTable();
			} else {
				tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--err-text, #f87171); padding: 40px;">获取排行榜歌曲失败</td></tr>`;
			}
		} catch (err) {
			tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--err-text, #f87171); padding: 40px;">加载排行榜失败: ${err.message}</td></tr>`;
		}
	};

	// 4. 歌单相关事件与加载
	const plSrcBtns = rootEl.querySelectorAll(".lx-pill-btn[data-pl-src]");
	plSrcBtns.forEach((btn) => {
		btn.addEventListener("click", () => {
			plSrcBtns.forEach((b) => b.classList.remove("active"));
			btn.classList.add("active");
			globalState.playlistSource = btn.dataset.plSrc;
			globalState.playlistTag = "全部";
			globalState.activePlaylistDetail = null;
			updateViewTabUI();
		});
	});

	const loadPlaylistTags = async (source) => {
		let tags = globalState.playlistTagsMap[source];
		if (!tags || !tags.length) {
			try {
				const res = await fetch(`${apiBaseUrl}/playlist/tags?source=${source}`).then((r) => r.json());
				if (res.ok && res.tags) {
					tags = res.tags;
					globalState.playlistTagsMap[source] = tags;
				}
			} catch {}
		}
		if (!tags || !tags.length) {
			tags = ["全部", "热门", "华语", "流行", "民谣", "轻音乐"];
		}

		playlistTagPills.innerHTML = `<span style="color: var(--text-faint, #64748b); margin-right: 4px;">分类:</span>`;
		tags.forEach((tag) => {
			const tBtn = document.createElement("button");
			tBtn.className = `lx-pill-btn ${tag === globalState.playlistTag ? "active" : ""}`;
			tBtn.textContent = tag;
			tBtn.addEventListener("click", () => {
				playlistTagPills.querySelectorAll(".lx-pill-btn").forEach((b) => b.classList.remove("active"));
				tBtn.classList.add("active");
				globalState.playlistTag = tag;
				loadPlaylists(source, tag);
			});
			playlistTagPills.appendChild(tBtn);
		});
	};

	const loadPlaylists = async (source, tag, page = 1) => {
		playlistCards.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-faint);">正在加载精选歌单...</div>`;
		try {
			const res = await fetch(
				`${apiBaseUrl}/playlist/list?source=${source}&tag=${encodeURIComponent(tag)}&page=${page}&limit=30`,
			).then((r) => r.json());

			if (res.ok && Array.isArray(res.list) && res.list.length > 0) {
				globalState.playlists = res.list;
				const countBadge = rootEl.querySelector("#lx-playlist-count-badge");
				if (countBadge) countBadge.textContent = `${res.list.length} 个歌单`;
				renderPlaylistGrid(res.list);
			} else {
				playlistCards.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-faint);">未找到歌单数据</div>`;
			}
		} catch (err) {
			playlistCards.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--err-text, #f87171);">加载歌单失败: ${err.message}</div>`;
		}
	};

	const renderPlaylistGrid = (list) => {
		playlistCards.innerHTML = "";
		list.forEach((p) => {
			const card = document.createElement("div");
			card.className = "lx-playlist-card";
			const playCountText = formatPlayCount(p.playCount);

			card.innerHTML = `
				<div class="lx-playlist-cover-wrap">
					<img class="lx-playlist-cover" src="${p.pic || ""}" alt="${p.name}" loading="lazy" />
					${playCountText ? `<div class="lx-playlist-playcount"><span>🎧</span><span>${playCountText}</span></div>` : ""}
					<div class="lx-playlist-play-hover" title="直接播放整张歌单">
						<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
					</div>
				</div>
				<div class="lx-playlist-card-title" title="${p.name}">${p.name}</div>
				<div class="lx-playlist-card-sub">${p.author ? p.author : p.trackCount ? `${p.trackCount} 首歌曲` : "精选歌单"}</div>
			`;

			card.addEventListener("click", (e) => {
				if (e.target.closest(".lx-playlist-play-hover")) return;
				openPlaylistDetail(p.source || globalState.playlistSource, p.id);
			});

			const playHoverBtn = card.querySelector(".lx-playlist-play-hover");
			if (playHoverBtn) {
				playHoverBtn.addEventListener("click", async (e) => {
					e.stopPropagation();
					showToast(`正在加载并播放歌单: ${p.name}...`, 2000);
					try {
						const detailRes = await fetch(
							`${apiBaseUrl}/playlist/detail?source=${p.source || globalState.playlistSource}&id=${p.id}`,
						).then((r) => r.json());
						if (detailRes.ok && detailRes.playlist?.songs?.length) {
							globalState.queue = [...detailRes.playlist.songs];
							updateQueueBadge();
							playSong(detailRes.playlist.songs[0], false);
							showToast(`开始播放整份歌单 (共 ${detailRes.playlist.songs.length} 首)`);
						} else {
							showToast("歌单解析失败或暂无可播放歌曲");
						}
					} catch (err) {
						showToast(`歌单播放失败: ${err.message}`);
					}
				});
			}

			playlistCards.appendChild(card);
		});
	};

	const openPlaylistDetail = async (source, id) => {
		showToast("正在解析歌单歌曲...", 1500);
		try {
			const res = await fetch(`${apiBaseUrl}/playlist/detail?source=${source}&id=${id}`).then((r) => r.json());
			if (res.ok && res.playlist) {
				globalState.activePlaylistDetail = res.playlist;

				const coverEl = rootEl.querySelector("#lx-detail-cover");
				const titleEl = rootEl.querySelector("#lx-detail-title");
				const metaEl = rootEl.querySelector("#lx-detail-meta");
				const descEl = rootEl.querySelector("#lx-detail-desc");

				if (coverEl) coverEl.src = res.playlist.pic || "";
				if (titleEl) titleEl.textContent = res.playlist.name || "歌单详情";
				if (metaEl) {
					const author = res.playlist.author ? `创建者: ${res.playlist.author}` : "";
					const count = res.playlist.songs ? `共 ${res.playlist.songs.length} 首歌曲` : "";
					const playCount = res.playlist.playCount ? `播放: ${formatPlayCount(res.playlist.playCount)}` : "";
					metaEl.innerHTML = [author, count, playCount]
						.filter(Boolean)
						.map((t) => `<span>${t}</span>`)
						.join(" · ");
				}
				if (descEl) descEl.textContent = res.playlist.desc || "";

				updateViewTabUI();
			} else {
				showToast(`无法获取歌单详情: ${res.error || "未知原因"}`);
			}
		} catch (err) {
			showToast(`加载歌单详情失败: ${err.message}`);
		}
	};

	const backPlaylistBtn = rootEl.querySelector("#lx-back-playlist-btn");
	if (backPlaylistBtn) {
		backPlaylistBtn.addEventListener("click", () => {
			globalState.activePlaylistDetail = null;
			updateViewTabUI();
		});
	}

	const refreshPlaylistBtn = rootEl.querySelector("#lx-refresh-playlist-btn");
	if (refreshPlaylistBtn) {
		refreshPlaylistBtn.addEventListener("click", () => {
			loadPlaylists(globalState.playlistSource, globalState.playlistTag);
		});
	}

	// 导入/直达歌单功能
	const importPlaylistModal = rootEl.querySelector("#lx-import-playlist-modal");
	const importPlaylistBtn = rootEl.querySelector("#lx-import-playlist-btn");
	const importModalCloseBtn = rootEl.querySelector("#lx-import-modal-close-btn");
	const importModalConfirmBtn = rootEl.querySelector("#lx-import-modal-confirm-btn");
	const importSourceSelect = rootEl.querySelector("#lx-import-source");
	const importInput = rootEl.querySelector("#lx-import-input");

	if (importPlaylistBtn && importPlaylistModal) {
		importPlaylistBtn.addEventListener("click", () => {
			importPlaylistModal.style.display = "flex";
			if (importSourceSelect) importSourceSelect.value = globalState.playlistSource;
			if (importInput) {
				importInput.value = "";
				setTimeout(() => importInput.focus(), 50);
			}
		});

		importModalCloseBtn?.addEventListener("click", () => {
			importPlaylistModal.style.display = "none";
		});

		importPlaylistModal.addEventListener("click", (e) => {
			if (e.target === importPlaylistModal) importPlaylistModal.style.display = "none";
		});

		const handleDoImport = () => {
			const raw = (importInput?.value || "").trim();
			if (!raw) return showToast("请输入歌单链接或ID");

			let src = importSourceSelect?.value || "wy";
			let id = raw;

			if (raw.includes("163.com")) {
				src = "wy";
				const m = raw.match(/id=(\d+)/) || raw.match(/playlist\/(\d+)/);
				if (m) id = m[1];
			} else if (raw.includes("qq.com")) {
				src = "tx";
				const m = raw.match(/id=(\d+)/) || raw.match(/playlist\/(\d+)/) || raw.match(/disstid=(\d+)/);
				if (m) id = m[1];
			} else if (raw.includes("kugou.com")) {
				src = "kg";
				const m = raw.match(/single\/(\d+)/) || raw.match(/id=(\d+)/);
				if (m) id = m[1];
			} else if (raw.includes("kuwo.cn")) {
				src = "kw";
				const m = raw.match(/playlist(?:_detail)?\/(\d+)/) || raw.match(/pid=(\d+)/);
				if (m) id = m[1];
			} else {
				id = raw.replace(/[^0-9]/g, "");
			}

			if (!id) return showToast("未能识别出有效的歌单 ID，请检查链接或输入纯数字 ID");

			importPlaylistModal.style.display = "none";
			globalState.activeViewTab = "playlist";
			globalState.playlistSource = src;
			rootEl.querySelectorAll(".lx-nav-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === "playlist"));
			rootEl
				.querySelectorAll(".lx-pill-btn[data-pl-src]")
				.forEach((b) => b.classList.toggle("active", b.dataset.plSrc === src));
			openPlaylistDetail(src, id);
		};

		importModalConfirmBtn?.addEventListener("click", handleDoImport);
		importInput?.addEventListener("keydown", (e) => {
			if (e.key === "Enter") handleDoImport();
		});
	}

	// 4. 搜索
	const searchInput = rootEl.querySelector("#lx-search-input");
	const searchBtn = rootEl.querySelector("#lx-search-btn");

	const triggerSearch = async () => {
		const kw = searchInput.value.trim();
		globalState.searchKeyword = kw;
		if (!kw) return;
		const tbody = rootEl.querySelector("#lx-song-table-body");
		tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 40px;">正在检索 ${kw}...</td></tr>`;

		try {
			const res = await fetch(
				`${apiBaseUrl}/search?source=${globalState.source}&keyword=${encodeURIComponent(kw)}`,
			).then((r) => r.json());

			if (!res.ok || !res.songs || res.songs.length === 0) {
				tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 40px; color: var(--text-faint);">未找到相关歌曲</td></tr>`;
				return;
			}

			globalState.searchResults = res.songs;
			renderCurrentTable();
		} catch (err) {
			tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--err-text, #bf616a); padding: 40px;">搜索失败: ${err.message}</td></tr>`;
		}
	};

	searchBtn.addEventListener("click", triggerSearch);
	searchInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") triggerSearch();
	});

	// 5. 播控
	const playBtn = rootEl.querySelector("#lx-play-btn");
	playBtn.addEventListener("click", () => {
		if (globalState.isPlaying) globalAudio.pause();
		else resumePlayback();
	});

	rootEl.querySelector("#lx-prev-btn").addEventListener("click", playPrevSong);
	rootEl.querySelector("#lx-next-btn").addEventListener("click", playNextSong);

	// 6. 一键播放全部 与 一键全部入队
	rootEl.querySelector("#lx-play-all-btn").addEventListener("click", playAllCurrentList);
	rootEl.querySelector("#lx-add-all-btn").addEventListener("click", addAllCurrentToQueue);
	rootEl.querySelector("#lx-clear-queue-btn").addEventListener("click", clearQueue);

	// 7. 播放模式切换 (列表循环 -> 随机播放 -> 单曲循环)
	const modeBtn = rootEl.querySelector("#lx-mode-btn");
	const modeIcon = rootEl.querySelector("#lx-mode-icon");
	const modes = [
		{ type: "loop", icon: "🔁", title: "列表循环" },
		{ type: "random", icon: "🔀", title: "随机播放" },
		{ type: "single", icon: "🔂", title: "单曲循环" },
	];

	const savedMode = modes.find((m) => m.type === globalState.playMode);
	modeIcon.textContent = savedMode.icon;
	modeBtn.title = savedMode.title;
	modeBtn.addEventListener("click", () => {
		const curIdx = modes.findIndex((m) => m.type === globalState.playMode);
		const next = modes[(curIdx + 1) % modes.length];
		globalState.playMode = next.type;
		modeIcon.textContent = next.icon;
		modeBtn.title = next.title;
		showToast(`播放模式: ${next.title}`);
	});

	// 8. 画中画歌词
	rootEl.querySelector("#lx-pip-btn").addEventListener("click", togglePictureInPicture);

	// 9. 音质切换
	const qualitySelect = rootEl.querySelector("#lx-quality-select");
	qualitySelect.value = globalState.quality;
	qualitySelect.addEventListener("change", (e) => {
		globalState.quality = e.target.value;
		showToast(`已切换音质: ${e.target.options[e.target.selectedIndex].text}`);
	});

	// 10. 进度条拖拽与跳转
	const track = rootEl.querySelector("#lx-progress-track");
	track.addEventListener("click", (e) => {
		if (!globalAudio || !globalState.duration) return;
		const rect = track.getBoundingClientRect();
		const clickPct = (e.clientX - rect.left) / rect.width;
		globalAudio.currentTime = clickPct * globalState.duration;
	});

	// 11. 音量
	const volSlider = rootEl.querySelector("#lx-vol-slider");
	volSlider.value = globalState.volume;
	volSlider.addEventListener("input", (e) => {
		const val = parseFloat(e.target.value);
		globalState.volume = val;
		if (globalAudio) globalAudio.volume = val;
	});

	// 12. 自定义音源弹窗与推荐源管理
	const modal = rootEl.querySelector("#lx-userapi-modal");
	const saveBtn = rootEl.querySelector("#lx-modal-save-btn");
	const scriptArea = rootEl.querySelector("#lx-userapi-script");
	const currentApiSec = rootEl.querySelector("#lx-current-api-section");
	const currentApiDesc = rootEl.querySelector("#lx-current-api-desc");
	const probeResultEl = rootEl.querySelector("#lx-probe-result");
	const probeBtn = rootEl.querySelector("#lx-probe-btn");
	const recListEl = rootEl.querySelector("#lx-rec-sources-list");

	const refreshUserApiModal = async () => {
		// 刷新当前活跃音源信息
		if (globalState.activeUserApi) {
			currentApiSec.style.display = "flex";
			currentApiDesc.textContent = `${globalState.activeUserApi.name} (v${globalState.activeUserApi.version}) ${globalState.activeUserApi.description ? `· ${globalState.activeUserApi.description}` : ""}`;
			probeResultEl.style.display = "none";
		} else {
			currentApiSec.style.display = "none";
		}

		// 刷新推荐音源
		try {
			const recRes = await fetch(`${apiBaseUrl}/user-api/recommended`).then((r) => r.json());
			if (recRes.ok && Array.isArray(recRes.list)) {
				recListEl.innerHTML = "";
				recRes.list.forEach((item) => {
					const card = document.createElement("div");
					card.className = "lx-userapi-rec-card";

					const isCurrent =
						globalState.activeUserApi?.name?.includes(item.name.replace(/\s*\(.*\)/, "")) ||
						globalState.activeUserApi?.name === item.name;

					const isDead = item.status === "dead";
					const statusPill = isDead
						? `<span class="lx-status-pill lx-status-dead">已失效 (404)</span>`
						: `<span class="lx-status-pill lx-status-healthy">社区稳定可用</span>`;

					card.innerHTML = `
						<div class="lx-userapi-rec-info">
							<div class="lx-userapi-rec-name">
								<span>${item.name}</span>
								${statusPill}
							</div>
							<div class="lx-userapi-rec-desc" title="${item.description}">${item.description}</div>
						</div>
						<div style="flex-shrink: 0;">
							${
								isCurrent
									? `<span style="font-size: 11px; color: var(--accent); font-weight: 600;">正在使用</span>`
									: `<button class="lx-btn lx-rec-import-btn" style="padding: 4px 10px; font-size: 11px; ${item.recommended ? "background: var(--accent); color: var(--accent-contrast);" : ""}" data-url="${item.url}">${isDead ? "仍要导入" : "一键导入使用"}</button>`
							}
						</div>
					`;

					const importBtn = card.querySelector(".lx-rec-import-btn");
					if (importBtn) {
						importBtn.addEventListener("click", async () => {
							importBtn.disabled = true;
							importBtn.textContent = "导入中...";
							try {
								const res = await fetch(`${apiBaseUrl}/user-api/import`, {
									method: "POST",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({ script: item.url }),
								}).then((r) => r.json());
								if (res.ok) {
									globalState.activeUserApi = res.meta;
									updateUserApiBadge();
									showToast(`音源已激活: ${res.meta.name}`);
									refreshUserApiModal();
								} else {
									showToast(`导入失败: ${res.error}`);
								}
							} catch (e) {
								showToast(`网络异常: ${e.message}`);
							} finally {
								importBtn.disabled = false;
								importBtn.textContent = isDead ? "仍要导入" : "一键导入使用";
							}
						});
					}

					recListEl.appendChild(card);
				});
			}
		} catch {}
	};

	// 探测当前音源
	probeBtn.addEventListener("click", async () => {
		probeBtn.disabled = true;
		probeBtn.textContent = "⏳ 探测中...";
		probeResultEl.style.display = "block";
		probeResultEl.style.background = "rgba(255, 255, 255, 0.05)";
		probeResultEl.style.color = "var(--text)";
		probeResultEl.textContent = "正在测试各平台解析能力与音频直链可用性...";

		try {
			const res = await fetch(`${apiBaseUrl}/user-api/probe`).then((r) => r.json());
			if (res.ok && res.probe?.ok) {
				probeResultEl.style.background = "rgba(34, 197, 94, 0.15)";
				probeResultEl.style.color = "#4ade80";
				probeResultEl.textContent = "✅ 音源探测通畅！各平台无损及标准音质均正常解析可播放。";
			} else {
				probeResultEl.style.background = "rgba(239, 68, 68, 0.15)";
				probeResultEl.style.color = "#f87171";
				const errMsg = res.probe?.error || res.error || "音源解析失败";
				probeResultEl.textContent = `❌ ${errMsg}`;
			}
		} catch (err) {
			probeResultEl.style.background = "rgba(239, 68, 68, 0.15)";
			probeResultEl.style.color = "#f87171";
			probeResultEl.textContent = `❌ 请求探测失败: ${err.message}`;
		} finally {
			probeBtn.disabled = false;
			probeBtn.textContent = "🔍 测试可用性";
		}
	});

	rootEl.querySelector("#lx-open-userapi-btn").addEventListener("click", () => {
		modal.style.display = "flex";
		refreshUserApiModal();
	});
	rootEl.querySelector("#lx-modal-close-btn").addEventListener("click", () => {
		modal.style.display = "none";
	});

	saveBtn.addEventListener("click", async () => {
		const script = scriptArea.value.trim();
		if (!script) return showToast("脚本内容或 URL 不能为空");

		const oldText = saveBtn.textContent;
		saveBtn.disabled = true;
		saveBtn.textContent = "正在下载与解析...";

		try {
			const res = await fetch(`${apiBaseUrl}/user-api/import`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ script }),
			}).then((r) => r.json());

			if (res.ok) {
				globalState.activeUserApi = res.meta;
				updateUserApiBadge();
				showToast(`自定义音源激活成功: ${res.meta.name}`);
				scriptArea.value = "";
				refreshUserApiModal();
			} else {
				showToast(`导入失败: ${res.error}`);
			}
		} catch (err) {
			showToast(`请求异常: ${err.message}`);
		} finally {
			saveBtn.disabled = false;
			saveBtn.textContent = oldText;
		}
	});

	// 13. 键盘快捷键监听
	const onKeyDown = (e) => {
		if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

		if (e.code === "Space") {
			e.preventDefault();
			if (globalState.isPlaying) globalAudio.pause();
			else resumePlayback();
		} else if (e.code === "ArrowLeft") {
			if (e.ctrlKey) {
				playPrevSong();
			} else if (globalAudio) {
				globalAudio.currentTime = Math.max(0, globalAudio.currentTime - 5);
			}
		} else if (e.code === "ArrowRight") {
			if (e.ctrlKey) {
				playNextSong();
			} else if (globalAudio) {
				globalAudio.currentTime = Math.min(globalState.duration, globalAudio.currentTime + 5);
			}
		} else if (e.code === "ArrowUp") {
			e.preventDefault();
			globalState.volume = Math.min(1, globalState.volume + 0.05);
			if (globalAudio) globalAudio.volume = globalState.volume;
			volSlider.value = globalState.volume;
		} else if (e.code === "ArrowDown") {
			e.preventDefault();
			globalState.volume = Math.max(0, globalState.volume - 0.05);
			if (globalAudio) globalAudio.volume = globalState.volume;
			volSlider.value = globalState.volume;
		}
	};
	removeKeyboardListener?.();
	window.addEventListener("keydown", onKeyDown);
	removeKeyboardListener = () => window.removeEventListener("keydown", onKeyDown);

	// 14. 初始化恢复收藏夹与音源
	fetch(`${apiBaseUrl}/favorites`)
		.then((r) => r.json())
		.then((d) => {
			if (Array.isArray(d?.favorites) && !globalState.favorites.length) {
				globalState.favorites = d.favorites;
				renderCurrentTable();
			}
		})
		.catch(() => {});

	fetch(`${apiBaseUrl}/user-apis`)
		.then((r) => r.json())
		.then((data) => {
			const active = data?.apis?.find((a) => a.active);
			if (active) {
				globalState.activeUserApi = active;
				updateUserApiBadge();
			}
		})
		.catch(() => {});
}

export default {
	async mount(el, ctx) {
		activeRootEl = el;
		apiBaseUrl = `${ctx.appBaseUrl || ""}/plugins-api/lx-music`;
		if (!restored) {
			storageKey = `${PLAYER_STORAGE_KEY}:${ctx.appBaseUrl || "/"}`;
			try {
				Object.assign(globalState, loadPlayer(window.localStorage, storageKey));
			} catch {}
			restored = true;
			window.addEventListener("pagehide", persistPlayer);
			document.addEventListener("visibilitychange", () => {
				if (document.visibilityState === "hidden") persistPlayer();
			});
		}

		// 监听宿主 WebSocket 消息 (来自 AI Agent Tool 的点歌控制)
		if (typeof ctx.onData === "function") {
			ctx.onData((payload) => {
				if (payload?.type === "lx:play_song" && payload?.song) {
					playSong(payload.song);
				} else if (payload?.type === "lx:play_all" && payload?.songs?.length) {
					globalState.queue = [...payload.songs];
					updateQueueBadge();
					playSong(payload.songs[0], false);
					showToast(`AI 已为你开始播放整份歌单 (${payload.songs.length} 首)`);
				} else if (payload?.type === "lx:pause" && globalAudio) {
					globalAudio.pause();
				} else if (payload?.type === "lx:resume") {
					resumePlayback();
				} else if (payload?.type === "lx:playlist_add" && payload?.song) {
					globalState.queue.push(payload.song);
					updateQueueBadge();
					showToast(`已追加至播放队列: ${payload.song.name}`);
				}
			});
		}

		renderApp(el);
		bindEvents(el);
		el.querySelector("#lx-search-input").value = globalState.searchKeyword;
		el.querySelectorAll(".lx-nav-tab").forEach((tab) =>
			tab.classList.toggle("active", tab.dataset.tab === globalState.activeViewTab),
		);
		el.querySelectorAll("[data-src]").forEach((btn) =>
			btn.classList.toggle("active", btn.dataset.src === globalState.source),
		);
		el.querySelectorAll("[data-top-src]").forEach((btn) =>
			btn.classList.toggle("active", btn.dataset.topSrc === globalState.topChartSource),
		);
		el.querySelectorAll("[data-pl-src]").forEach((btn) =>
			btn.classList.toggle("active", btn.dataset.plSrc === globalState.playlistSource),
		);
		// Restore the selected tab through its normal layout handler.
		el.querySelector(`.lx-nav-tab[data-tab='${globalState.activeViewTab}']`)?.click();
		renderPlayerBarInfo();
		updateProgressBar();
		updatePlayButtonState();
		renderLyrics();
		updateQueueBadge();
	},

	unmount() {
		clearStallTimers();
		if (watchdogTimer) {
			clearInterval(watchdogTimer);
			watchdogTimer = null;
		}
		removeKeyboardListener?.();
		removeKeyboardListener = null;
		persistPlayer();
		activeRootEl = null;
	},
};
