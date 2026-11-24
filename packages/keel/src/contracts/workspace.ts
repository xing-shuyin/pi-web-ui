/**
 * 工作区目标解析面（宿主能力）。
 *
 * 内核已经负责整条重绑链（释放旧会话 → 在新 cwd 建会话 → 重算快照/推帧 → 失败回滚，
 * 见 `domains/sessions/rebind.ts`），这里只剩下宿主才认得出的两件事：
 *
 * 1. `resolveTarget`：`~` 展开、相对路径基准、远程工作区 URI（`ssh://` 之类）、
 *    「此电脑」这类伪路径，以及远程工作区的 SDK 会话目录跟 cwd 不在一处；
 * 2. `onChanged`：工作区真的换过去之后的宿主收尾（git 监听、工作树信息、终端面板、项目缓存）。
 *
 * 宿主侧适配器：`server/core-workspace-adapter.ts`。
 */
export interface WorkspaceTarget {
	/** 新的工作目录（远程工作区是 URI，与会话目录分离）。 */
	cwd: string;
	/** SDK 会话落在哪个目录（远程工作区是本地镜像目录）；缺省 = `cwd`。 */
	sessionCwd?: string;
}

export interface WorkspaceHostPort {
	/** 解析并校验目标；reject 的消息会原样发给用户（`切换工作目录失败：…`）。 */
	resolveTarget(input: string, from: string): Promise<WorkspaceTarget>;
	/** 工作区换过去之后（换 cwd / 换额外根）的宿主收尾。内核不 catch：收尾失败也不撤重绑。 */
	onChanged?(cwd: string, roots: readonly string[]): void | Promise<void>;
}
