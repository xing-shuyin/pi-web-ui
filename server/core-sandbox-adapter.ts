import type { SandboxLocated, SandboxPort } from "../packages/keel/src/contracts/sandbox.js";
import type { ServerMessage } from "../packages/keel/src/protocol.js";
import type { ServerLang } from "../packages/keel/src/i18n.js";
import { SandboxManager } from "./sandbox-data.js";

export interface CoreSandboxOptions {
	/** 沙盒注册表 / 隔离目录的根（`dataDir/sandboxes`）。 */
	dataDir: string;
	/** 一帧发给本客户端。 */
	emit(msg: ServerMessage): void;
	isDisposed?(): boolean;
	getLang?(): ServerLang;
	/** 当前工作目录：`path` 缺省时按它找沙盒（老口径 `path?.trim() || this.cwd`）。 */
	getCwd(): string;
}

/**
 * 宿主侧沙盒适配器：`SandboxManager`（注册表、baseline、copy/tree、diff、applyToSource）就是唯一实现，
 * 这里只补老方法里那圈「内核不认识」的周边动作——`sandbox_diff` 帧、notice、projects 缓存失效。
 *
 * 不重复实现内核那边已经做好的两件事：**切工作区**（`create` / `promote` 由内核调
 * `WorkspacePort.setCwd`）与 **owner 对话迁出**（`planSandboxLifecycle` 规划、内核执行）。
 * 失败口径与老树逐字一致：本文件自己发 error notice（端口不 reject，除非连帧都发不出去）。
 */
export function createCoreSandbox(options: CoreSandboxOptions): SandboxPort {
	const sandboxes = new SandboxManager(options.dataDir);
	const send = (msg: ServerMessage): void => {
		if (options.isDisposed?.()) return;
		options.emit(msg);
	};
	const notice = (level: "info" | "warning" | "error", text: string, textEn: string): void => {
		send({ type: "notice", level, text, textEn });
	};
	const target = (path?: string): string => path?.trim() || options.getCwd();
	const locatedOf = (path?: string): SandboxLocated | undefined => {
		const info = sandboxes.get(target(path)) ?? sandboxes.getByCwd(target(path));
		if (!info) return undefined;
		return {
			id: info.id,
			path: info.path,
			name: info.name,
			...(info.sourcePath ? { sourcePath: info.sourcePath } : {}),
		};
	};

	return {
		async locate(path?: string): Promise<SandboxLocated | undefined> {
			return locatedOf(path);
		},

		async create(opts): Promise<{ path: string }> {
			try {
				const { sandbox, copiedFiles } = await sandboxes.create(opts);
				const modeZh = sandbox.sourcePath ? `已从源项目导入 ${copiedFiles} 个文件` : "空白隔离环境";
				const modeEn = sandbox.sourcePath ? `imported ${copiedFiles} files from source` : "blank isolated workspace";
				notice(
					"info",
					`🧪 沙盒「${sandbox.name}」已启动（${modeZh}；仅支持受限文件编辑，禁止任意脚本执行）`,
					`🧪 Sandbox "${sandbox.name}" started (${modeEn}; restricted file editing only, arbitrary scripts are disabled)`,
				);
				return { path: sandbox.path };
			} catch (error) {
				notice(
					"error",
					`创建沙盒失败：${(error as Error).message}`,
					`Failed to create sandbox: ${(error as Error).message}`,
				);
				throw error;
			}
		},

		async reset(path?: string): Promise<void> {
			try {
				const { sandbox, copiedFiles } = await sandboxes.reset(target(path));
				notice(
					"info",
					sandbox.sourcePath
						? `🔄 已重置沙盒「${sandbox.name}」（重新从源项目同步 ${copiedFiles} 个文件）`
						: `🔄 已清空并重置沙盒「${sandbox.name}」`,
					sandbox.sourcePath
						? `🔄 Reset sandbox "${sandbox.name}" (re-synced ${copiedFiles} files from source)`
						: `🔄 Cleared and reset sandbox "${sandbox.name}"`,
				);
			} catch (error) {
				notice(
					"error",
					`重置沙盒失败：${(error as Error).message}`,
					`Failed to reset sandbox: ${(error as Error).message}`,
				);
			}
		},

		async persist(path?: string): Promise<void> {
			try {
				const sandbox = await sandboxes.persist(target(path));
				notice(
					"info",
					`📌 沙盒「${sandbox.name}」已转为永久保留`,
					`📌 Sandbox "${sandbox.name}" is now saved permanently`,
				);
			} catch (error) {
				notice(
					"error",
					`转换永久沙盒失败：${(error as Error).message}`,
					`Failed to persist sandbox: ${(error as Error).message}`,
				);
			}
		},

		async promote(targetPath: string, path?: string): Promise<{ targetPath: string }> {
			try {
				const { sandbox, targetPath: resolved, copiedFiles } = await sandboxes.promote(target(path), targetPath);
				notice(
					"info",
					`📤 已将沙盒「${sandbox.name}」导出为正式项目：${resolved}（共 ${copiedFiles} 个文件）`,
					`📤 Exported sandbox "${sandbox.name}" to formal project: ${resolved} (${copiedFiles} files)`,
				);
				return { targetPath: resolved };
			} catch (error) {
				notice(
					"error",
					`导出沙盒失败：${(error as Error).message}`,
					`Failed to export sandbox: ${(error as Error).message}`,
				);
				// 导出失败就不能切工作区：把目标留空，内核据此不起新会话。
				return { targetPath: "" };
			}
		},

		async diff(path?: string, requestId?: string): Promise<void> {
			const at = target(path);
			try {
				const res = await sandboxes.diffWithSource(at);
				send({
					type: "sandbox_diff",
					diff: {
						sandboxId: res.sandbox.id,
						requestId,
						expectedRevision: res.expectedRevision,
						path: res.sandbox.path,
						sourcePath: res.sourcePath,
						added: res.added,
						modified: res.modified,
						deleted: res.deleted,
						unchangedCount: res.unchangedCount,
					},
				});
			} catch (error) {
				// 对比失败也要出帧（客户端据此收起加载态并显示错误）。
				send({
					type: "sandbox_diff",
					diff: {
						sandboxId: "",
						requestId,
						path: at,
						added: [],
						modified: [],
						deleted: [],
						unchangedCount: 0,
						error: (error as Error).message,
					},
				});
			}
		},

		async applyToSource(path: string | undefined, expectedRevision: string): Promise<void> {
			try {
				const { sandbox, sourcePath, copiedFiles, deletedFiles } = await sandboxes.applyToSource(
					target(path),
					expectedRevision,
				);
				const delZh = deletedFiles ? `，清理 ${deletedFiles} 个已删除文件` : "";
				const delEn = deletedFiles ? `, pruned ${deletedFiles} deleted files` : "";
				notice(
					"info",
					`✅ 已将沙盒「${sandbox.name}」中的改动同步回源项目：${sourcePath}（同步 ${copiedFiles} 个文件${delZh}）`,
					`✅ Applied changes from sandbox "${sandbox.name}" back to source project: ${sourcePath} (${copiedFiles} files synced${delEn})`,
				);
			} catch (error) {
				notice(
					"error",
					`写回源项目失败：${(error as Error).message}`,
					`Failed to apply sandbox changes to source: ${(error as Error).message}`,
				);
			}
		},

		async destroy(path: string): Promise<void> {
			const sbx = locatedOf(path);
			if (!sbx) return; // 目标不是沙盒：老口径只清项目缓存 + 推 projects 帧（内核那边照常走）。
			try {
				await sandboxes.destroy(sbx.id);
				notice(
					"info",
					`🗑️ 已销毁沙盒项目「${sbx.name}」并清理隔离目录`,
					`🗑️ Destroyed sandbox project "${sbx.name}" and cleaned up isolated directory`,
				);
			} catch (error) {
				notice(
					"error",
					`销毁沙盒失败：${(error as Error).message}`,
					`Failed to destroy sandbox: ${(error as Error).message}`,
				);
			}
		},
	};
}
