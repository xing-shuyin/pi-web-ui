import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { WorkspaceHostPort, WorkspaceTarget } from "../packages/keel/src/contracts/workspace.js";
import { isRemoteWorkspaceUri, resolveWorkspaceSessionDir } from "../packages/keel/src/remote-workspace.js";

export interface CoreWorkspaceOptions {
	/** `client-state.json` 所在目录（远程工作区的 SDK 会话落 `dataDir/sessions-workspace/...`）。 */
	dataDir?: string;
	/** 工作区真的换过去之后要做的宿主收尾（git 监听、工作树信息、终端面板、项目缓存）。 */
	onChanged?(cwd: string, roots: readonly string[]): void | Promise<void>;
}

/** 「此电脑」这类伪路径不是目录：`setCwd` 必须给出可操作的错误，别切进一个不存在的目标。 */
const MACHINE_ROOT = "@root";

async function resolveLocalTarget(input: string, from: string): Promise<WorkspaceTarget> {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("路径为空");
	const home = homedir();
	// 从远程工作区切回本地时，相对路径的基准只能是 home（远程 URI 不能当 `path.resolve` 的 base）。
	const base = isRemoteWorkspaceUri(from) ? home : from;
	const expanded =
		trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")
			? resolve(home, trimmed.slice(1))
			: trimmed;
	const abs = resolve(base, expanded);
	const info = await stat(abs);
	if (!info.isDirectory()) throw new Error("路径不是目录");
	return { cwd: abs };
}

/**
 * 宿主侧工作区适配器：只补内核不知道的两件事——**目标怎么解析**与**换完之后的宿主收尾**。
 *
 * 重绑链（释放旧会话 → 在新 cwd 建会话 → 重算快照/推帧 → 失败回滚）在 keel 里只有一份
 * （`packages/keel/src/domains/sessions/rebind.ts`），这里不重复实现它。
 */
export function createCoreWorkspace(options: CoreWorkspaceOptions = {}): WorkspaceHostPort {
	return {
		async resolveTarget(input: string, from: string): Promise<WorkspaceTarget> {
			const trimmed = input.trim();
			if (trimmed === MACHINE_ROOT) {
				throw new Error("请选择一个具体目录作为工作目录（此电脑本身不是目录）");
			}
			if (isRemoteWorkspaceUri(trimmed)) {
				// 远程工作区：cwd 是 URI，SDK 会话落本地镜像目录（两者必须分开，否则会话目录会变成 `ssh://…`）。
				return { cwd: trimmed, sessionCwd: resolveWorkspaceSessionDir(options.dataDir, trimmed) };
			}
			return resolveLocalTarget(trimmed, from);
		},
		onChanged: (cwd, roots) => options.onChanged?.(cwd, roots),
	};
}
