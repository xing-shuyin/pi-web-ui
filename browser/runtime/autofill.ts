import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 网页侧的自动填充脚本（`browser/renderer/autofill.js`）从这里注入到每个 http(s) 页面。
 *
 * 和 `dock.ts` 一样按候选路径找文件（源码树 / dist / 同目录），因为这段脚本是**纯 JS 直接执行**、
 * 不进渲染层的打包产物。找不到就返回空串——宁可没有下拉，也不要半截脚本在页面里报错。
 */
export function getAutofillScript(): string {
	const candidates = [
		path.join(here, "..", "renderer", "autofill.js"),
		path.join(here, "..", "..", "browser", "renderer", "autofill.js"),
		path.join(here, "autofill.js"),
	];
	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf-8");
		} catch {}
	}
	return "";
}

export const AUTOFILL_SCRIPT = getAutofillScript();
