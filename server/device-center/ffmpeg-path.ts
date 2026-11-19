import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toUnpackedPath } from "../asar-paths.js";

let cached: { path?: string } | undefined;

/**
 * Locate the ffmpeg binary used by the H.264 desktop backend.
 *
 * Order: explicit `PI_DESKTOP_FFMPEG` (absolute path only) → bundled
 * `bin/ffmpeg/<platform>-<arch>/ffmpeg(.exe)` → bare `ffmpeg` on PATH.
 *
 * Bundled binaries are not committed (see scripts/fetch-ffmpeg.mjs): the desktop
 * release workflow downloads them so installed apps never depend on the user's PATH.
 */
export function resolveFfmpeg(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (cached) return cached.path;
	cached = {};
	const override = env.PI_DESKTOP_FFMPEG;
	if (override) {
		cached.path = isAbsolute(override) && existsSync(override) ? override : undefined;
		return cached.path;
	}
	const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
	const key = `${process.platform}-${process.arch}`;
	const dir = dirname(fileURLToPath(import.meta.url));
	for (const root of [resolve(dir, "../../bin/ffmpeg"), resolve(dir, "../../../bin/ffmpeg")]) {
		const path = join(root, key, name);
		if (existsSync(path)) {
			// asar 内可读但不可执行：spawn/execFile 必须走 app.asar.unpacked 下的副本。
			// 存在性探测仍用原路径（查找顺序/回退逻辑不变），只映射最终交出去的路径。
			cached.path = toUnpackedPath(path);
			return cached.path;
		}
	}
	cached.path = undefined;
	return undefined;
}

/** Test hook: forget the resolved binary (env or bundle changes between tests). */
export function resetFfmpegCache() {
	cached = undefined;
}
