/**
 * Background-server tracking — 从 agent-service.ts 抽出。
 *
 * bash 工具执行前后各拍一次监听端口快照，diff 出 AI 启动的后台服务记入列表；
 * 列表按客户端持久（对话切换/断线重连不消失），只有任务被停或进程自行退出才移除。
 * 本模块自包含：只依赖 process-utils 与协议类型，经回调与 ClientSession 解耦
 * （emit 推消息 / flushSnapshot 立即刷快照 / isDisposed 停止后台刷新）。
 */
import type { ServerMessage, BgServer } from "./protocol.js";
import {
	killPidTree,
	lookupProcessName,
	lookupProcessCommandLine,
	snapshotListeningPorts,
} from "./process-utils.js";

const BG_REFRESH_INTERVAL_MS = 30_000;
/** bash 结束后等这么久再拍「后」快照——给后台服务绑定端口的时间。 */
const BG_BIND_WAIT_MS = 1500;

export class BgServerTracker {
	private readonly servers = new Map<
		number,
		{ pid: number; since: number; name?: string; command?: string }
	>();
	/** bash 工具开始执行前拍的监听端口快照（tool_execution_start 时设置）。 */
	private listenBefore: Map<number, number> | null = null;
	private refreshTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly opts: {
			emit: (msg: ServerMessage) => void;
			flushSnapshot: () => void;
			isDisposed: () => boolean;
			/** 插件注册的常驻任务（host.registerBackgroundTask）→ 追加进同一列表。 */
			pluginTasks?: () => BgServer[];
		},
	) {}

	/** 启动周期性存活检查（死项静默剔除）。 */
	start(): void {
		this.refreshTimer = setInterval(() => void this.refresh(), BG_REFRESH_INTERVAL_MS);
		this.refreshTimer.unref?.();
	}

	stop(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	/** tool_execution_start(bash)：先记下「前」快照。 */
	snapshotBefore(): void {
		void snapshotListeningPorts().then((m) => {
			this.listenBefore = m;
		});
	}

	/** After a bash tool run, wait briefly for background servers to bind,
	 *  then diff the listening-port snapshot against the pre-run one and
	 *  remember anything new — those are servers the agent left running. */
	async trackAfterBash(): Promise<void> {
		const before = this.listenBefore;
		this.listenBefore = null;
		if (!before) return;
		await new Promise((r) => setTimeout(r, BG_BIND_WAIT_MS));
		const after = await snapshotListeningPorts();
		let added = false;
		for (const [port, pid] of after) {
			if (!before.has(port) && !this.servers.has(port)) {
				this.servers.set(port, { pid, since: Date.now() });
				added = true;
				// Best-effort process name + full command line so the panel shows
				// something readable (name) AND what is actually running (command).
				void lookupProcessName(pid).then((name) => {
					const cur = this.servers.get(port);
					if (cur && cur.pid === pid && name) {
						cur.name = name;
						this.push();
					}
				});
				void lookupProcessCommandLine(pid).then((command) => {
					const cur = this.servers.get(port);
					if (cur && cur.pid === pid && command) {
						cur.command = command;
						this.push();
					}
				});
				this.opts.emit({
					type: "notice",
					level: "info",
					text: `检测到 AI 启动的后台服务：端口 ${port}（pid ${pid}）——可在顶栏「后台任务」里单独停止或全部关闭`,
					textEn: `Detected an AI-started background service: port ${port} (pid ${pid}) — stop it individually or all at once under Background tasks in the top bar`,
				});
			}
		}
		if (added) this.push();
	}

	/** The current background-server list, oldest first. 合并插件任务。 */
	list(): BgServer[] {
		const out: BgServer[] = [...this.servers.entries()]
			.map(([port, v]) => ({
				port,
				pid: v.pid,
				since: v.since,
				...(v.name ? { name: v.name } : {}),
				...(v.command ? { command: v.command } : {}),
			}))
			.sort((a, b) => a.since - b.since);
		for (const t of this.opts.pluginTasks?.() ?? []) out.push(t);
		return out;
	}

	/** Push the current background-task list to every connected socket. */
	push(): void {
		this.opts.emit({ type: "bg_servers", servers: this.list() });
	}

	/** Re-snapshot listening ports and drop tracked entries that are no longer
	 *  listening — the process exited on its own, so it must leave the panel.
	 *  Port AND pid must both match: a port reused by an unrelated process is
	 *  not our server anymore. Silent (the list just updates). */
	async refresh(): Promise<void> {
		if (this.opts.isDisposed() || this.servers.size === 0) return;
		const now = await snapshotListeningPorts();
		let changed = false;
		for (const [port, v] of [...this.servers]) {
			if (now.get(port) !== v.pid) {
				this.servers.delete(port);
				changed = true;
			}
		}
		if (changed) this.push();
	}

	/** Re-push the current list on request (panel opened); prunes dead entries first. */
	async listAndPush(): Promise<void> {
		await this.refresh();
		this.push();
	}

	/** Kill ONE background server (by port); returns whether anything was killed. */
	async killOne(port: number): Promise<boolean> {
		const entry = this.servers.get(port);
		if (!entry) {
			this.opts.emit({
				type: "notice",
				level: "info",
				text: `端口 ${port} 不在后台任务列表中`,
				textEn: `Port ${port} is not in the background task list`,
			});
			this.opts.flushSnapshot();
			return false;
		}
		killPidTree(entry.pid);
		this.servers.delete(port);
		this.push();
		this.opts.emit({
			type: "notice",
			level: "info",
			text: `已停止后台任务：端口 ${port}（pid ${entry.pid}）`,
			textEn: `Stopped background task: port ${port} (pid ${entry.pid})`,
		});
		this.opts.flushSnapshot();
		return true;
	}

	/** Kill every background server the agent started; returns the freed ports. */
	async killAll(): Promise<string[]> {
		if (this.servers.size === 0) return [];
		const killed: string[] = [];
		for (const [port, { pid }] of [...this.servers]) {
			killPidTree(pid);
			killed.push(String(port));
		}
		this.servers.clear();
		this.push();
		return killed;
	}
}
