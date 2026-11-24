/**
 * 建沙盒的返回值：内核只取 `path`（切工作区用），名字/拷贝计数等留给宿主自己发 notice。
 */
export interface SandboxCreated {
	/**
	 * 新沙盒目录的绝对路径（宿主已展开 `~`、归一化过），内核原样交给 `WorkspacePort.setCwd`。
	 * **空串 = 建失败**（宿主已按老口径发 `notice(error)`）：内核不切工作区、不假装成功。
	 */
	path: string;
}

/**
 * 导出沙盒的返回值：`targetPath` 是宿主展开 `~` / 相对路径后定下的**目标绝对路径**。
 * `switchToTarget === false` 时内核不切工作区（宿主的 projects 帧自己推），这个路径就用不上。
 */
export interface SandboxPromoted {
	/** 导出成功后的正式项目绝对路径；**空串 = 导出失败**（宿主已发 `notice(error)`），内核不切工作区。 */
	targetPath: string;
}

/** 沙盒实况（内核规划「先把 owner 对话迁出沙盒」要用）：真实目录 + 源项目。 */
export interface SandboxLocated {
	id: string;
	/** 沙盒真实目录（绝对路径）。 */
	path: string;
	name: string;
	/** 建沙盒时的源项目（迁出时的回退位置）；空白沙盒没有。 */
	sourcePath?: string;
}

/**
 * 沙盒面（宿主能力）：7 个方法逐字对齐老树 `agent-service` 的同名方法。
 *
 * 实现就在宿主现成的 `SandboxManager`（`server/sandbox-data.ts`：注册表、baseline、copy/tree、
 * diff、applyToSource 全在里面）之上，再补上老方法里那圈周边动作（项目缓存失效、projects 帧、
 * 快照 flush、`sandbox_diff` 帧、notice）。宿主侧适配器：`server/core-sandbox-adapter.ts`。
 *
 * 分工：**沙盒状态、与源项目的比对外加写回全部归宿主**，内核不许重写（尤其不许自己算 diff、
 * 不许自己搬文件、不许自己拼 `sandbox_diff` 帧）。内核只做一件跨域的事——切工作区：
 * `create` / `promote` 把「该切到哪」用返回值告诉内核，由内核调 `WorkspacePort.setCwd`
 * （见 `contracts/files.ts`）；`reset` / `destroy` / `applyToSource` 里把 owner 会话迁出沙盒
 * 那套协调（`coordinateSandboxLifecycle`）是宿主自己的事，内核不展开步骤。
 *
 * 失败口径：宿主在自己的实现里发 `notice(error)`（老树逐字同口径）；端口 reject 表示「连兜底帧都发不出去」，
 * 内核不 catch、不重试，错误照原样冒到 wire 层。
 */
export interface SandboxPort {
	/**
	 * 查沙盒实况（缺省按当前 cwd 找）。不在注册表里返回 `undefined`——`destroy` 老口径
	 * （目标不是沙盒时只清项目缓存 + 推 projects 帧，不算失败）靠这个判定。
	 */
	locate(path?: string): Promise<SandboxLocated | undefined>;
	/** 建沙盒（可带源项目做初始拷贝），返回新沙盒的绝对路径供内核切工作区。 */
	create(opts: { name?: string; sourcePath?: string; ephemeral?: boolean }): Promise<SandboxCreated>;
	/** 重置沙盒（有源项目就重新同步一次）。`path` 缺省 = 宿主按当前 cwd 找沙盒。 */
	reset(path?: string): Promise<void>;
	/** 把临时沙盒改成永久保留。 */
	persist(path?: string): Promise<void>;
	/**
	 * 把沙盒内容导出为正式项目，返回解析后的目标绝对路径。
	 * `switchToTarget === false` 时宿主只推 projects 帧、不切工作区（内核据此决定要不要 `setCwd`）。
	 */
	promote(targetPath: string, path?: string, switchToTarget?: boolean): Promise<SandboxPromoted>;
	/** 与源项目比对并发 `sandbox_diff` 帧（成功/失败两种帧都由宿主出，`requestId` 原样带回）。 */
	diff(path?: string, requestId?: string): Promise<void>;
	/**
	 * 把沙盒改动写回源项目：**不可逆**，`expectedRevision` 是预览时算出的版本号，宿主必须校验后才写。
	 * 失败时宿主发 `notice(error)`（含 revision 过期 / 文件冲突），内核不吞。
	 */
	applyToSource(path: string | undefined, expectedRevision: string): Promise<void>;
	/**
	 * 销毁沙盒并清理隔离目录：**不可逆**。
	 * 目标不在注册表里时宿主按老口径只清项目缓存 + 推 projects 帧（不算失败）。
	 */
	destroy(path: string): Promise<void>;
}
