/**
 * 「插进输入框」的去重判定（纯函数，单测直接跑）。
 *
 * 两个入口共用一条 sink（`web/src/composer-bridge.ts` 的 `insertTextAtCursor`）：
 * - **@ 提及**（左栏智能体右键 / 文件树点一下）：同一个 `@名字 ` 已经在输入框里就不再插第二遍，
 *   否则连点两下会得到 `@bot @bot `；
 * - **引用块**（浏览器标签页 / 选中文字 / 终端）：每一条都是一次明确的用户动作，
 *   **同一条引用插第二次也是要的**（「刚才那段再引一遍」），不能按文本内容去重。
 *
 * 之前的实现只按「正文是否已出现在输入框里」判断，于是第二次引用同一个页面就静默无反应——
 * 看起来像「右键的引用到输入框无效」。所以判据里必须区分这两类：只有 `@` 开头的才算提及。
 */

/** 感官上「长得像 @ 提及」：`@` 紧跟名字（允许前导空格与中文全角 @）。 */
function isMentionInsertion(core: string): boolean {
	return /^[@＠]/.test(core);
}

/** `core` 里的正则元字符转义后再当字面量用（提及名可能带 `.` `(` 之类）。 */
function escapeRegExp(core: string): string {
	return core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 这次插入要不要跳过？
 *
 * @param existing 输入框当前正文
 * @param insertion 待插入的文本
 * @returns true = 已经在里面了（提及去重），false = 照插
 */
export function shouldSkipInsertion(existing: string, insertion: string): boolean {
	const core = String(insertion ?? "").trim();
	if (!core || !isMentionInsertion(core)) return false;
	const re = new RegExp("(^|[\\s(（\"'“‘[【])" + escapeRegExp(core) + "(?=[\\s,.;:!?，。！？)\\]】」）]|$)");
	return re.test(String(existing ?? ""));
}
