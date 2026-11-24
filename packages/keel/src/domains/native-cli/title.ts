import { basename } from "node:path";
import type { NativeCliConfig } from "../../protocol.js";

/**
 * 会话名（标题）的**唯一判定处**：什么时候算「还是自动名」、自动名长什么样、从输入派生什么。
 *
 * 三条语意与老实现（`server/native-cli.ts` 的 `isDefaultNativeCliTitle` +
 * `agent-service.ts` 的 `updateNativeCliTitleFromInput`）逐字一致：
 *
 * 1. 新建时的自动名 = `<preset> CLI`（`custom` 用可执行文件名）——用户没给标题时才用；
 * 2. 输入派生名只在**当前标题仍是自动名**时才写回（用户改过名就再不自动覆盖，见 `isDefaultNativeCliTitle`）；
 * 3. 派生规则：首行 → 去掉开头的引用/附件标记 → 超 30 字截断加 `…` → 派不出「非自动名」就放弃。
 *
 * 纯函数、无 I/O：宿主叶子里的同名判定是待退役的老树副本，新树只认这里。
 */

const DEFAULT_TITLE = /^(agy|claude|pi|codex|dsh|custom)\s+cli$/i;
/** 输入首行开头的引用标记（`@文件` / `📎附件` / `#标签`）：老实现 `^[@📎#]+\s*` 同一条。 */
const LEADING_MARKS = /^[@📎#]+\s*/u;
const MAX_TITLE = 30;

/**
 * 当前标题还算「自动名」吗？
 * `true` = 还能被自动标题覆盖；`false` = 用户改过名，任何自动标题都不许动它。
 */
export function isDefaultNativeCliTitle(title: string, preset?: string, executable?: string): boolean {
	const trimmed = title.trim();
	if (!trimmed) return true;
	if (preset && trimmed.toLowerCase() === `${preset.toLowerCase()} cli`) return true;
	if (executable && trimmed.toLowerCase() === basename(executable).toLowerCase()) return true;
	return DEFAULT_TITLE.test(trimmed);
}

/** 新建 CLI 对话的默认名：`<preset> CLI`；`custom` 用可执行文件名（file 名，不是整条路径）。 */
export function defaultNativeCliTitle(config: Pick<NativeCliConfig, "preset" | "executable">): string {
	if (config.preset !== "custom") return `${config.preset} CLI`;
	return config.executable ? basename(config.executable) : "custom CLI";
}

/**
 * 从用户的一次输入派生会话名。返回 `undefined` = 这次不该改名（空输入 / 派生出来还是自动名）。
 * 调用方必须先过 `isDefaultNativeCliTitle` 的用户改名闸：这里只管「派生得出什么」。
 */
export function deriveNativeCliTitleFromInput(text: string, preset?: string, executable?: string): string | undefined {
	const trimmed = (text ?? "").trim();
	if (!trimmed) return undefined;
	const firstLine = trimmed.split("\n")[0].trim();
	const clean = firstLine.replace(LEADING_MARKS, "").trim() || firstLine;
	const title = clean.length > MAX_TITLE ? `${clean.slice(0, MAX_TITLE)}…` : clean;
	if (!title || isDefaultNativeCliTitle(title, preset, executable)) return undefined;
	return title;
}
