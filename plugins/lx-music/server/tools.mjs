/**
 * 供 AI 智能体调用的点歌与音乐播控工具
 */
import { getTopListSongs, getPlaylistDetail, searchMusics } from "./music-sdk.mjs";

export function createMusicTool(host, userApi) {
	return {
		name: "music_control",
		description:
			"Search, play, pause, or manage background music in pi-web-ui music player. Actions: search, play, play_all, pause, resume, playlist_add.",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["search", "play", "play_all", "pause", "resume", "playlist_add"],
					description:
						"Action to perform: search songs, play a song, play all songs in a list/chart, pause, resume, or add to playlist.",
				},
				keyword: {
					type: "string",
					description: "Song name, artist, or keywords for search / play.",
				},
				source: {
					type: "string",
					enum: ["wy", "tx", "kw", "kg", "mg"],
					description:
						"Music platform source (wy: Netease, tx: QQ Music, kw: Kuwo, kg: Kugou, mg: Migu). Defaults to wy.",
				},
				chart: {
					type: "string",
					description: "Chart type or ID when action is play_all (e.g. hot, soar, new, or specific chart ID).",
				},
				playlistId: {
					type: "string",
					description: "Playlist ID when action is play_all to play an entire online playlist.",
				},
			},
			required: ["action"],
		},
		execute: async ({ action, keyword, source = "wy", chart = "hot", playlistId }) => {
			if (action === "search") {
				if (!keyword) return { error: "Keyword is required for search" };
				try {
					const results = await searchMusics(source, keyword, 1, 8);
					return {
						status: "ok",
						count: results.length,
						songs: results.map((s, idx) => ({
							index: idx + 1,
							id: s.id,
							name: s.name,
							singer: s.singer,
							album: s.album,
							duration: s.duration,
							source: s.source,
						})),
					};
				} catch (err) {
					return { status: "error", message: `Search failed: ${err.message}` };
				}
			}

			if (action === "play") {
				if (!keyword) return { error: "Keyword or song title is required to play" };
				try {
					const results = await searchMusics(source, keyword, 1, 3);
					if (!results || results.length === 0) {
						return { status: "not_found", message: `No songs found for '${keyword}'` };
					}
					const targetSong = results[0];
					host.broadcast({
						type: "lx:play_song",
						song: targetSong,
					});
					return {
						status: "ok",
						message: `Now playing: ${targetSong.name} - ${targetSong.singer}`,
						song: targetSong,
					};
				} catch (err) {
					return { status: "error", message: `Play failed: ${err.message}` };
				}
			}

			if (action === "play_all") {
				try {
					let songs = [];
					if (playlistId) {
						const pl = await getPlaylistDetail(source, playlistId);
						songs = pl.songs || [];
					} else if (keyword) {
						songs = await searchMusics(source, keyword, 1, 20);
					} else {
						songs = await getTopListSongs(source, chart, 1, 30);
					}

					if (!songs || songs.length === 0) {
						return { status: "not_found", message: "No songs available to play" };
					}

					host.broadcast({
						type: "lx:play_all",
						songs,
					});
					return {
						status: "ok",
						message: `Started playing entire list (${songs.length} songs), currently playing: ${songs[0].name} - ${songs[0].singer}`,
						count: songs.length,
						currentSong: songs[0],
					};
				} catch (err) {
					return { status: "error", message: `Play all failed: ${err.message}` };
				}
			}

			if (action === "pause") {
				host.broadcast({ type: "lx:pause" });
				return { status: "ok", message: "Music playback paused." };
			}

			if (action === "resume") {
				host.broadcast({ type: "lx:resume" });
				return { status: "ok", message: "Music playback resumed." };
			}

			if (action === "playlist_add") {
				if (!keyword) return { error: "Keyword is required" };
				const results = await searchMusics(source, keyword, 1, 1);
				if (!results || results.length === 0) return { status: "not_found", message: "Song not found" };
				const target = results[0];
				host.broadcast({ type: "lx:playlist_add", song: target });
				return { status: "ok", message: `Added to playlist: ${target.name} - ${target.singer}` };
			}

			return { status: "unknown_action" };
		},
	};
}
