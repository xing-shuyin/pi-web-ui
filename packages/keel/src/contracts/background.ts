/**
 * 后台任务面（宿主能力）。
 *
 * 面板上「后台任务」里其实是三类行：端口行（`BgServerTracker` 靠端口 diff 认出来的 AI 起服务）、
 * bash background 的 job 行（`JobRegistry` 显式登记，不监听端口也能看见）、插件常驻任务行（`pluginTasks`）。
 * 实现就是宿主现成的 `server/bg-servers.ts`（`BgServerTracker`）+ `server/job-runner.ts`（`JobRegistry`），
 * 两者已经由 `AgentService` 装配成一份能出帧的状态（`this.bg` / `this.jobs` / `pluginStopBgTask`）。
 * 宿主侧适配器：`server/core-background-adapter.ts`（接线时新增）。
 *
 * 内核在这里**没有**任何编排可做：进程树 kill、硬超时、日志落盘、端口 diff / 复核、
 * `job:` 前缀解析、清理阈值（设置项 + 兜底分钟数）全归宿主。内核不 spawn、不 kill、不重写。
 *
 * 出帧口径（7 支一致）：**帧与 notice 全由宿主发** —— `bg_servers` 帧由 `push()` 出、每条 notice 都
 * 绑着宿主才知道的原因（端口不在列表 / pid 已换 / 停不掉 / 脚本名不合法 / 清理失败…）、
 * 快照也由宿主自己 flush。内核不补帧、不改文案：在内核里重写一遍就是第二套语义。
 *
 * 失败口径：**端口 reject 就原样冒泡**，内核不 catch、不返回「假装成功」。
 *
 * `abortBash` **不在**这个端口上：老实现靠 `ClientSession.bashKills` 按对话登记 `AbortController`，
 * 而新树的 bash 走 SDK `createBashToolDefinition`（`adapters/tools/guarded.ts`）——句柄就在内核手里，
 * 所以那张表（`BashAbortRegistry`）与「中止 + 出回执」的编排也归内核，宿主没有任何可做的事。
 */
export interface BackgroundJobInfo {
	id: string;
	pid: number;
	command: string;
	label: string;
	cwd: string;
	origin?: string;
	since: number;
	logPath: string;
	state: "running" | "exited";
	exitCode: number | null;
	reason?: string;
	head?: string;
}

export interface BackgroundJobStartSpec {
	command: string;
	cwd: string;
	label?: string;
	timeoutSec?: number;
	notificationTimeoutSec?: number;
	origin?: string;
}

export interface BackgroundJobWaitResult {
	completed: boolean;
	job: BackgroundJobInfo;
	output: string;
}

export interface BackgroundPort {
	/**
	 * 插件常驻任务变了：只重投影一帧 `bg_servers`（**不**重扫端口）。老实现 `refreshBgTasks()` = `bg.push()`。
	 * 与 `listBgServers()` 的区别是真实的：后者要扫监听端口（`snapshotListeningPorts` = 子进程），
	 * 插件任务变动却只是内存里的行变了——不为此扫一遍端口。
	 * 出帧：宿主（`bg_servers`）。失败：不抛。
	 */
	refreshBgTasks(): void;

	/**
	 * 重算端口行（进程没了就摘掉）并下发一帧 `bg_servers`。老实现 `bg.listAndPush()`。
	 * 出帧：宿主（`bg_servers`）。失败：端口 reject 则冒泡（老实现不抛）。
	 */
	listBgServers(): Promise<void>;

	/**
	 * 停一个后台行，三条分支都在宿主里（顺序即老实现的判定顺序）：
	 * `taskId` 带 `job:` 前缀 → `jobs.killAndWait` + 「不存在/超时」notice + 2s 后补一帧；
	 * 其它 `taskId` → 插件常驻任务的 stop 回调；只有 `port` → `bg.killOne(port)`（杀前复核 pid）。
	 * 返回值 = 真的停了（`false` 时宿主已经发过解释性 notice，调用方不看这个值）。
	 * 出帧：宿主（notice / `bg_servers` / 快照）。失败：查不到或停不掉都**不 reject**，走 `false` + notice。
	 */
	killBackgroundServer(port: number | undefined, taskId?: string): Promise<boolean>;

	/**
	 * 「全部关闭」：端口行 + job 行一起收（插件常驻任务不在内）。返回被停的标识，
	 * 端口行是 `"3000"`、job 行是 `"job:<id>"`。老实现 `bg.killAll()`。
	 * 出帧：宿主（`bg_servers` + 停不掉的端口走 error notice）。失败：不 reject。
	 */
	killAllBackgroundServers(): Promise<string[]>;

	/**
	 * 跑一个 `package.json` 脚本（老实现 = 校验脚本名 → `resolveProjectScripts` → `jobs.start`）。
	 * `cwd` 缺省时宿主自己退到「当前对话的 cwd → 进程 cwd」。脚本名不合法 / 没有这个脚本 / 起不来
	 * 都是 warning notice，因此**同步返回 void、不抛**。
	 * 出帧：宿主（notice / `bg_servers` / 快照）。
	 */
	startBgScript(script: string, cwd?: string): void;

	/**
	 * 重启一个 `job:` 行：取 snapshot → `jobs.kill` → 用同样的 command/cwd/label 重起。
	 * 不存在或已结束是 info notice，起不来是 warning notice。同步返回 void、不抛。
	 * 出帧：宿主（notice / `bg_servers` / 快照）。
	 */
	restartBgJob(taskId: string): void;

	/**
	 * 钉住/取消钉住端口行（钉住的不会被自动清理），返回是否真的改到了（端口不在列表 → `false` + notice）。
	 * 出帧：宿主（`bg_servers`，`false` 时另有 notice）。失败：不抛。
	 */
	setBackgroundKeep(port: number, keep: boolean): boolean;

	/**
	 * 清理闲置遗留实例，返回被清掉的端口。阈值解析归宿主：`minutesOverride` > 设置项
	 * `bgAutoCleanupMin` > 兜底分钟数。手动清理才发「没有可清理的」/「清理失败」notice。
	 * 出帧：宿主（notice / `bg_servers` / 快照）。失败：单个实例停不掉走 notice，不 reject。
	 */
	cleanBackgroundLeftovers(minutesOverride?: number): Promise<number[]>;

	/** 启动一个后台任务并等待首屏输出。 */
	startJob?(spec: BackgroundJobStartSpec): Promise<BackgroundJobInfo>;

	/** 先前台等待 `waitMs`，若未结束则无缝转为后台任务返回。 */
	runJobWithWait?(
		spec: BackgroundJobStartSpec & { waitMs: number; signal?: AbortSignal },
	): Promise<BackgroundJobWaitResult>;

	/** 列出运行中的后台任务。 */
	listJobs?(): BackgroundJobInfo[];

	/** 查询单个后台任务状态与日志尾部。 */
	getJobStatus?(
		id: string,
		tailLines?: number,
	): { ok: boolean; job?: BackgroundJobInfo; tail?: string; error?: string };

	/** 终止后台任务并等待退出。 */
	killJob?(id: string): Promise<{ ok: boolean; timedOut?: boolean }>;
}

/**
 * 一次 bash 执行在中止表里的句柄。
 *
 * `signal` 由工具层合成进 SDK 的 `execute`（`AbortSignal.any([上游 signal, 这条])`）：
 * SDK 的 bash 在 signal abort 时会 `killProcessTree`，所以「登记 → abort」就等于真杀掉整棵进程树。
 */
export interface BashAbortHandle {
	readonly signal: AbortSignal;
	/** 执行结束必须调用一次（漏调 = 表里留一条死句柄，`abortBash` 会误报「还有命令在跑」）。 */
	release(): void;
}

/**
 * 对话级 bash 中止表（内核实现：`domains/background/bash-kills.ts`）。
 *
 * 工具侧只认这两个成员：执行开始时 `register`、结束时 `release()`；表本身按对话分桶，
 * 多对话并发时互不误杀。没有对话身份（`conversationId` 为空）就返回 `undefined` —— 不登记，不猜主人。
 */
export interface BashAbortRegistry {
	register(conversationId: string | undefined): BashAbortHandle | undefined;
}
