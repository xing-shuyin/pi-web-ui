/**
 * 生成文件，勿手改 —— `node scripts/gen-desktop-protocol.mjs`（`npm run build:desktop` 里跑）。
 *
 * 壳在构建期锁定的协议版本：纯壳包不带 `dist/server`，运行时无法读源码取版本，
 * 只能在构建时把数字烘进来，运行时交给 `desktop/kernel-compat.ts` 纯比较。
 */
export const DESKTOP_EXPECTED_PROTOCOL = 61;
/** 内核声明的兼容下限（与 `server/kernel-identity.ts` 的 KERNEL_MIN_SHELL 对表；读不到时为 null）。 */
export const DESKTOP_KERNEL_MIN_SHELL: number | null = 1;
