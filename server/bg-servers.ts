import type { ServerMessage, BgServer } from "./protocol.js";
import {
	killPidTree,
	lookupProcessDetailsBatch,
	snapshotListeningPorts,
	snapshotProcessTree,
	type ProcessTreeNode,
} from "./process-utils.js";

const BG_REFRESH_INTERVAL_MS = 30_000;
const BG_BIND_WAIT_MS = 1500;

export const BG_CLEANUP_FALLBACK_MIN = 30;

export function staleLeftovers(
	entries: ReadonlyArray<{ port: number; pid: number; since: number; keep?: boolean }>,
	opts: { now: number; thresholdMs: number },
): Array<{ port: number; pid: number; since: number; keep?: boolean }> {
	if (!Number.isFinite(opts.thresholdMs) || opts.thresholdMs <= 0) return [];
	return entries.filter((e) => !e.keep && Number.isFinite(e.since) && opts.now - e.since >= opts.thresholdMs);
}

export const NON_AGENT_PROCESS_NAMES = new Set([
	"wps.exe",
	"wpscenter.exe",
	"ksoqing.exe",
	"ksolaunch.exe",
	"wpscloudsvr.exe",
	"ima.copilot.exe",
	"ima.exe",
	"wechat.exe",
	"weixin.exe",
	"wechatappex.exe",
	"qq.exe",
	"tim.exe",
	"telegram.exe",
	"dingtalk.exe",
	"explorer.exe",
	"searchhost.exe",
	"searchapp.exe",
	"svchost.exe",
	"winlogon.exe",
	"dwm.exe",
	"csrss.exe",
	"conhost.exe",
	"sihost.exe",
	"taskhostw.exe",
	"services.exe",
	"shellexperiencehost.exe",
	"startmenuexperiencehost.exe",
]);

export const SHELL_OR_SYSTEM_PROCESS_NAMES = new Set([
	"explorer.exe",
	"winlogon.exe",
	"services.exe",
	"dwm.exe",
	"taskhostw.exe",
	"sihost.exe",
	"svchost.exe",
	"shellexperiencehost.exe",
	"startmenuexperiencehost.exe",
	"system",
]);

export const DEV_RUNTIME_PROCESS_NAMES = new Set([
	"node.exe",
	"node",
	"python.exe",
	"python",
	"python3.exe",
	"python3",
	"deno.exe",
	"deno",
	"bun.exe",
	"bun",
	"ruby.exe",
	"ruby",
	"go.exe",
	"go",
	"java.exe",
	"java",
	"dotnet.exe",
	"dotnet",
	"php.exe",
	"php",
	"cargo.exe",
	"cargo",
	"uvicorn.exe",
	"uvicorn",
	"gunicorn",
	"vite.exe",
	"vite",
	"flask.exe",
	"flask",
]);

export interface BackgroundServerFilterOptions {
	commandLine?: string;
	createdMs?: number;
	startedBeforeMs?: number;
	workspaceCwd?: string;
}

export function shouldTrackBackgroundServer(
	pid: number,
	parents: ReadonlyMap<number, number | ProcessTreeNode> | undefined,
	newPids: ReadonlySet<number>,
	serverPid: number,
	name?: string,
	opts?: BackgroundServerFilterOptions,
): boolean {
	const lowerName = name?.toLowerCase();

	if (lowerName && NON_AGENT_PROCESS_NAMES.has(lowerName)) return false;

	if (
		typeof opts?.startedBeforeMs === "number" &&
		opts.startedBeforeMs > 0 &&
		typeof opts.createdMs === "number" &&
		opts.createdMs > 0
	) {
		if (opts.createdMs < opts.startedBeforeMs - 2000) {
			return false;
		}
	}

	if (opts?.commandLine) {
		const lowerCmd = opts.commandLine.toLowerCase();
		const isDevRuntime = lowerName ? DEV_RUNTIME_PROCESS_NAMES.has(lowerName) : false;
		if (!isDevRuntime) {
			const isDesktopPath =
				lowerCmd.includes("\\program files") ||
				lowerCmd.includes("/program files") ||
				lowerCmd.includes("\\appdata\\local\\programs\\") ||
				lowerCmd.includes("/appdata/local/programs/");
			if (isDesktopPath) {
				return false;
			}
		}
	}

	if (!parents) {
		return true;
	}

	const seen = new Set<number>();
	let cur: number | undefined = pid;
	let brokenAt: number | undefined;

	while (cur !== undefined && !seen.has(cur)) {
		seen.add(cur);
		if (cur === serverPid) return true;
		if (cur !== pid && newPids.has(cur)) return true;

		const parentEntry = parents.get(cur);
		let next: number | undefined;
		let parentName: string | undefined;

		if (typeof parentEntry === "object" && parentEntry !== null) {
			next = parentEntry.ppid;
			parentName = parentEntry.name;
		} else if (typeof parentEntry === "number") {
			next = parentEntry;
		}

		if (parentName) {
			const lowerParent = parentName.toLowerCase();
			if (SHELL_OR_SYSTEM_PROCESS_NAMES.has(lowerParent) || NON_AGENT_PROCESS_NAMES.has(lowerParent)) {
				return false;
			}
		}

		if (next === undefined) {
			if (cur <= 1) return false;
			brokenAt = cur;
			break;
		}

		if (next === cur) {
			return false;
		}

		cur = next;
	}

	if (brokenAt !== undefined) {
		if (!opts && !name) {
			return true;
		}
		if (lowerName && DEV_RUNTIME_PROCESS_NAMES.has(lowerName)) {
			return true;
		}
		if (opts?.workspaceCwd && opts.commandLine) {
			const normalizedCwd = opts.workspaceCwd.toLowerCase().replace(/\\/g, "/");
			const normalizedCmd = opts.commandLine.toLowerCase().replace(/\\/g, "/");
			if (normalizedCmd.includes(normalizedCwd)) {
				return true;
			}
		}
		return false;
	}

	return false;
}

export class BgServerTracker {
	private readonly servers = new Map<
		number,
		{ pid: number; since: number; name?: string; command?: string; keep?: boolean }
	>();
	private listenBefore: Promise<Map<number, number>> | null = null;
	private listenBeforeTime: number = 0;
	private refreshTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly opts: {
			emit: (msg: ServerMessage) => void;
			flushSnapshot: () => void;
			isDisposed: () => boolean;
			pluginTasks?: () => BgServer[];
			cleanupMinutes?: () => number;
			workspaceCwd?: () => string | undefined;
		},
	) {}

	start(): void {
		this.refreshTimer = setInterval(() => void this.tick(), BG_REFRESH_INTERVAL_MS);
		this.refreshTimer.unref?.();
	}

	private async tick(): Promise<void> {
		await this.refresh();
		const minutes = Number(this.opts.cleanupMinutes?.() ?? 0);
		if (!Number.isFinite(minutes) || minutes <= 0) return;
		await this.cleanStale(minutes * 60_000, { manual: false });
	}

	stop(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	snapshotBefore(): void {
		if (!this.listenBefore) {
			this.listenBeforeTime = Date.now();
			this.listenBefore = snapshotListeningPorts();
		}
	}

	async trackAfterBash(): Promise<void> {
		const beforePromise = this.listenBefore;
		const beforeTime = this.listenBeforeTime;
		this.listenBefore = null;
		this.listenBeforeTime = 0;
		if (!beforePromise) return;
		const before = await beforePromise;
		await new Promise((r) => setTimeout(r, BG_BIND_WAIT_MS));
		const after = await snapshotListeningPorts();
		const fresh: Array<{ port: number; pid: number }> = [];
		for (const [port, pid] of after) {
			if (!before.has(port) && !this.servers.has(port)) {
				fresh.push({ port, pid });
			}
		}
		if (fresh.length === 0) return;
		const keep = await this.filterAgentSpawned(fresh, beforeTime);
		let added = false;
		for (const { port, pid, name, command } of keep) {
			if (this.servers.has(port)) continue;
			this.servers.set(port, {
				pid,
				since: Date.now(),
				...(name ? { name } : {}),
				...(command ? { command } : {}),
			});
			added = true;
			this.opts.emit({
				type: "notice",
				level: "info",
				text: `检测到 AI 启动的后台服务：端口 ${port}（pid ${pid}）——可在顶栏「后台任务」里单独停止或全部关闭`,
				textEn: `Detected an AI-started background service: port ${port} (pid ${pid}) — stop it individually or all at once under Background tasks in the top bar`,
			});
		}
		if (added) this.push();
	}

	private async filterAgentSpawned(
		fresh: Array<{ port: number; pid: number }>,
		beforeTime: number,
	): Promise<Array<{ port: number; pid: number; name?: string; command?: string }>> {
		const pids = [...new Set(fresh.map((f) => f.pid))];
		const [tree, detailsMap] = await Promise.all([snapshotProcessTree(), lookupProcessDetailsBatch(pids)]);
		const newPids = new Set(pids);
		const cwd = this.opts.workspaceCwd?.();
		const out: Array<{ port: number; pid: number; name?: string; command?: string }> = [];

		for (const { port, pid } of fresh) {
			const details = detailsMap.get(pid);
			const name = details?.name;
			const command = details?.commandLine;
			const should = shouldTrackBackgroundServer(pid, tree, newPids, process.pid, name, {
				commandLine: command,
				createdMs: details?.createdMs,
				startedBeforeMs: beforeTime > 0 ? beforeTime : undefined,
				workspaceCwd: cwd,
			});
			if (should) {
				out.push({
					port,
					pid,
					...(name ? { name } : {}),
					...(command ? { command } : {}),
				});
			}
		}
		return out;
	}

	list(): BgServer[] {
		const out: BgServer[] = [...this.servers.entries()]
			.map(([port, v]) => ({
				port,
				pid: v.pid,
				since: v.since,
				...(v.name ? { name: v.name } : {}),
				...(v.command ? { command: v.command } : {}),
				...(v.keep ? { keep: true } : {}),
			}))
			.sort((a, b) => a.since - b.since);
		for (const t of this.opts.pluginTasks?.() ?? []) out.push(t);
		return out;
	}

	push(): void {
		this.opts.emit({ type: "bg_servers", servers: this.list() });
	}

	async refresh(): Promise<void> {
		if (this.opts.isDisposed() || this.servers.size === 0) return;
		const now = await snapshotListeningPorts();
		let changed = false;
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const [port, v] of [...this.servers]) {
			if (now.get(port) !== v.pid) {
				this.servers.delete(port);
				changed = true;
			}
		}
		if (changed) this.push();
	}

	async listAndPush(): Promise<void> {
		await this.refresh();
		this.push();
	}

	private async verifyBeforeKill(): Promise<void> {
		const now = await snapshotListeningPorts();
		let changed = false;
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const [port, v] of [...this.servers]) {
			if (now.get(port) !== v.pid) {
				this.servers.delete(port);
				changed = true;
			}
		}
		if (changed) this.push();
	}

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
		await this.verifyBeforeKill();
		const verified = this.servers.get(port);
		if (!verified || verified.pid !== entry.pid) {
			this.opts.emit({
				type: "notice",
				level: "warning",
				text: `端口 ${port} 已不在原进程（原 pid ${entry.pid}）监听，已跳过并刷新列表`,
				textEn: `Port ${port} is no longer held by the original process (pid ${entry.pid}); skipped and list refreshed`,
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

	setKeep(port: number, keep: boolean): boolean {
		const entry = this.servers.get(port);
		if (!entry) {
			this.opts.emit({
				type: "notice",
				level: "info",
				text: `端口 ${port} 不在后台任务列表中（可能已自行退出）`,
				textEn: `Port ${port} is not in the background task list (it may have exited)`,
			});
			this.opts.flushSnapshot();
			return false;
		}
		if (keep) entry.keep = true;
		else delete entry.keep;
		this.push();
		return true;
	}

	async cleanStale(thresholdMs: number, opts: { manual: boolean }): Promise<number[]> {
		await this.verifyBeforeKill();
		const picked = staleLeftovers(
			[...this.servers.entries()].map(([port, v]) => ({ port, ...v })),
			{ now: Date.now(), thresholdMs },
		);
		if (picked.length === 0) {
			if (opts.manual) {
				this.opts.emit({
					type: "notice",
					level: "info",
					text: `没有需要清理的遗留实例（阈值 ${Math.round(thresholdMs / 60_000)} 分钟，已钉住的不算）`,
					textEn: `No leftover instance to clean (threshold ${Math.round(thresholdMs / 60_000)} min; kept ones excluded)`,
				});
			}
			return [];
		}
		const killed: number[] = [];
		for (const item of picked) {
			killPidTree(item.pid);
			this.servers.delete(item.port);
			killed.push(item.port);
		}
		this.push();
		this.opts.emit({
			type: "notice",
			level: "info",
			text: `已清理 ${killed.length} 个遗留后台实例：端口 ${killed.join("、")}（闲置超 ${Math.round(thresholdMs / 60_000)} 分钟；可在面板里钉住想留的）`,
			textEn: `Cleaned ${killed.length} leftover background instance(s): port ${killed.join(", ")} (idle over ${Math.round(thresholdMs / 60_000)} min; pin the ones you want to keep)`,
		});
		this.opts.flushSnapshot();
		return killed;
	}

	async killAll(): Promise<string[]> {
		if (this.servers.size === 0) return [];
		await this.verifyBeforeKill();
		if (this.servers.size === 0) return [];
		const killed: string[] = [];
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const [port, { pid }] of [...this.servers]) {
			killPidTree(pid);
			killed.push(String(port));
		}
		this.servers.clear();
		this.push();
		return killed;
	}
}
