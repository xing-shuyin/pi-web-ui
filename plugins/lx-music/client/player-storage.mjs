export const PLAYER_STORAGE_KEY = "lx-music:player:v1";
const lists = ["queue", "history", "favorites", "searchResults", "topChartSongs"];
const choices = {
	playMode: ["loop", "random", "single"],
	quality: ["128k", "320k", "flac"],
	source: ["wy", "tx", "kw", "kg", "mg"],
	activeViewTab: ["search", "top", "playlist", "favorites", "queue", "history"],
	topChartType: ["hot", "soar", "new"],
};
function cleanSong(song) {
	if (
		!song ||
		typeof song !== "object" ||
		!["string", "number"].includes(typeof song.id) ||
		typeof song.source !== "string"
	)
		return null;
	const { _realPlayUrl, ...data } = song;
	return data;
}
export function playerSnapshot(state) {
	/** @type {Record<string, any>} */
	const result = { version: 1 };
	for (const key of lists) {
		if (Array.isArray(state[key])) result[key] = state[key].map(cleanSong).filter(Boolean);
	}
	if ("currentSong" in state) result.currentSong = cleanSong(state.currentSong);
	for (const [key, values] of Object.entries(choices)) {
		if (values.includes(state[key])) result[key] = state[key];
	}
	for (const key of ["currentTime", "duration", "volume"]) {
		if (Number.isFinite(state[key]) && state[key] >= 0 && (key !== "volume" || state[key] <= 1))
			result[key] = state[key];
	}
	if (typeof state.searchKeyword === "string") result.searchKeyword = state.searchKeyword;
	return result;
}
export function loadPlayer(storage, key = PLAYER_STORAGE_KEY) {
	try {
		const saved = JSON.parse(storage.getItem(key));
		return saved?.version === 1 ? playerSnapshot(saved) : {};
	} catch {
		return {};
	}
}
export function savePlayer(storage, state, key = PLAYER_STORAGE_KEY) {
	try {
		storage.setItem(key, JSON.stringify(playerSnapshot(state)));
		return true;
	} catch {
		return false;
	}
}
