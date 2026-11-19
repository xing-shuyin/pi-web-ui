import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** 翻译内容脚本的单源：browser/renderer/translate.js（打包时整目录进 dist/browser/renderer）。 */
export function getTranslateScript(): string {
	const candidates = [
		path.join(here, "..", "renderer", "translate.js"),
		path.join(here, "..", "..", "browser", "renderer", "translate.js"),
		path.join(here, "translate.js"),
	];
	for (const p of candidates) {
		try {
			if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
		} catch {}
	}
	console.warn("[browser] 读不到 translate.js，本轮不注入网页翻译");
	return "";
}

export const TRANSLATE_SCRIPT = getTranslateScript();
