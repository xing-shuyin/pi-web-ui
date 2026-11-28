// AUTO-GENERATED FILE — 不要手改。
// 来源：shared/data-dir.ts（npm run build:server 编译产物整份搬运）
// 重新生成：npm run gen:bin-mirrors（npm run build:server 末尾也会跑）
// 守卫：tests/unit/bin-mirror.test.ts 与 dist/shared/data-dir.js 逐字节比对，漂移即红。
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
export const DEFAULT_DATA_DIR_NAME = ".keel";
export const LEGACY_DATA_DIR_NAME = ".pi-web";
export const DESKTOP_USER_DATA_DIR_NAME = "keel";
export const LEGACY_DESKTOP_USER_DATA_NAMES = ["keel-agent", "pi-web-ui-desktop"];
/**
 * 将旧版目录直接移动（rename）到新目录；跨盘符时回退为复制后删除原目录。
 * 仅在目标目录尚不存在且存在旧目录时触发。
 */
export function migrateLegacyDirSync(targetDir, legacyDirs, label = "data-dir") {
	const resolvedTarget = resolve(targetDir);
	if (existsSync(resolvedTarget)) return { migrated: false };
	const sourceDir = legacyDirs.map((dir) => resolve(dir)).find((dir) => dir !== resolvedTarget && existsSync(dir));
	if (!sourceDir) return { migrated: false };
	try {
		mkdirSync(dirname(resolvedTarget), { recursive: true });
		try {
			renameSync(sourceDir, resolvedTarget);
		} catch (error) {
			const code = error?.code;
			if (code !== "EXDEV") throw error;
			cpSync(sourceDir, resolvedTarget, { recursive: true });
			rmSync(sourceDir, { recursive: true, force: true });
		}
		console.log(`[keel] 已将旧 ${label} 目录迁移至 ${resolvedTarget}（原路径: ${sourceDir}）`);
		return { migrated: true, from: sourceDir, to: resolvedTarget };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[keel] 自动迁移 ${label} 失败（${sourceDir} → ${resolvedTarget}）：${message}`);
		return { migrated: false, from: sourceDir, to: resolvedTarget, error: message };
	}
}
export function defaultDataDir(home = homedir()) {
	return join(home, DEFAULT_DATA_DIR_NAME);
}
export function legacyDataDir(home = homedir()) {
	return join(home, LEGACY_DATA_DIR_NAME);
}
/**
 * 解析默认服务端数据目录（~/.keel）；若未显式指定且 ~/.keel 不存在但 ~/.pi-web 存在，则自动迁移。
 */
export function resolveDefaultDataDir(options) {
	const explicit = options?.explicit?.trim();
	if (explicit) return resolve(explicit);
	const envDir = (options?.env ?? process.env).PI_WEB_DATA_DIR?.trim();
	if (envDir) return resolve(envDir);
	const home = options?.home ?? homedir();
	const target = defaultDataDir(home);
	if (options?.migrate !== false) {
		migrateLegacyDirSync(target, [legacyDataDir(home)], "data-dir");
	}
	return target;
}
