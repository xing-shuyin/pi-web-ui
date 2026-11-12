/**
 * 模型 id 归一化（单源）。
 *
 * 宿主 `__piWebUiHost.models.list()` 给的 `id` 已经带 provider 前缀
 * （例如 `opencode-go/longcat-2.5-free`），插件早期又按 `${provider}/${id}`
 * 拼了一次，于是存成 `opencode-go/opencode-go/longcat-2.5-free` —— 这种 id
 * 传给 `host.llm.complete` 只会报「找不到模型」，巡检静默退回抽取式摘要，
 * 表现就是详情页通篇复读字幕开头。
 *
 * 前端那边不需要这个模块：它只要不重复拼接即可（见 client/entry.mjs 的模型下拉）。
 */

const DUP_PREFIX = /^([^/]+)\/\1\/(.+)$/;

/** 收敛重复 provider 前缀；其它形式原样返回（`""` 表示跟随宿主默认）。 */
export function normalizeModelId(value) {
	const s = String(value ?? "").trim();
	if (!s) return "";
	const m = DUP_PREFIX.exec(s);
	return m ? `${m[1]}/${m[2]}` : s;
}
