/**
 * 洛雪音乐本地存储层 —— 歌单、自定义音源、播放历史
 * 存储路径：`<dataDir>/lx-music/<key>.json`
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function createStore(dir) {
	try {
		mkdirSync(dir, { recursive: true });
	} catch {}

	const fileOf = (key) => join(dir, `${key}.json`);

	return {
		dir,
		get(key, fallback = null) {
			const file = fileOf(key);
			if (!existsSync(file)) return fallback;
			try {
				return JSON.parse(readFileSync(file, "utf8"));
			} catch {
				return fallback;
			}
		},
		set(key, val) {
			const file = fileOf(key);
			const tmp = `${file}.tmp.${Date.now()}`;
			try {
				mkdirSync(dir, { recursive: true });
				writeFileSync(tmp, JSON.stringify(val, null, 2), "utf8");
				renameSync(tmp, file);
				return true;
			} catch  {
				try {
					writeFileSync(file, JSON.stringify(val, null, 2), "utf8");
					return true;
				} catch {
					return false;
				}
			}
		},
	};
}
