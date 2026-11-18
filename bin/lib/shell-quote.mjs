// AUTO-GENERATED FILE — 不要手改。
// 来源：server/shell-quote.ts（npm run build:server 编译产物整份搬运）
// 重新生成：npm run gen:bin-mirrors（npm run build:server 末尾也会跑）
// 守卫：tests/unit/bin-mirror.test.ts 与 dist/server/shell-quote.js 逐字节比对，漂移即红。
/**
 * shell / PowerShell 的引号单源。同一件事原来有三份实现：`server/remote-ssh-service.ts` 的
 * `shellQuotePosix`（POSIX 远端命令拼装，被 file-transfer / remote-cli 等 6+ 处 import）、
 * `bin/pi-web-ui.mjs` 的 `shQuote`（systemd unit / 启动脚本，和前者逐字符等价）与 `psQuote`
 * （PowerShell 的 `$env:X = '…'` 计划任务脚本）。
 *
 * 拼错一个引号 = 远端命令被执行成别的意思，所以这里只留一份实现：
 * - `shellQuotePosix`：单引号包裹，内部 `'` → `'\''`（`/bin/sh` 语义）。
 * - `shellQuotePowerShell`：单引号包裹，内部 `'` → `''`（PowerShell 单引号字面量语义）。
 *
 * CLI（`bin/pi-web-ui.mjs`）不能 import TS，通过生成件 `bin/lib/shell-quote.mjs` 共用（见
 * `scripts/gen-bin-mirrors.mjs`，守卫 `tests/unit/bin-mirror.test.ts`）。
 */
/** 给 `/bin/sh` 家族转义：结果总能安全拼进一行远端命令。 */
export function shellQuotePosix(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
/** 给 PowerShell 单引号字面量转义（`'it''s'`），用于计划任务 / `$env:` 赋值脚本。 */
export function shellQuotePowerShell(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}
