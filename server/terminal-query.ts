/**
 * 终端「查询 / 回传」序列的单源。
 *
 * 终端里的程序（以及 Windows ConPTY 自己）会用 CSI / OSC 查询终端能力，终端会**自动回话**，
 * 这些回话是走 PTY **输入**通道回来的。于是有两条铁律：
 * 1. 真实输出流里的查询必须原样交给终端，否则谁都不回话；
 * 2. 历史回放（重置重画、重新挂载、换客户端）不能再把查询喂给终端——回话此刻已经过期，
 *    会作为普通按键落到 shell 提示符上（ConPTY 只认第一条回话，多出来的 `1;2c` / `[12;40R`
 *    就会直接被打进命令行）。
 */

/** 会让终端自动回话的查询请求（DA1/DA2/DA3、DSR、DECRQM、窗口尺寸报告、XTVERSION、OSC 颜色查询）。 */
export const TERMINAL_QUERY_REQUEST_RE =
	/(?:\x1b\[(?:[>=]?0?c|\??6n|5n|\??\d+\$p|1[4-9]t|>0?q)|\x1b\](?:1[0-2]|4;\d+);\?(?:\x07|\x1b\\))+/g;

/** 从回放用的历史里摘掉查询请求：只剩下渲染效果，不会诱使终端再回话。 */
export function stripTerminalQueryRequests(data: string): string {
	return data.replace(TERMINAL_QUERY_REQUEST_RE, "");
}

/** 终端对上述查询的回话形态（判断「这段输入不是人敲的」用）。 */
export const TERMINAL_QUERY_RESPONSE_RE =
	/^(?:\x1b\[(?:\??|>|<)?\d*(?:;\d+)*(?:\$?y|[cRnIOt])|\x1b\]\d+;[^\x07\x1b]*(?:\x07|\x1b\\))+$/;

export function isTerminalQueryResponse(data: string): boolean {
	return TERMINAL_QUERY_RESPONSE_RE.test(data);
}

/** ConPTY 启动时发 DA1 并**阻塞输入**直到收到回话；xterm.js 回的也是这一句。 */
export const CONPTY_DA1_REPLY = "\x1b[?1;2c";

const CONPTY_DA1_RE = /\x1b\[0?c/;
const DA1_PARTIAL_TAIL_RE = /\x1b(?:\[0?)?$/;

/**
 * 从 ConPTY 输出里摘掉启动期 DA1，并给出服务端该回的那一句（每个 PTY 只回一次）。
 *
 * 服务端自己回答可以保证「一问一答」：不依赖浏览器此刻是否挂着 xterm、是否在回放历史，
 * 也就不会有多余的回话漏进 shell。`pending` 用来兜住被切在两个 chunk 中间的查询前缀。
 */
export function splitConptyDa1(
	pending: string,
	chunk: string,
): { reply: string | null; pass: string; pending: string } {
	const buf = pending + chunk;
	const match = CONPTY_DA1_RE.exec(buf);
	if (!match) {
		const tail = DA1_PARTIAL_TAIL_RE.exec(buf)?.[0] ?? "";
		return {
			reply: null,
			pass: tail ? buf.slice(0, buf.length - tail.length) : buf,
			pending: tail,
		};
	}
	return {
		reply: CONPTY_DA1_REPLY,
		pass: buf.slice(0, match.index) + buf.slice(match.index + match[0].length),
		pending: "",
	};
}
