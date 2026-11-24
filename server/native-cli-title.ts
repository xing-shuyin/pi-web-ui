import { isDefaultNativeCliTitle } from "./native-cli.js";
import { stripAnsi } from "./terminals.js";

/**
 * 从 CLI 终端回卷缓冲里回填会话名（**纯函数，单源**）。
 *
 * 老实现这段逻辑内联在 `AgentService#tryExtractNativeCliTitleFromTerminal` 上，core 的 CLI 宿主
 * （`server/native-cli-host.ts`）要的是同一件事，所以整段抽到这里：两边只调这一个函数，
 * 判定规则（自底向上找最后一行「有意义」的输出）里里外外只有一份。
 *
 * 三条语意与老实现逐字一致：
 * 1. **用户改过名就不再动**（`isDefaultNativeCliTitle` 闸）：函数返回 `undefined`；
 * 2. 只看最后一行有内容的输出，纯框线 / 分隔线跳过；
 * 3. 去掉行首提示符（`>` / `$` / `📎` / `╭─` …），超 30 字截断加 `…`；派生结果仍是自动名就放弃。
 */
const DECORATION = /^[│─┌┐└┘├┤┬┴┼═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬·•\s_-]+$/;
const LEADING_MARKS = /^([>▶$➜%?#📎]|╭─|╰─)\s*/u;
const MAX_TITLE = 30;

export interface NativeCliTitleHint {
	/** 当前标题：仍是自动名才允许回填（用户改过名 = 永不覆盖）。 */
	title: string;
	preset?: string;
	executable?: string;
}

export function nativeCliTitleFromTerminalOutput(output: string, hint: NativeCliTitleHint): string | undefined {
	if (!output) return undefined;
	if (!isDefaultNativeCliTitle(hint.title, hint.preset, hint.executable)) return undefined;
	const lines = stripAnsi(output).split("\n");
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index].trim();
		if (!line || line.length < 2 || DECORATION.test(line)) continue;
		const clean = line.replace(LEADING_MARKS, "").trim();
		if (clean.length < 2 || clean.startsWith("Error:") || clean.startsWith("warning")) continue;
		const title = clean.length > MAX_TITLE ? `${clean.slice(0, MAX_TITLE)}…` : clean;
		if (isDefaultNativeCliTitle(title, hint.preset, hint.executable)) continue;
		return title;
	}
	return undefined;
}
