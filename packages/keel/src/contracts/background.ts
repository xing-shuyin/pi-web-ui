/**
 * 后台任务面（宿主能力）。
 *
 * 面板上「后台任务」里其实是三类行：端口行（`BgServerTracker` 靠端口 diff 认出来的 AI 起服务）、
 * bash background 的 job 行（`JobRegistry` 显式登记，不监听端口也能看见）、插件常驻任务行。
 * 实现就是宿主现成的 `server/bg-servers.ts`（`BgServerTracker`）+ `server/job-runner.ts`（`JobRegistry`），
 * 两者已经由 `AgentService` 装配成一份能出帧的状态（`this.bg` / `this.jobs` / `pluginStopBgTask`）。
 * 宿主侧适配器：`server/core-background-adapter.ts`（接线时新增）。
 *
 * 内核在这里**没有**任何编排可做：进程树 kill、硬超时、日志落盘、端口 diff / 复核、
 * `job:` 前缀解析、清理阈值（设置项 + 兜底分钟数）全归宿主。内核不 spawn、不 kill、不重写。
 *
 * 出帧口径（8 支一致）：**帧与 notice 全由宿主发** —— `bg_servers` 帧由 `push()` 出、每条 notice 都
 * 绑着宿主才知道的原因（端口不在列表 / pid 已换 / 停不掉 / 脚本名不合法 / 没有活跃 bash…）、
 * 快照也由宿主自己 flush。内核不补帧、不改文案：在内核里重写一遍就是第二套语义。
 *
 * 失败口径：**端口 reject 就原样冒泡**，内核不 catch、不返回「假装成功」。唯一老实现里被吞掉的
 * 是 `abortBash` 内部「投递系统提示」那一段 `catch {}`——那一段仍在宿主实现里，不在端口契约外面。
 */
export interface BackgroundPort {
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

	/**
	 * 停掉某条对话当前正在跑的 bash 命令（对话继续），并给该会话补一句「用户手动停止了命令」。
	 *
	 * 整条链都在宿主里，因为内核拿不到也没资格碰这些状态：按 `conversationId ?? 当前活跃对话`
	 * 解析对话 → 取该对话的 bash kill 句柄集合 → 逐个 abort → **没有活跃命令时发 info notice**
	 * （「当前没有正在运行的 bash 命令」，不是错）→ 走唯一喂轮出口投递系统提示（子代理工作树准入
	 * 检查也在那一步）→ flush 快照。老实现只吞「投递系统提示」这一段异常，其余照常。
	 * 出帧：宿主（info notice 两分支 / 快照）。失败：投递失败在宿主内部吞掉；端口 reject 则冒泡。
	 */
	abortBash(conversationId?: string): Promise<void>;
}
