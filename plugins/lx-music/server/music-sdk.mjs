/**
 * 音乐聚合 SDK —— 聚合酷我、酷狗、网易云、咪咕等多平台检索、歌词与音源解析
 */
import https from "node:https";

const DEFAULT_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/** 基础 HTTP 请求包装 */
async function fetchJson(url, headers = {}) {
	const res = await fetch(url, {
		headers: {
			"User-Agent": DEFAULT_UA,
			...headers,
		},
		signal: AbortSignal.timeout(10000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
	return await res.json();
}

/** 格式化播放时长 mm:ss */
function formatDuration(sec) {
	const s = Math.floor(sec || 0);
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

// ========================
// 1. 网易云音乐 (wy)
// ========================
export const wy = {
	async search(keyword, page = 1, limit = 20) {
		const offset = (page - 1) * limit;
		const url = `https://music.163.com/api/search/get/web?csrf_token=&s=${encodeURIComponent(keyword)}&type=1&offset=${offset}&limit=${limit}`;
		const json = await fetchJson(url, { Referer: "https://music.163.com/" });
		const songs = json?.result?.songs || [];
		return songs.map((s) => ({
			id: String(s.id),
			name: s.name,
			singer: (s.artists || []).map((a) => a.name).join("、"),
			album: s.album?.name || "",
			duration: formatDuration((s.duration || 0) / 1000),
			durationSec: Math.floor((s.duration || 0) / 1000),
			pic: s.album?.picUrl || "",
			source: "wy",
		}));
	},

	async getMusicUrl(songId) {
		// 网易云标准公开外链
		return `https://music.163.com/song/media/outer/url?id=${songId}.mp3`;
	},

	async getLyric(songId) {
		const url = `https://music.163.com/api/song/lyric?os=pc&id=${songId}&lv=-1&kv=-1&tv=-1`;
		const json = await fetchJson(url, { Referer: "https://music.163.com/" });
		return {
			lyric: json?.lrc?.lyric || "",
			tlyric: json?.tlyric?.lyric || "",
		};
	},

	async getTopList(type = "hot", limit = 30) {
		const ids = {
			hot: "3778678", // 热歌榜
			soar: "19723756", // 飙升榜
			new: "3779629", // 新歌榜
		};
		const playlistId = ids[type] || ids.hot;
		const url = `https://music.163.com/api/playlist/detail?id=${playlistId}`;
		const json = await fetchJson(url, { Referer: "https://music.163.com/" });
		const tracks = (json?.result?.tracks || []).slice(0, limit);
		return tracks.map((t) => ({
			id: String(t.id),
			name: t.name,
			singer: (t.artists || []).map((a) => a.name).join("、"),
			album: t.album?.name || "",
			duration: formatDuration((t.duration || 0) / 1000),
			durationSec: Math.floor((t.duration || 0) / 1000),
			pic: t.album?.picUrl || "",
			source: "wy",
		}));
	},
};

// ========================
// 2. 酷我音乐 (kw)
// ========================
export const kw = {
	async search(keyword, page = 1, limit = 20) {
		const pn = page - 1;
		const url = `http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(keyword)}&pn=${pn}&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`;
		const res = await fetch(url, {
			headers: { "User-Agent": DEFAULT_UA, Referer: "http://www.kuwo.cn/" },
			signal: AbortSignal.timeout(10000),
		});
		const text = await res.text();
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			json = {};
		}
		const list = json?.abslist || [];
		return list.map((item) => {
			const songId = (item.MUSICRID || "").replace("MUSIC_", "");
			const durationSec = parseInt(item.DURATION || "0", 10);
			return {
				id: songId,
				name: (item.SONGNAME || "").replace(/&nbsp;/g, " "),
				singer: (item.ARTIST || "").replace(/&nbsp;/g, " "),
				album: (item.ALBUM || "").replace(/&nbsp;/g, " "),
				duration: formatDuration(durationSec),
				durationSec,
				pic: item.web_albumpic_short ? `http://img1.kuwo.cn/star/albumcover/${item.web_albumpic_short}` : "",
				source: "kw",
			};
		});
	},

	async getMusicUrl(songId) {
		const url = `http://antiserver.kuwo.cn/anti.s?type=convert_url&rid=${songId}&format=mp3&response=url`;
		const res = await fetch(url, {
			headers: { "User-Agent": DEFAULT_UA, Referer: "http://www.kuwo.cn/" },
			signal: AbortSignal.timeout(8000),
		});
		const playUrl = (await res.text()).trim();
		if (playUrl && playUrl.startsWith("http")) return playUrl;
		return `https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${songId}&httpsStatus=1`;
	},

	async getLyric(songId) {
		const url = `http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${songId}&httpsStatus=1`;
		const json = await fetchJson(url, { Referer: "http://www.kuwo.cn/" });
		const lrclist = json?.data?.lrclist || [];
		const lrcText = lrclist.map((l) => `[${formatDuration(l.time)}]${l.lineLyric}`).join("\n");
		return {
			lyric: lrcText,
			tlyric: "",
		};
	},
};

// ========================
// 3. 酷狗音乐 (kg)
// ========================
export const kg = {
	async search(keyword, page = 1, limit = 20) {
		const url = `http://songsearch.kugou.com/song_search_v2?platform=AndroidFilter&iscorrection=1&keyword=${encodeURIComponent(keyword)}&hifiquality=0&pagesize=${limit}&PrivilegeFilter=0&page=${page}`;
		const json = await fetchJson(url, { Referer: "http://www.kugou.com/" });
		const lists = json?.data?.lists || [];
		return lists.map((item) => ({
			id: item.FileHash || item.HQFileHash || item.SQFileHash || item.Audioid,
			hash: item.FileHash,
			albumId: item.AlbumID,
			name: item.SongName || item.OriSongName || "",
			singer: item.SingerName || "",
			album: item.AlbumName || "",
			duration: formatDuration(item.Duration || 0),
			durationSec: item.Duration || 0,
			pic: "",
			source: "kg",
		}));
	},

	async getMusicUrl(songId) {
		const url = `https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=${songId}&mid=1`;
		const json = await fetchJson(url, {
			Referer: "http://www.kugou.com/",
			Cookie: "kg_mid=1; kg_dfid=1",
		});
		return json?.data?.play_url || json?.data?.play_backup_url || "";
	},

	async getLyric(songId) {
		const url = `https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=${songId}&mid=1`;
		const json = await fetchJson(url, {
			Referer: "http://www.kugou.com/",
			Cookie: "kg_mid=1; kg_dfid=1",
		});
		return {
			lyric: json?.data?.lyrics || "",
			tlyric: "",
		};
	},
};

// ========================
// 4. 咪咕音乐 (mg)
// ========================
export const mg = {
	async search(keyword, page = 1, limit = 20) {
		const url = `https://m.music.migu.cn/migu/remoting/scr_search_tag?rows=${limit}&type=2&keyword=${encodeURIComponent(keyword)}&pgc=${page}`;
		const json = await fetchJson(url, { Referer: "https://m.music.migu.cn/" });
		const list = json?.musics || [];
		return list.map((item) => ({
			id: item.copyrightId || item.id,
			name: item.songName || "",
			singer: item.singerName || "",
			album: item.albumName || "",
			duration: formatDuration(item.duration || 0),
			durationSec: item.duration || 0,
			pic: item.cover || "",
			source: "mg",
		}));
	},

	async getMusicUrl(songId) {
		return `https://freetyst.nf.migu.cn/${songId}.mp3`;
	},

	async getLyric(songId) {
		const url = `https://music.migu.cn/v3/api/music/audioPlayer/getLyric?copyrightId=${songId}`;
		const json = await fetchJson(url, { Referer: "https://music.migu.cn/" });
		return {
			lyric: json?.lyric || "",
			tlyric: "",
		};
	},
};

/** 统一调度门面 */
export const sources = { wy, kw, kg, mg };

export async function searchMusics(source, keyword, page = 1, limit = 20) {
	const handler = sources[source] || wy;
	return await handler.search(keyword, page, limit);
}

export async function getTopList(type = "hot", limit = 30) {
	return await wy.getTopList(type, limit);
}

export async function getMusicPlayUrl(source, songId) {
	const handler = sources[source] || wy;
	return await handler.getMusicUrl(songId);
}

export async function getLyricInfo(source, songId) {
	const handler = sources[source] || wy;
	return await handler.getLyric(songId);
}
