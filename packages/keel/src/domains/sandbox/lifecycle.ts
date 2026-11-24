import { isInsideRoots } from "../../path-boundary.js";

export type SandboxLifecycleAction = "reset" | "apply" | "destroy";

/** 一个「cwd 落在沙盒里」的对话：生命周期操作前必须先迁出去（否则它会在被清空的目录上继续跑）。 */
export interface SandboxOwnerFact {
	conversationId: string;
	cwd: string;
}

export interface SandboxPlanInput {
	action: SandboxLifecycleAction;
	/** 沙盒真实目录（宿主解析后的绝对路径）。 */
	sandboxPath: string;
	/** 当前所有对话的 cwd；规划自己筛（不依赖调用方预筛，免得两处判定不一致）。 */
	owners: readonly SandboxOwnerFact[];
	/** 迁出目标：一般是有源项目就回源项目，没有就 home。 */
	fallbackPath: string;
	/** 沙盒路径判定（缺省用 `path-boundary` 的单源谓词）；测试可注。 */
	isInside?(target: string, root: string): boolean;
}

export interface SandboxPlan {
	/** 要迁出沙盒的对话（按给定顺序，先到先迁）。 */
	moves: readonly { conversationId: string; to: string }[];
	/** 操作完回到哪个目录；`undefined` = 不回去（destroy 之后沙盒已经不存在了）。 */
	restoreTo?: string;
}

/**
 * 沙盒生命周期的**纯编排**（不碰 IO、不碰端口）：决定「谁要迁出、迁到哪、要不要回来」。
 *
 * 老树把这段和 `setCwd`、终端清理、goal 通知糊在 `coordinateSandboxLifecycle` 一个方法里
 * （约 40 行，读一次改一次）。这里只留判定，执行交给 handler（迁出走工作区重绑原语）。
 */
export function planSandboxLifecycle(input: SandboxPlanInput): SandboxPlan {
	const isInside = input.isInside ?? ((target: string, root: string) => isInsideRoots(target, [root]));
	const moves: { conversationId: string; to: string }[] = [];
	for (const owner of input.owners) {
		if (!owner.cwd || !isInside(owner.cwd, input.sandboxPath)) continue;
		moves.push({ conversationId: owner.conversationId, to: input.fallbackPath });
	}
	// reset / apply 之后沙盒还在（且被清空或写回过），用户要回的仍是沙盒；destroy 则不能回去。
	return input.action === "destroy" ? { moves } : { moves, restoreTo: input.sandboxPath };
}
