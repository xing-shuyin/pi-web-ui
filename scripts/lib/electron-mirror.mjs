/**
 * Electron / electron-builder 二进制镜像的唯一事实源。
 *
 * 这两个 URL 以前写在仓库根的 `.npmrc`（`electron_mirror` / `electron_builder_binaries_mirror`），
 * 靠 npm 把自定义配置导出成 `npm_config_*` 环境变量，再被 `@electron/get` 和 electron-builder 读到。
 * npm 11 起自定义键属于「未识别配置」会逐条告警（`Unknown project config` / `Unknown env config`），
 * 且明确说下个大版本不再透传——所以改成在真正发起下载的进程里直接设置标准环境变量。
 *
 * 用户已设置的非空环境变量优先（方便走代理或换源），这里只补默认值。
 */
export const DEFAULT_ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/";
export const DEFAULT_ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/";

/** 返回带上镜像默认值的新 env，不修改入参。 */
export function withElectronMirror(env = process.env) {
	const merged = { ...env };
	if (!merged.ELECTRON_MIRROR?.trim()) merged.ELECTRON_MIRROR = DEFAULT_ELECTRON_MIRROR;
	if (!merged.ELECTRON_BUILDER_BINARIES_MIRROR?.trim()) {
		merged.ELECTRON_BUILDER_BINARIES_MIRROR = DEFAULT_ELECTRON_BUILDER_BINARIES_MIRROR;
	}
	return merged;
}
