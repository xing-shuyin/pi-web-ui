/**
 * 工作区命令队列（唯一单源）。
 *
 * 「工作区绑定」类命令都在改同一组可变状态：`cs.cwd`、活动对话、runtime 绑定 ——
 * `set_cwd` / `new_chat` / `new_cli_chat` / `switch_session` / `switch_conversation` /
 * `fork_session` / `rollback_session` / `make_dir(setAsCwd)` / 沙盒切换。
 *
 * 每个方法内部都是异步重活（stat 目标目录、恢复最近会话、挂载 runtime、复制沙盒），而 ws 消息是一条
 * 一条派发的：上一条还在 await，下一条已经在跑。于是「先切项目再新建对话」会抢跑 —— `newChat()` 读到的
 * 还是旧 cwd，新对话落进上一个项目、在左栏里像「消失」了（#872）。
 *
 * 这里按会话实例给这些命令一条 FIFO 链：后一条等前一条落定，命令语义不变。派发层只做
 * 「同步认领 + 入队」，不改变 handlers 的同步返回值；队列空闲时入队只多一个微任务。
 *
 * 边界：`prompt` 不进这条链（它自带 targetConversationId，且是热路径）；沙盒创建这类带进度界面的
 * 长操作也按普通命令排队，只是会让后续工作区命令等到它落定。
 */
const tails = new WeakMap<object, Promise<unknown>>();

/**
 * 入队执行一条工作区命令；返回本次执行结果（与 `run` 的返回值一致）。
 * 前一条失败不会卡住后一条——各命令自己负责 emit 错误。
 */
export function runWorkspaceCommand<T>(session: object, run: () => Promise<T> | T): Promise<T> {
	const prev = tails.get(session) ?? Promise.resolve();
	const next = prev.then(run, run);
	const tail = next.then(
		() => undefined,
		() => undefined,
	);
	tails.set(session, tail);
	void tail.then(() => {
		if (tails.get(session) === tail) tails.delete(session);
	});
	return next;
}

/** 队列里是否还有在飞的工作区命令（诊断 / 测试用，不参与调度）。 */
export function workspaceCommandPending(session: object): boolean {
	return tails.has(session);
}
