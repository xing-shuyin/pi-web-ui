/**
 * 运行时更新的壳侧常量（P2）。改这里等于改信任根 / 兼容线，改动要跟文档一起走。
 *
 * 1. `RUNTIME_PUBLIC_KEY_PEM`：ed25519 公钥，**留空 = 一律拒绝任何运行时更新**（fail closed）。
 *    生成方式：`npm run build:desktop-runtime -- --keygen`，把打印出的 PUBLIC KEY 整段粘进来；
 *    私钥只存 CI secret `DESKTOP_RUNTIME_SIGNING_KEY`，不要进仓库。
 * 2. `SHELL_CAPABILITY_VERSION`：壳能力版本。改 preload / IPC / 浏览器宿主等"壳才有"的能力时 +1；
 *    运行时清单里的 `minShell` 高于它就不切换，提示先更新壳（文档 §六）。
 * 3. `DEFAULT_RUNTIME_FEED_URL`：正式发布目录。GitHub Release 的 `latest/download` 是稳定别名，
 *    资产名固定（`runtime.json` / `runtime.json.sig` / `core-<ver>-<p>-<a>.tar.zst`）。
 */

// 公钥指纹（sha256/DER 前 32 hex）：c144c102c473edbfcbfecafdc1662151，生成于 2026-11-17。
// 对应私钥只存 CI secret `DESKTOP_RUNTIME_SIGNING_KEY`；轮换要发一次壳（公钥在壳里）。
export const RUNTIME_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAcQPqchk6PGtiBxacLgl1nma1f4EYzvO9QsBCXyKKbTI=
-----END PUBLIC KEY-----
`;

export const SHELL_CAPABILITY_VERSION = 1;

/**
 * 内核权威链：`npm-global` = 以全局 npm 包为准，壳不再自更新内核（默认）；
 * `bundled-runtime` = 旧双层模型（`<userData>/runtime` 签名清单自更新）。
 * 只能有一条权威链，细则见 `docs/architecture-kernel.md` §9 与 `desktop/kernel-authority.ts`。
 */
export type KernelAuthority = "npm-global" | "bundled-runtime";

export const KERNEL_AUTHORITY = "npm-global" as KernelAuthority;

/** 运行时自更新是否可作为权威链。`npm-global` 下它为 false：仍可作离线兜底，但不再自动下载/切换。 */
export const RUNTIME_SELF_UPDATE_ENABLED: boolean = KERNEL_AUTHORITY === "bundled-runtime";

export const DEFAULT_RUNTIME_FEED_URL = "https://github.com/xing-shuyin/pi-web-ui/releases/latest/download";
