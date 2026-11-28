import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_DATA_DIR_NAME = ".keel";
export const LEGACY_DATA_DIR_NAME = ".pi-web";
export const DESKTOP_USER_DATA_DIR_NAME = "keel";
export const LEGACY_DESKTOP_USER_DATA_NAMES = ["keel-agent", "pi-web-ui-desktop"] as const;

export interface MigrateDirResult {
	migrated: boolean;
	from?: string;
	to?: string;
	error?: string;
}

/**
 * 将旧版目录直接移动（rename）到新目录；跨盘符时回退为复制后删除原目录。
 * 仅在目标目录尚不存在且存在旧目录时触发。
 */
export function migrateLegacyDirSync(
	targetDir: string,
	legacyDirs: readonly string[],
	label = "data-dir",
): MigrateDirResult {
	const resolvedTarget = resolve(targetDir);
	if (existsSync(resolvedTarget)) return { migrated: false };

	const sourceDir = legacyDirs.map((dir) => resolve(dir)).find((dir) => dir !== resolvedTarget && existsSync(dir));
	if (!sourceDir) return { migrated: false };

	try {
		mkdirSync(dirname(resolvedTarget), { recursive: true });
		try {
			renameSync(sourceDir, resolvedTarget);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
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

export function defaultDataDir(home = homedir()): string {
	return join(home, DEFAULT_DATA_DIR_NAME);
}

export function legacyDataDir(home = homedir()): string {
	return join(home, LEGACY_DATA_DIR_NAME);
}

/**
 * 解析默认服务端数据目录（~/.keel）；若未显式指定且 ~/.keel 不存在但 ~/.pi-web 存在，则自动迁移。
 */
export function resolveDefaultDataDir(options?: {
	explicit?: string;
	env?: NodeJS.ProcessEnv;
	home?: string;
	migrate?: boolean;
}): string {
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
