import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

export function createStore({ dir, legacyDir }) {
	const ensure = () => {
		mkdirSync(dir, { recursive: true });
	};
	ensure();

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
