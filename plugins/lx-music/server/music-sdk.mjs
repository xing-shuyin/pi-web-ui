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
		signal: AbortSignal.timeout(3500),
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
		const playlistId = ids[type] || type || ids.hot;
		return await this.getPlaylistSongs(playlistId, limit);
	},

	async getTopLists() {
		const fallback = [
			{ id: "3778678", name: "热歌榜", pic: "", source: "wy" },
			{ id: "19723756", name: "飙升榜", pic: "", source: "wy" },
			{ id: "3779629", name: "新歌榜", pic: "", source: "wy" },
			{ id: "2884035", name: "原创榜", pic: "", source: "wy" },
		];
		try {
			const json = await fetchJson("https://music.163.com/api/toplist", { Referer: "https://music.163.com/" });
			const list = json?.list || [];
			if (list.length === 0) return fallback;
			return list.map((item) => ({
				id: String(item.id),
				name: item.name,
				pic: item.coverImgUrl,
				updateFrequency: item.updateFrequency,
				source: "wy",
			}));
		} catch {
			return fallback;
		}
	},

	async getPlaylistSongs(playlistId, limit = 50) {
		const url = `https://music.163.com/api/v6/playlist/detail?id=${playlistId}`;
		const json = await fetchJson(url, { Referer: "https://music.163.com/" });
		let tracks = json?.playlist?.tracks || [];
		const trackIds = json?.playlist?.trackIds || [];
		if (tracks.length < limit && trackIds.length > tracks.length) {
			try {
				const idsToFetch = trackIds.slice(0, limit).map((t) => ({ id: t.id }));
				const songDetailUrl = `https://music.163.com/api/v3/song/detail?c=${encodeURIComponent(JSON.stringify(idsToFetch))}`;
				const sJson = await fetchJson(songDetailUrl, { Referer: "https://music.163.com/" });
				if (sJson?.songs?.length) {
					return sJson.songs.map((s) => ({
						id: String(s.id),
						name: s.name,
						singer: (s.ar || []).map((a) => a.name).join("、"),
						album: s.al?.name || "",
						duration: formatDuration((s.dt || 0) / 1000),
						durationSec: Math.floor((s.dt || 0) / 1000),
						pic: s.al?.picUrl || "",
						source: "wy",
					}));
				}
			} catch {}
		}
		return tracks.slice(0, limit).map((t) => ({
			id: String(t.id),
			name: t.name,
			singer: (t.ar || t.artists || []).map((a) => a.name).join("、"),
			album: t.al?.name || t.album?.name || "",
			duration: formatDuration((t.dt || t.duration || 0) / 1000),
			durationSec: Math.floor((t.dt || t.duration || 0) / 1000),
			pic: t.al?.picUrl || t.album?.picUrl || "",
			source: "wy",
		}));
	},

	async getPlaylists(tag = "全部", page = 1, limit = 30) {
		const offset = (page - 1) * limit;
		const url = `https://music.163.com/api/playlist/list?cat=${encodeURIComponent(tag)}&order=hot&offset=${offset}&limit=${limit}`;
		const json = await fetchJson(url, { Referer: "https://music.163.com/" });
		const list = json?.playlists || [];
		return {
			total: json?.total || list.length,
			list: list.map((p) => ({
				id: String(p.id),
				name: p.name,
				pic: p.coverImgUrl,
				playCount: p.playCount,
				trackCount: p.trackCount,
				author: p.creator?.nickname || "",
				source: "wy",
			})),
		};
	},

	async getPlaylistTags() {
		return ["全部", "华语", "流行", "摇滚", "民谣", "电子", "另类/独立", "轻音乐", "影视原声", "ACG", "怀旧"];
	},

	async getPlaylistDetail(id) {
		const url = `https://music.163.com/api/v6/playlist/detail?id=${id}`;
		const json = await fetchJson(url, { Referer: "https://music.163.com/" });
		const p = json?.playlist || {};
		const songs = await this.getPlaylistSongs(id, 60);
		return {
			id: String(p.id || id),
			name: p.name || "",
			pic: p.coverImgUrl || "",
			desc: p.description || "",
			author: p.creator?.nickname || "",
			playCount: p.playCount || 0,
			trackCount: p.trackCount || songs.length,
			songs,
			source: "wy",
		};
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

	async getTopLists() {
		return [
			{ id: "16", name: "酷我热歌榜", source: "kw" },
			{ id: "93", name: "酷我飙升榜", source: "kw" },
			{ id: "17", name: "酷我新歌榜", source: "kw" },
			{ id: "158", name: "抖音热歌榜", source: "kw" },
			{ id: "26", name: "经典怀旧榜", source: "kw" },
			{ id: "104", name: "华语榜", source: "kw" },
			{ id: "22", name: "欧美榜", source: "kw" },
			{ id: "186", name: "ACG神曲榜", source: "kw" },
			{ id: "242", name: "电音榜", source: "kw" },
			{ id: "255", name: "KTV点唱榜", source: "kw" },
		];
	},

	async getTopList(type = "hot", limit = 50) {
		const map = {
			hot: "16",
			soar: "93",
			new: "17",
		};
		const bangId = map[type] || type || "16";
		const url = `http://kbangserver.kuwo.cn/ksong.s?from=pc&fmt=json&type=bang&data=bang&id=${bangId}&pn=0&rn=${limit}`;
		const json = await fetchJson(url, { Referer: "http://www.kuwo.cn/" });
		const list = json?.musiclist || [];
		return list.map((item) => {
			const songId = String(item.id || "").replace("MUSIC_", "");
			const durationSec = parseInt(item.song_duration || item.duration || "0", 10);
			return {
				id: songId,
				name: (item.name || "").replace(/&nbsp;/g, " "),
				singer: (item.artist || "").replace(/&nbsp;/g, " "),
				album: (item.album || "").replace(/&nbsp;/g, " "),
				duration: formatDuration(durationSec),
				durationSec,
				pic:
					item.pic || (item.web_albumpic_short ? `http://img1.kuwo.cn/star/albumcover/${item.web_albumpic_short}` : ""),
				source: "kw",
			};
		});
	},

	async getPlaylists(tag = "全部", page = 1, limit = 30) {
		const url = `http://wapi.kuwo.cn/api/pc/classify/playlist/getRcmPlayList?loginUid=0&loginSid=0&appUid=76039576&pn=${page}&rn=${limit}&order=hot`;
		const json = await fetchJson(url, { Referer: "http://www.kuwo.cn/" });
		const list = json?.data?.data || [];
		return {
			total: json?.data?.total || list.length,
			list: list.map((item) => ({
				id: String(item.id),
				name: item.name,
				pic: item.img,
				playCount: item.playnum,
				trackCount: item.total,
				author: item.uname || "",
				source: "kw",
			})),
		};
	},

	async getPlaylistTags() {
		return ["全部", "热门", "华语", "流行", "网络", "经典", "治愈"];
	},

	async getPlaylistDetail(id) {
		const cleanId = String(id).replace(/[^0-9]/g, "");
		const url = `http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=${cleanId}&pn=0&rn=100&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1`;
		const json = await fetchJson(url, { Referer: "http://www.kuwo.cn/" });
		const list = json?.musiclist || [];
		const songs = list.map((item) => {
			const songId = String(item.id || "").replace("MUSIC_", "");
			const durationSec = parseInt(item.duration || "0", 10);
			return {
				id: songId,
				name: (item.name || "").replace(/&nbsp;/g, " "),
				singer: (item.artist || "").replace(/&nbsp;/g, " "),
				album: (item.album || "").replace(/&nbsp;/g, " "),
				duration: formatDuration(durationSec),
				durationSec,
				pic: item.pic || "",
				source: "kw",
			};
		});
		return {
			id: String(cleanId),
			name: json?.title || "",
			pic: json?.pic || "",
			desc: json?.info || "",
			author: json?.uname || "",
			playCount: json?.playnum || 0,
			trackCount: json?.total || songs.length,
			songs,
			source: "kw",
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

	async getTopLists() {
		const fallback = [
			{ id: "8888", name: "酷狗TOP500", pic: "", source: "kg" },
			{ id: "6666", name: "酷狗飙升榜", pic: "", source: "kg" },
			{ id: "31308", name: "华语新歌榜", pic: "", source: "kg" },
			{ id: "24971", name: "DJ热歌榜", pic: "", source: "kg" },
		];
		try {
			const url = "http://mobilecdnbj.kugou.com/api/v5/rank/list?version=9108&plat=0&showtype=2&parentid=0";
			const json = await fetchJson(url, { Referer: "http://www.kugou.com/" });
			const list = json?.data?.info || [];
			if (list.length === 0) return fallback;
			return list.map((item) => ({
				id: String(item.rankid),
				name: item.rankname,
				pic: item.bannerurl || item.imgurl || "",
				source: "kg",
			}));
		} catch {
			return fallback;
		}
	},

	async getTopList(type = "hot", limit = 50) {
		const map = {
			hot: "8888", // TOP500
			soar: "6666", // 飙升榜
			new: "31308", // 内地榜
		};
		const rankid = map[type] || type || "8888";
		const url = `http://mobilecdnbj.kugou.com/api/v3/rank/song?version=9108&ranktype=1&plat=0&pagesize=${limit}&area_code=1&page=1&rankid=${rankid}&with_res_tag=0&show_portrait_mv=1`;
		const json = await fetchJson(url, { Referer: "http://www.kugou.com/" });
		const list = json?.data?.info || [];
		return list.map((item) => ({
			id: item.hash || item.audio_id,
			hash: item.hash,
			name: item.songname || item.filename || "",
			singer: item.singername || "",
			album: item.album_name || "",
			duration: formatDuration(item.duration || 0),
			durationSec: item.duration || 0,
			pic: "",
			source: "kg",
		}));
	},

	async getPlaylists(tag = "全部", page = 1, limit = 30) {
		const url = `http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_ajax=1&cdn=cdn&t=5&c=&p=${page}`;
		const json = await fetchJson(url, { Referer: "http://www.kugou.com/" });
		const list = json?.special_db || [];
		return {
			total: json?.total || list.length,
			list: list.map((item) => ({
				id: String(item.specialid),
				name: item.specialname,
				pic: item.img,
				playCount: item.playcount,
				trackCount: item.songcount,
				author: item.nickname || "",
				source: "kg",
			})),
		};
	},

	async getPlaylistTags() {
		return ["全部", "热门", "推荐", "华语", "流行", "伤感", "古风", "轻音乐"];
	},

	async getPlaylistDetail(id) {
		const cleanId = String(id).replace(/[^0-9]/g, "");
		const url = `http://www2.kugou.kugou.com/yueku/v9/special/single/${cleanId}-5-9999.html`;
		const res = await fetch(url, {
			headers: { "User-Agent": DEFAULT_UA, Referer: "http://www.kugou.com/" },
			signal: AbortSignal.timeout(10000),
		});
		const html = await res.text();
		const matchData = html.match(/global\.data = (\[.+\]);/);
		const matchInfo = html.match(/global = {[\s\S]+?name: "(.+?)"[\s\S]+?pic: "(.+?)"[\s\S]+?};/);
		const rawSongs = matchData ? JSON.parse(matchData[1]) : [];
		const name = matchInfo ? matchInfo[1] : "";
		const pic = matchInfo ? matchInfo[2] : "";
		const songs = rawSongs.map((item) => ({
			id: item.hash,
			hash: item.hash,
			name: item.songname || "",
			singer: item.singername || "",
			album: item.album_name || "",
			duration: formatDuration(item.duration || 0),
			durationSec: item.duration || 0,
			pic: "",
			source: "kg",
		}));
		return {
			id: String(cleanId),
			name,
			pic,
			desc: "",
			author: "",
			playCount: 0,
			trackCount: songs.length,
			songs,
			source: "kg",
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

// ========================
// 5. QQ 音乐 (tx)
// ========================
export const tx = {
	async search(keyword, page = 1, limit = 20) {
		const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=${page}&n=${limit}&w=${encodeURIComponent(keyword)}&format=json`;
		const json = await fetchJson(url, { Referer: "https://y.qq.com/" });
		const list = json?.data?.song?.list || [];
		return list.map((item) => {
			const songmid = item.songmid || "";
			const songId = item.songid ? String(item.songid) : songmid;
			const albummid = item.albummid || "";
			const durationSec = parseInt(item.interval || "0", 10);
			return {
				id: songmid,
				songmid,
				songId,
				strMediaMid: item.strMediaMid || songmid,
				albumMid: albummid,
				name: item.songname || "",
				singer: (item.singer || []).map((s) => s.name).join("、"),
				album: item.albumname || "",
				duration: formatDuration(durationSec),
				durationSec,
				pic: albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albummid}.jpg` : "",
				source: "tx",
			};
		});
	},

	async getMusicUrl(songId) {
		return `https://isure.stream.qqmusic.qq.com/C400${songId}.m4a?guid=10000`;
	},

	async getLyric(songId) {
		try {
			const url = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${songId}&format=json&nobase64=1`;
			const json = await fetchJson(url, { Referer: "https://y.qq.com/" });
			return {
				lyric: json?.lyric || "",
				tlyric: "",
			};
		} catch {
			return { lyric: "", tlyric: "" };
		}
	},

	async getTopLists() {
		const fallback = [
			{ id: "26", name: "热歌榜", pic: "", source: "tx" },
			{ id: "62", name: "飙升榜", pic: "", source: "tx" },
			{ id: "27", name: "新歌榜", pic: "", source: "tx" },
			{ id: "58", name: "说唱榜", pic: "", source: "tx" },
		];
		try {
			const url =
				"https://c.y.qq.com/v8/fcg-bin/fcg_myqq_toplist.fcg?g_tk=5381&uin=0&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=h5&needNewCode=1";
			const json = await fetchJson(url, { Referer: "https://y.qq.com/" });
			const list = json?.data?.topList || [];
			if (list.length === 0) return fallback;
			return list.map((item) => ({
				id: String(item.id),
				name: item.topTitle,
				pic: item.pic_v12 || item.pic_h5 || "",
				source: "tx",
			}));
		} catch {
			return fallback;
		}
	},

	async getTopList(type = "hot", limit = 50) {
		const map = {
			hot: "26", // 热歌榜
			soar: "62", // 飙升榜
			new: "27", // 新歌榜
		};
		const topid = map[type] || type || "26";
		const url = `https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?g_tk=5381&uin=0&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=h5&needNewCode=1&tpl=3&page=detail&type=top&topid=${topid}`;
		const json = await fetchJson(url, { Referer: "https://y.qq.com/" });
		const list = (json?.songlist || []).slice(0, limit);
		return list.map((item) => {
			const d = item.data || {};
			const songmid = d.songmid || "";
			const songId = d.songid ? String(d.songid) : songmid;
			const albummid = d.albummid || "";
			const durationSec = parseInt(d.interval || "0", 10);
			return {
				id: songmid,
				songmid,
				songId,
				strMediaMid: d.strMediaMid || songmid,
				albumMid: albummid,
				name: d.songname || "",
				singer: (d.singer || []).map((s) => s.name).join("、"),
				album: d.albumname || "",
				duration: formatDuration(durationSec),
				durationSec,
				pic: albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albummid}.jpg` : "",
				source: "tx",
			};
		});
	},

	async getPlaylists(tag = "全部", page = 1, limit = 30) {
		const sin = (page - 1) * limit;
		const ein = sin + limit - 1;
		const tagMap = {
			全部: 10000000,
			流行: 6,
			民谣: 11,
			摇滚: 7,
			说唱: 104,
			国风: 165,
			轻音乐: 15,
			影视: 167,
			ACG: 28,
		};
		const catId = tagMap[tag] || 10000000;
		const url = `https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?picmid=1&rnd=0.1&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0&categoryId=${catId}&sortId=5&sin=${sin}&ein=${ein}`;
		const json = await fetchJson(url, { Referer: "https://y.qq.com/" });
		const list = json?.data?.list || [];
		return {
			total: json?.data?.sum || list.length,
			list: list.map((item) => ({
				id: String(item.dissid),
				name: item.dissname,
				pic: item.imgurl,
				playCount: item.listennum,
				author: item.creator?.name || "",
				source: "tx",
			})),
		};
	},

	async getPlaylistTags() {
		return ["全部", "流行", "民谣", "摇滚", "说唱", "国风", "轻音乐", "影视", "ACG"];
	},

	async getPlaylistDetail(id) {
		const dissid = parseInt(String(id).replace(/[^0-9]/g, ""), 10);
		const res = await fetch("https://u.y.qq.com/cgi-bin/musicu.fcg", {
			method: "POST",
			headers: {
				Origin: "https://y.qq.com",
				Referer: `https://y.qq.com/n/yqq/playsquare/${id}.html`,
				"Content-Type": "application/json",
				"User-Agent": DEFAULT_UA,
			},
			body: JSON.stringify({
				comm: {
					cv: 4747474,
					ct: 24,
					format: "json",
					inCharset: "utf-8",
					outCharset: "utf-8",
					platform: "yqq.json",
					needNewCode: 1,
					uin: 0,
				},
				req_1: {
					module: "music.srfDissInfo.aiDissInfo",
					method: "uniform_get_Dissinfo",
					param: {
						disstid: dissid,
						userinfo: 1,
						tag: 1,
						orderlist: 1,
						song_begin: 0,
						song_num: 60,
						onlysonglist: 0,
						enc_host_uin: "",
					},
				},
			}),
		});
		const body = await res.json();
		const data = body?.req_1?.data || {};
		const dirinfo = data.dirinfo || {};
		const songlist = data.songlist || [];
		const songs = songlist.map((item) => {
			const songmid = item.mid || item.songmid || "";
			const songId = item.id ? String(item.id) : songmid;
			const albummid = item.album?.mid || item.albummid || "";
			const durationSec = parseInt(item.interval || "0", 10);
			return {
				id: songmid,
				songmid,
				songId,
				strMediaMid: item.file?.media_mid || item.strMediaMid || songmid,
				albumMid: albummid,
				name: item.name || item.title || "",
				singer: (item.singer || []).map((s) => s.name).join("、"),
				album: item.album?.name || item.albumname || "",
				duration: formatDuration(durationSec),
				durationSec,
				pic: albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albummid}.jpg` : "",
				source: "tx",
			};
		});

		return {
			id: String(id),
			name: dirinfo.title || "",
			pic: dirinfo.picurl || "",
			desc: dirinfo.desc || "",
			author: dirinfo.nick || "",
			playCount: dirinfo.listennum || 0,
			trackCount: dirinfo.songnum || songs.length,
			songs,
			source: "tx",
		};
	},
};

/** 统一调度门面 */
export const sources = { wy, tx, kw, kg, mg };

export async function searchMusics(source, keyword, page = 1, limit = 20) {
	const handler = sources[source] || wy;
	return await handler.search(keyword, page, limit);
}

export async function getTopLists(source = "wy") {
	const handler = sources[source] || wy;
	if (typeof handler.getTopLists === "function") {
		return await handler.getTopLists();
	}
	return [];
}

export async function getTopListSongs(source = "wy", bangId = "hot", page = 1, limit = 50) {
	const handler = sources[source] || wy;
	if (typeof handler.getTopList === "function") {
		return await handler.getTopList(bangId, limit);
	}
	return [];
}

export async function getTopList(type = "hot", limit = 30) {
	return await wy.getTopList(type, limit);
}

export async function getPlaylists(source = "wy", tag = "全部", page = 1, limit = 30) {
	const handler = sources[source] || wy;
	if (typeof handler.getPlaylists === "function") {
		return await handler.getPlaylists(tag, page, limit);
	}
	return { total: 0, list: [] };
}

export async function getPlaylistTags(source = "wy") {
	const handler = sources[source] || wy;
	if (typeof handler.getPlaylistTags === "function") {
		return await handler.getPlaylistTags();
	}
	return ["全部"];
}

export async function getPlaylistDetail(source = "wy", id) {
	const handler = sources[source] || wy;
	if (typeof handler.getPlaylistDetail === "function") {
		return await handler.getPlaylistDetail(id);
	}
	throw new Error(`平台 ${source} 暂不支持歌单详情解析`);
}

export async function getMusicPlayUrl(source, songId) {
	const handler = sources[source] || wy;
	return await handler.getMusicUrl(songId);
}

/**
 * 跨平台智能换源容灾匹配 (参考 enhanced 版 getOtherSource)
 * 当主源解析失败或无版权时，自动在其它可用源中检索同名歌曲并获取播放链接
 */
export async function findCrossSourceMusicUrl(name, singer = "", excludeSource = "") {
	if (!name) return null;
	const cleanName = name.replace(/\([^)]*\)|\[[^\]]*\]/g, "").trim();
	const cleanSinger = (singer || "").split("、")[0].split("/")[0].trim();
	const candidateSources = ["wy", "tx", "kw", "kg"].filter((s) => s !== excludeSource);

	for (const src of candidateSources) {
		try {
			const query = `${cleanName} ${cleanSinger}`.trim();
			const list = await searchMusics(src, query, 1, 5);
			if (!list || !list.length) continue;

			// 优先找歌名包含的条目
			const match =
				list.find(
					(item) =>
						item.name.toLowerCase().includes(cleanName.toLowerCase()) ||
						cleanName.toLowerCase().includes(item.name.toLowerCase()),
				) || list[0];

			if (match && match.id) {
				const url = await getMusicPlayUrl(src, match.id);
				if (url && typeof url === "string" && url.startsWith("http")) {
					return { url, source: src, matchedSong: match };
				}
			}
		} catch {}
	}
	return null;
}

export async function getLyricInfo(source, songId) {
	const handler = sources[source] || wy;
	return await handler.getLyric(songId);
}
