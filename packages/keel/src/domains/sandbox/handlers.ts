import { homedir } from "node:os";
import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { WorkspacePort } from "../../contracts/files.js";
import type { SandboxLocated, SandboxPort } from "../../contracts/sandbox.js";
import { planSandboxLifecycle, type SandboxLifecycleAction, type SandboxOwnerFact } from "./lifecycle.js";

/** 沙盒里的对话怎么迁出：判定 + 迁移都由 app 层接（迁移就是一次工作区重绑）。 */
export interface SandboxOwners {
	/** 当前全部对话的 cwd（规划器自己筛哪些落在沙盒里）。 */
	facts(): readonly SandboxOwnerFact[];
	/** 把某条对话迁到目标目录（走工作区重绑原语）；失败即中止本次生命周期操作。 */
	move(conversationId: string, to: string): Promise<void>;
	/** 当前活动对话（reset/apply 之后要把它迁回沙盒）。 */
	activeId?(): string | undefined;
}

export interface SandboxHandlersOptions {
	/** 缺省 = 未接：每个 handler 调到时同步抛 `CoreEngineNotReadyError`（thunk 是防循环装配）。 */
	sandbox?: () => SandboxPort | undefined;
	/** 工作区绑定：`createSandbox` / `promoteSandbox` 末尾要把工作区切到新目录；缺省 = 该能力未接。 */
	workspace?: () => WorkspacePort | undefined;
	/** 对话迁移（reset / apply / destroy 前后把 owner 迁出沙盒）；缺省 = 不迁移（只做端口调用）。 */
	owners?: () => SandboxOwners | undefined;
	/** 当前工作目录（`path` 缺省时找沙盒用）。 */
	cwd?(): string;
}

/**
 * 沙盒的 7 个 handler：签名与 `DispatchSession` 的同名成员一致（契约里都是可选成员）。
 * 沙盒状态、与源项目的比对/写回、`sandbox_diff` 帧、notice 全归宿主端口，这里只有编排：
 * 建/升之后切工作区，reset/apply/destroy 前后把 owner 对话迁出沙盒。
 */
export interface SandboxHandlers {
	createSandbox(opts: { name?: string; sourcePath?: string; ephemeral?: boolean }): Promise<void>;
	resetSandbox(path?: string): Promise<void>;
	persistSandbox(path?: string): Promise<void>;
	promoteSandbox(targetPath: string, path?: string, switchToTarget?: boolean): Promise<void>;
	diffSandbox(path?: string, requestId?: string): Promise<void>;
	applySandboxToSource(path: string | undefined, expectedRevision: string): Promise<void>;
	destroySandbox(path: string): Promise<void>;
}

/**
 * 内核在这一域只有两处「多一步」：`createSandbox` / `promoteSandbox` 末尾的 `setCwd`（走 `WorkspacePort`，
 * 排队由 wire 层的 `workspace-queue` 负责，这里不重复实现队列），以及 reset/apply/destroy 前后的
 * owner 迁移（`planSandboxLifecycle` 只判定，执行走工作区重绑）。
 *
 * 不可逆的两个（`destroySandbox` / `applySandboxToSource`）失败可见性口径：**由宿主在实现里发
 * `notice(error)`**（老树就是 catch + error notice，用户能看到），内核既不发 Success 帧也不 catch——
 * 端口 reject 就原样冒到 wire 层，绝不返回「假装成功」。所以这里不加 try/catch。
 */
export function createSandboxHandlers(options: SandboxHandlersOptions): SandboxHandlers {
	const sandbox = (what: string): SandboxPort => {
		const port = options.sandbox?.();
		if (!port) throw new CoreEngineNotReadyError(what);
		return port;
	};
	const workspace = (what: string): WorkspacePort => {
		const port = options.workspace?.();
		if (!port) throw new CoreEngineNotReadyError(what);
		return port;
	};
	const here = (): string => options.cwd?.() ?? "";
	const target = (path?: string): string => path?.trim() || here();

	/** 生命周期共同段：先迁出 owner → 跑端口动作 → （reset/apply）把活动对话迁回沙盒。 */
	const withOwners = async (
		action: SandboxLifecycleAction,
		located: SandboxLocated | undefined,
		run: () => Promise<void>,
	): Promise<void> => {
		const owners = options.owners?.();
		if (!located || !owners) {
			await run();
			return;
		}
		const plan = planSandboxLifecycle({
			action,
			sandboxPath: located.path,
			owners: owners.facts(),
			fallbackPath: located.sourcePath?.trim() || homedir(),
		});
		for (const move of plan.moves) await owners.move(move.conversationId, move.to);
		await run();
		const back = plan.restoreTo;
		const activeId = owners.activeId?.();
		if (back && activeId && plan.moves.length > 0) await owners.move(activeId, back);
	};

	return {
		// 不用 `async` 包：端口缺失的抛错必须是**同步**的，异步体从端口解析之后才开始。
		createSandbox(opts) {
			const port = sandbox("createSandbox");
			const target2 = workspace("createSandbox.setCwd");
			// 三个可选字段显式按位转交：少传键就是行为变化（宿主按 `undefined` 走自己的缺省，`ephemeral` 缺省即 true）。
			return port
				.create({ name: opts.name, sourcePath: opts.sourcePath, ephemeral: opts.ephemeral })
				.then(async (created) => {
					// 建失败时端口已经 reject，走不到这里；宿主按老口径「发 notice 不 reject」时给空路径，
					// 同样不能拿半成品去切工作区。
					if (created.path) await target2.setCwd(created.path);
				});
		},

		resetSandbox(path?: string): Promise<void> {
			const port = sandbox("resetSandbox");
			return port.locate(target(path)).then((located) => withOwners("reset", located, () => port.reset(path)));
		},

		persistSandbox: (path) => sandbox("persistSandbox").persist(path),

		promoteSandbox(targetPath: string, path?: string, switchToTarget = true): Promise<void> {
			const port = sandbox("promoteSandbox");
			// `switchToTarget === false` 时内核不切工作区（也不解析工作区端口）：projects 帧由宿主自己推。
			const dest = switchToTarget ? workspace("promoteSandbox.setCwd") : undefined;
			return port.promote(targetPath, path, switchToTarget).then(async (promoted) => {
				// 空目标 = 导出失败（宿主已发 error notice）：不切工作区，也不假装切过去了。
				if (dest && promoted.targetPath) await dest.setCwd(promoted.targetPath);
			});
		},

		diffSandbox: (path, requestId) => sandbox("diffSandbox").diff(path, requestId),

		// 不可逆：只转交，不 catch（见工厂注释）。写回前同样要把 owner 迁出沙盒（工业口径：先解绑再动内容）。
		applySandboxToSource(path: string | undefined, expectedRevision: string): Promise<void> {
			const port = sandbox("applySandboxToSource");
			return port
				.locate(target(path))
				.then((located) => withOwners("apply", located, () => port.applyToSource(path, expectedRevision)));
		},

		destroySandbox(path: string): Promise<void> {
			const port = sandbox("destroySandbox");
			return port.locate(target(path)).then((located) => withOwners("destroy", located, () => port.destroy(path)));
		},
	};
}
