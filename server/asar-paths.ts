import { existsSync } from "node:fs";

const ASAR_NAME = "app.asar";
const UNPACKED_NAME = "app.asar.unpacked";

function isSeparator(char: string | undefined, win: boolean): boolean {
	if (char === "/") return true;
	return win && char === "\\";
}

/**
 * asar 解包路径映射（单源）：spawn/execFile 进 asar 内会失败（Windows 上直接
 * ENOENT；POSIX 上缺可执行位），可执行文件必须走 `app.asar.unpacked` 下的副本。
 *
 * 规则：路径含 `app.asar` 路径段（后跟分隔符或串尾；Windows 大小写不敏感）时，
 * 把该段换成 `app.asar.unpacked`；替换后 `existsSync` 成立才返回替换后的，
 * 否则原样返回（dev/未打包/按需解包关闭时都是直通，不改查找顺序与回退逻辑）。
 *
 * 纯函数（除最后一步的存在性探测外无副作用）；`app.asar.unpacked` 自身不再
 * 二次匹配（`.` 不是分隔符），所以幂等，可在 resolve 落点与 spawn 落点各包一层。
 */
export function toUnpackedPath(p: string): string {
	if (!p) return p;
	const win = process.platform === "win32";
	const hay = win ? p.toLowerCase() : p;
	let from = 0;
	for (;;) {
		const i = hay.indexOf(ASAR_NAME, from);
		if (i < 0) return p;
		const prev = i === 0 ? undefined : p[i - 1];
		const next = i + ASAR_NAME.length >= p.length ? undefined : p[i + ASAR_NAME.length];
		if ((prev === undefined || isSeparator(prev, win)) && (next === undefined || isSeparator(next, win))) {
			const mapped = p.slice(0, i) + UNPACKED_NAME + p.slice(i + ASAR_NAME.length);
			return existsSync(mapped) ? mapped : p;
		}
		from = i + ASAR_NAME.length;
	}
}
