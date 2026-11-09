import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * 插件「代码」与「状态」的路径单源。
 *
 * 代码目录（`<dataDir>/plugins/<id>/`）= **纯缓存**：随包插件会被物化/升级覆盖，
 * 依赖可重装，下载物可重下。半残了可以放心修、放心重放。
 *
 * 状态目录（`<dataDir>/plugin-data/<id>/`）= **不可再生**：用户设置、加密机密、
 * 持久定时任务、能力确认标记。代码怎么重建都不该碰到它 —— 这才是「自愈」敢动手的前提。
 *
 * 历史坑：状态曾住在代码目录里（`plugins/<id>/storage.json` + `secrets.bin`），
 * 于是任何「删了重放」都会顺手清掉用户的配置与渠道授权，修复逻辑只能靠手写
 * keepDirs 名单硬撑（见 plugin-updater 的回滚）。issue #856 的空目录永久化
 * 正是这套混住模型的下游症状。
 */

/** 曾住在代码目录、现在归状态目录的文件；迁移时逐个搬过去 */
export const PLUGIN_STATE_FILES: readonly string[] = ["storage.json", "secrets.bin", "schedules.json", ".pi-approved"];

export function pluginCodeDir(dataDir: string, id: string): string {
	return join(dataDir, "plugins", id);
}

export function pluginStateDir(dataDir: string, id: string): string {
	return join(dataDir, "plugin-data", id);
}

export function pluginStateFile(dataDir: string, id: string, name: string): string {
	return join(pluginStateDir(dataDir, id), name);
}

/**
 * 老布局 → 新布局的一次性搬家（幂等）。
 *
 * 只搬「代码目录里有、状态目录里没有」的文件：两边都有时以状态目录为准，
 * 绝不拿旧副本覆盖新状态。返回实际搬走的文件名，调用方可据此打日志。
 */
export function migratePluginState(dataDir: string, id: string): string[] {
	const codeDir = pluginCodeDir(dataDir, id);
	const stateDir = pluginStateDir(dataDir, id);
	const moved: string[] = [];
	for (const name of PLUGIN_STATE_FILES) {
		const from = join(codeDir, name);
		const to = join(stateDir, name);
		if (!existsSync(from) || existsSync(to)) continue;
		try {
			mkdirSync(stateDir, { recursive: true });
			renameSync(from, to);
			moved.push(name);
		} catch {
			try {
				copyFileSync(from, to);
				rmSync(from, { force: true });
				moved.push(name);
			} catch (err) {
				console.warn(`[plugins] 迁移插件状态失败 ${from} → ${to}:`, err instanceof Error ? err.message : err);
			}
		}
	}
	return moved;
}
