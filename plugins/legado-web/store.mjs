/**
 * 书源数据的落盘层 —— 书源 / 书架 / 进度 / 检测结果。
 *
 * 位置：`<dataDir>/legado-web/<key>.json`（默认 `~/.pi-web/legado-web/`）。
 * **不放插件目录**：`pi-web-ui install --force` 更新插件会先删掉整个插件目录、只保留
 * config.json，用户攒的书源会被更新洗掉。放数据目录则升级/重装/卸载都不受影响。
 *
 * 旧版插件目录里的 `storage/*.json` 仍作为只读回退源（读到就顺手搬过来）。
 * 写盘用 tmp + rename 原子替换。
 *
 * 注意：插件热重载（plugins_reload）只击穿 `index.mjs` 的 ESM 缓存，本文件的改动
 * 要等宿主重启才生效——所以依赖“改完立刻生效”的逻辑请放 index.mjs（如文件版本查询）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

export function createStore({ dir, legacyDir }) {
	const ensure = () => {
		mkdirSync(dir, { recursive: true });
	};

	/** 键文件：新目录优先，旧插件目录兜底（读到就搬到新目录）。 */
	const fileOf = (key) => {
		const now = join(dir, `${key}.json`);
		if (existsSync(now)) return now;
		const legacy = legacyDir ? join(legacyDir, `${key}.json`) : "";
		if (legacy && existsSync(legacy)) {
			try {
				ensure();
				writeFileSync(now, readFileSync(legacy));
				return now;
			} catch {
				return legacy;
			}
		}
		return now;
	};

	return {
		dir,
		listKeys() {
			try {
				return readdirSync(dir)
					.filter((f) => f.endsWith(".json"))
					.map((f) => f.slice(0, -5));
			} catch {
				return [];
			}
		},
		has(key) {
			return KEY_RE.test(key) && existsSync(fileOf(key));
		},
		/** 读 JSON；不存在返回 null，坏文件抛错。 */
		read(key) {
			if (!KEY_RE.test(key)) throw new Error(`非法键：${key}`);
			const file = fileOf(key);
			if (!existsSync(file)) return null;
			const raw = readFileSync(file, "utf8");
			return raw ? JSON.parse(raw) : null;
		},
		write(key, value) {
			if (!KEY_RE.test(key)) throw new Error(`非法键：${key}`);
			ensure();
			const target = join(dir, `${key}.json`);
			const tmp = `${target}.tmp-${process.pid}`;
			writeFileSync(tmp, JSON.stringify(value, null, 1), "utf8");
			renameSync(tmp, target);
			return Buffer.byteLength(JSON.stringify(value));
		},
	};
}
