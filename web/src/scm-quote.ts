/**
 * Shell-quote one repo-relative path for the visible terminal.
 *
 * 单引号包裹 + 内部单引号按 POSIX 规则转义（`'` → `'\''`），保证拼接后
 * 是完整闭合的单个 shell token。回归：曾因漏掉闭合引号导致
 * `git add -- 'file`（引号未闭合）在终端执行失败（issue #51）。
 */
export const quotePath = (path: string): string => `'${path.replace(/'/g, `'\\''`)}'`;
