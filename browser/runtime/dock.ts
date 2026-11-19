import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const SCROLLBAR_CSS = `
::-webkit-scrollbar {
  width: 4px !important;
  height: 4px !important;
}
::-webkit-scrollbar-track {
  background: transparent !important;
}
::-webkit-scrollbar-thumb {
  background: rgba(91, 140, 255, 0.45) !important;
  border-radius: 4px !important;
  transition: all 0.2s ease !important;
}
::-webkit-scrollbar-thumb:hover {
  background: #5b8cff !important;
  box-shadow: 0 0 6px rgba(91, 140, 255, 0.8) !important;
}
::-webkit-scrollbar-corner {
  background: transparent !important;
}
`;

/**
 * 悬浮 dock 的注入源码：**只有 `browser/renderer/dock.js` 这一份**。
 *
 * 以前这里还留着一份「读不到文件就退回内联脚本」的复制品，结果两套实现各自演进
 * （内联那份既没有收藏弹窗，也没有顶层宿主 / 看门狗），修了文件版等于没修装包版。
 * 现在源码仓库与打包产物（`scripts/build-browser.mjs` 的 `filesToCopy` 会把 dock.js
 * 复制进 `dist/browser/renderer/`，`electron-builder.yml` 的 `dist/browser` 整目录进包）
 * 都能按下面的候选路径读到真身；真读不到就返回空串并告警——宁可没有圆钮，
 * 也不要一份会静默跑偏的第二实现。
 */
export function getDockScript(): string {
	const candidates = [
		path.join(here, "..", "renderer", "dock.js"),
		path.join(here, "..", "..", "browser", "renderer", "dock.js"),
		path.join(here, "dock.js"),
	];
	for (const p of candidates) {
		try {
			if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
		} catch {}
	}
	console.warn(`[browser] 读不到 dock.js（找过 ${candidates.join(", ")}），本轮不注入悬浮圆钮`);
	return "";
}

export const DOCK_SCRIPT = getDockScript();
