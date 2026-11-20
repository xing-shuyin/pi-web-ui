import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 下载圆钮（右下角悬浮球里那一颗）的注入脚本（`browser/renderer/downloads.js`）。
 *
 * 和 `dock.ts` 的取法一致：源码树、dist 产物、同目录三处找，装包后的布局不同也能命中。
 * 与 dock 不同的是这里**没有内联副本**——找不到就当没有（宁可不显示，也不维护两份会走样的脚本）。
 */
export function getDownloadsScript(): string {
	const candidates = [
		path.join(here, "..", "renderer", "downloads.js"),
		path.join(here, "..", "..", "browser", "renderer", "downloads.js"),
		path.join(here, "downloads.js"),
	];
	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf-8");
		} catch {}
	}
	return "";
}

export const DOWNLOADS_SCRIPT = getDownloadsScript();

/**
 * 把状态塞进 `executeJavaScript` 的源码里：借 JSON 的字面量转义，再挡掉能改语句结尾的字符
 * （文件名是网站给的，`\u2028` / `<` 这类字符必须在这里消化掉）。
 */
export function scriptLiteral(value: unknown): string {
	return JSON.stringify(value ?? null)
		.replace(/</g, "\\u003c")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}
