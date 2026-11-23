import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { WorkspacePort } from "../../contracts/files.js";
import type { SandboxPort } from "../../contracts/sandbox.js";

export interface SandboxHandlersOptions {
	/** 缺省 = 未接：每个 handler 调到时同步抛 `CoreEngineNotReadyError`（thunk 是防循环装配）。 */
	sandbox?: () => SandboxPort | undefined;
	/** 工作区绑定：`createSandbox` / `promoteSandbox` 末尾要把工作区切到新目录；缺省 = 该能力未接。 */
	workspace?: () => WorkspacePort | undefined;
}

/**
 * 沙盒的 7 个 handler：签名与 `DispatchSession` 的同名成员一致（契约里都是可选成员）。
 * 沙盒状态、与源项目的比对/写回、`sandbox_diff` 帧、notice 全归宿主端口，这里只有按位转交 + 切工作区。
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
 * 排队由 wire 层的 `workspace-queue` 负责，这里不重复实现队列）。
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

	return {
		// 不用 `async` 包：端口缺失的抛错必须是**同步**的，异步体从端口解析之后才开始。
		createSandbox(opts) {
			const port = sandbox("createSandbox");
			const target = workspace("createSandbox.setCwd");
			// 三个可选字段显式按位转交：少传键就是行为变化（宿主按 `undefined` 走自己的缺省，`ephemeral` 缺省即 true）。
			return port
				.create({ name: opts.name, sourcePath: opts.sourcePath, ephemeral: opts.ephemeral })
				.then(async (created) => {
					// 建失败时端口已经 reject，走不到这里——不拿半成品去切工作区。
					await target.setCwd(created.path);
				});
		},

		resetSandbox: (path) => sandbox("resetSandbox").reset(path),
		persistSandbox: (path) => sandbox("persistSandbox").persist(path),

		promoteSandbox(targetPath: string, path?: string, switchToTarget = true): Promise<void> {
			const port = sandbox("promoteSandbox");
			// `switchToTarget === false` 时内核不切工作区（也不解析工作区端口）：projects 帧由宿主自己推。
			const target = switchToTarget ? workspace("promoteSandbox.setCwd") : undefined;
			return port.promote(targetPath, path, switchToTarget).then(async (promoted) => {
				if (target) await target.setCwd(promoted.targetPath);
			});
		},

		diffSandbox: (path, requestId) => sandbox("diffSandbox").diff(path, requestId),

		// 不可逆：只转交，不 catch（见工厂注释）。
		applySandboxToSource: (path, expectedRevision) =>
			sandbox("applySandboxToSource").applyToSource(path, expectedRevision),
		destroySandbox: (path) => sandbox("destroySandbox").destroy(path),
	};
}
