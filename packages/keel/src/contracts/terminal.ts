/**
 * 终端归属的**结论**（单源）：内核只有「每对话一份」。
 *
 * 老树是两支管理器（`ClientSession.userTerminals` + 每个 `Conversation.terminals`）：
 * 面板里用户自己开的终端进客户端级，AI 的 bash 接管进对话级，靠 `ownerKind` 区分。
 * 内核只剩一支（`domains/terminals/host.ts` 的 `managerFor(conversationId, cwd)`），于是
 * `getUserTerminalManager()` 如实返回 `undefined`，理由有两条：
 *
 * 1. **真给一个客户端级实例就是第二套归属**。内核的 `findTerminalManager` 是按对话查的，
 *    它永远找不到那支客户端级管理器；而宿主派发里 `terminal_attach` / `terminal_kill` /
 *    `rename_terminal` / native CLI 粘贴都**优先**走 `findTerminalManager`
 *    （`server/dispatch-domain-handlers.ts`）。结果就是「能建、点不动」的僵尸终端——正是
 *    「一边返回实例一边假装能用」。要让真实例成立，得先把归属（`ownerKind` 的单源）定死，
 *    那是 P4 的 `TerminalPort`，不是这里塞一个 `new TerminalManager()` 能解决的。
 * 2. **返回 `undefined` 不会丢功能**。每个调用点都有 `?? getTerminalManager(conversationId)` 兜底
 *    （`terminal_create` / `run_command`），所以用户终端落到当前对话的管理器，照样能建、能跑、
 *    能 attach、能 kill。代价是切对话后旧终端认不回来（终端跟着对话走），这是「每对话一份」
 *    的已知语义，不是这里的漏洞。
 *
 * 所以类型就是 `undefined`：想改成真实例，先改归属模型，而不是放宽这个类型。
 */
export type ClientTerminalManager = undefined;
