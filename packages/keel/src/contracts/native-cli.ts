import type { NativeCliConfig, NativeCliStatus } from "../protocol.js";

/**
 * 一条 CLI 对话的内核账（身份 + 配置），交给宿主时必须整套带上：
 * 内核是 `conversationId` / `config` / `cwd` / `title` 的唯一所有者，宿主只按它们干活。
 */
export interface NativeCliTarget {
	conversationId: string;
	terminalId: string;
	config: NativeCliConfig;
	/** 这条对话的工作目录；远端工作区是 SSH URI（内核不解析，原样交给宿主）。 */
	cwd: string;
	/** 当前会话标题（终端标签与重连后的标题都用它，用户改名后必须是最新值）。 */
	title: string;
}

/** 新建 CLI 对话：身份与标题已由内核定好，宿主只负责把 CLI 起起来。 */
export interface NativeCliLaunch {
	conversationId: string;
	config: NativeCliConfig;
	/** 客户端请求的目录（可能相对，也可能是 SSH URI）：解析与校验都归宿主。 */
	cwd: string;
	title: string;
}

export interface NativeCliLaunched {
	/** 宿主发出的终端 id：内核把它记成归属，`controlNativeCli` / `getNativeCliConversation` 都读它。 */
	terminalId: string;
	/** 宿主解析后的真实目录（本地绝对路径或规范化后的 SSH URI）：内核用它建对话实体。 */
	cwd: string;
	/**
	 * CLI 转录文件的路径（宿主落盘的那份会话）：内核把它挂到对话实体上，于是历史列表、左栏行归属、
	 * 重启后的打开都能拿到它。缺省 = 宿主还没落转录（对话仍然成立，只是没有磁盘历史行）。
	 */
	sessionFile?: string;
}

/**
 * 原生 CLI 会话面（宿主能力）。
 *
 * CLI 是**外部程序**：进程、PTY、hook 观察、远程文件暂存、会话文件落盘、状态机（`phase` / `activity` /
 * `sessionId` / `exitCode`）全在宿主叶子里 —— `server/terminals.ts`（`TerminalManager`）、
 * `server/native-cli-session.ts`（`prepareNativeCliSessionLaunch`，682 行）、`server/native-cli-remote-files.ts`、
 * `server/remote-cli-persistence.ts`。内核**不** spawn、不解析终端输出、不认识 hook 事件；它只记得
 * 「哪条对话是 CLI、配置是什么、终端 id 是多少」这一条账，并按这份账回答与转发。
 *
 * 宿主侧适配器：`server/core-native-cli-adapter.ts`（结构直通：三个动作落到 `TerminalManager` 的
 * `detachNativeCli` / `stopNativeCli`，其余交宿主自己的 CLI 运行时候补）。
 *
 * 签名与 `server/agent-service.ts` 的 `newCliChat` / `controlNativeCli` / `getNativeCliConversation` /
 * `updateNativeCliTitleFromInput` 逐字对齐；会话名（`title`）的语意在 `domains/native-cli/title.ts` 单源，
 * 宿主实现必须吃内核给的标题，不许自己再判一遍「是不是默认名」。
 */
export interface NativeCliPort {
	/**
	 * 起一个 CLI 会话并把它绑到内核给的 `conversationId` 上。宿主负责：解析/校验目录（本地 stat、SSH URI、
	 * keep-alive 只许远端）、**先丢掉客户端塞的 `model` 再按设置与当前对话决定继承**（老口径：客户端给的模型
	 * 一律不信任）、建 PTY、装 hook 观察、把事件与状态接到这条对话、
	 * 落盘会话文件（`appendCustomEntry` + `appendSessionInfo`）、发自己的帧（`terminal_list`、历史重扫）。
	 * 出帧：宿主。失败：**reject 原样冒泡**（宿主自己回滚已起的半套进程与文件），内核据此发 error notice 并回 `false`。
	 */
	launch(input: NativeCliLaunch): Promise<NativeCliLaunched>;

	/**
	 * 这条 CLI 的实时状态投影（`NativeCliStatus`：phase / activity / sessionId / resumable / exitCode…）。
	 * 状态机归宿主（事件驱动），内核只把它塞进 `NativeCliConversation` 如实转给前端。
	 */
	statusOf(target: NativeCliTarget): NativeCliStatus | undefined;

	/**
	 * 只断开观察（远端 keep-alive 的 PTY 保持存活，`phase: "disconnected"`）。
	 * 出帧：宿主（`terminal_exit` + `terminal_list` + 状态）。失败：抛（不是 keep-alive 的 CLI 会明说停不了）。
	 */
	detach(target: NativeCliTarget): void;

	/**
	 * 重连：用同一个 `conversationId` / 终端 id 再起一次 CLI（远端 attach 持久实例、本地重起进程都在宿主）。
	 * 出帧：宿主。失败：reject 冒泡（内核不假装已连上）。
	 */
	reconnect(target: NativeCliTarget): Promise<void>;

	/**
	 * 真停：`keepAlive` 且 PTY 已断开时先确认远端持久实例（tmux）确实终止，再停终端。
	 * 出帧：宿主。失败：reject 冒泡 —— 「停不掉」必须让用户看见，不能静默成功。
	 */
	stop(target: NativeCliTarget): Promise<void>;

	/**
	 * 标题落盘：`appendSessionInfo` + SDK `setSessionName` + 失效历史缓存 + 重扫会话列表。
	 * 内核已经改了自己的对话聚合根（`Conversation.rename`），这里只补宿主那边的一份。
	 * 出帧：宿主（历史列表）。失败：宿主按老实现做到尽力而为（写不进去不影响用户继续输入）。
	 */
	applyTitle(target: NativeCliTarget): void;
}
