import { resolve } from "node:path";
import { McpBridge } from "./mcp-bridge.js";
import { createMcpHotReload, type McpHotReload } from "./mcp-hot-reload.js";
import type { PluginAgentTool } from "./plugins.js";

type Bridge = Pick<McpBridge, "load" | "reload" | "dispose" | "getTools">;
interface ProjectRuntime {
	cwd: string;
	bridge: McpBridge;
	watcher: McpHotReload;
	ready: Promise<void>;
	tail: Promise<unknown>;
	closed: boolean;
	lastAccess: number;
	busy: number;
}

export class McpProjectRuntimeRegistry {
	private projects = new Map<string, ProjectRuntime>();
	private pendingDisposals = new Set<Promise<void>>();
	private closed = false;
	private readonly idleTimer: NodeJS.Timeout;
	private publishing = false;

	private publish(cwd: string): void {
		const previous = this.publishing;
		this.publishing = true;
		try {
			this.options.onToolsChanged?.(cwd);
		} finally {
			this.publishing = previous;
		}
	}

	constructor(
		private readonly options: {
			dataDir: string;
			agentDir?: string;
			isProjectInUse?: (cwd: string) => boolean;
			idleTimeoutMs?: number;
			idleCheckIntervalMs?: number;
			now?: () => number;
			onToolsChanged?: (cwd: string) => void;
			onNotice?: (cwd: string, level: "info" | "warning", text: string, textEn: string) => void;
			log?: (...args: unknown[]) => void;
			createBridge?: (cwd: string, onToolsChanged: () => void) => Bridge;
		},
	) {
		this.idleTimer = setInterval(() => {
			void this.collectIdle().catch((err) => this.options.log?.("[mcp] idle cleanup failed", err));
		}, options.idleCheckIntervalMs ?? 60_000);
		this.idleTimer.unref();
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	retain(cwd: string): () => void {
		const entry = this.entry(cwd);
		entry.busy++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			entry.busy--;
			entry.lastAccess = this.now();
		};
	}

	async collectIdle(): Promise<void> {
		if (this.closed || !this.options.isProjectInUse) return;
		const cutoff = this.now() - (this.options.idleTimeoutMs ?? 300_000);
		const candidates = [...this.projects.values()].sort((a, b) => a.lastAccess - b.lastAccess);
		for (const entry of candidates) {
			if (this.closed) return;
			if (this.projects.get(this.key(entry.cwd)) !== entry || entry.busy || entry.lastAccess > cutoff) continue;
			let inUse = true;
			try {
				inUse = this.options.isProjectInUse(entry.cwd);
			} catch (err) {
				this.options.log?.("[mcp] ownership check failed; retaining project", entry.cwd, err);
			}
			if (!inUse) await this.disposeProject(entry.cwd);
		}
	}

	peekBridge(cwd: string): McpBridge | undefined {
		return this.projects.get(this.key(cwd))?.bridge as McpBridge | undefined;
	}

	private key(cwd: string): string {
		const path = resolve(cwd);
		return process.platform === "win32" ? path.toLowerCase() : path;
	}

	private entry(cwd: string): ProjectRuntime {
		if (this.closed) throw new Error("MCP project runtimes are closed");
		const key = this.key(cwd);
		const existing = this.projects.get(key);
		if (existing) {
			if (!this.publishing) existing.lastAccess = this.now();
			return existing;
		}
		const projectCwd = resolve(cwd);
		let entry: ProjectRuntime;
		const current = () => !this.closed && !entry.closed && this.projects.get(key) === entry;
		const changed = () => {
			if (current()) this.publish(projectCwd);
		};
		const bridge = (this.options.createBridge?.(projectCwd, changed) ??
			new McpBridge(this.options.dataDir, this.options.log, {
				agentDir: this.options.agentDir,
				cwd: projectCwd,
				onToolsChanged: changed,
			})) as McpBridge;
		const watcher = createMcpHotReload({
			dataDir: this.options.dataDir,
			agentDir: this.options.agentDir,
			cwd: projectCwd,
			reload: () => this.enqueue(entry),
			onNotice: (level, text, textEn) => {
				if (current()) this.options.onNotice?.(projectCwd, level, text, textEn);
			},
			log: this.options.log,
		});
		entry = {
			cwd: projectCwd,
			bridge,
			watcher,
			ready: Promise.resolve(),
			tail: Promise.resolve(),
			closed: false,
			lastAccess: this.now(),
			busy: 1,
		};
		this.projects.set(key, entry);
		watcher.start();
		entry.ready = Promise.resolve().then(async () => {
			if (!current()) return;
			try {
				await bridge.load();
				if (current()) changed();
			} finally {
				entry.busy--;
				if (!current()) bridge.dispose();
			}
		});
		entry.tail = entry.ready;
		void entry.ready
			.then(() => (current() ? watcher.apply() : undefined))
			.catch((err) => this.options.log?.("[mcp] project initialization failed", projectCwd, err));
		return entry;
	}

	getBridge(cwd: string): McpBridge {
		return this.entry(cwd).bridge;
	}

	async prepare(cwd: string): Promise<McpBridge> {
		const entry = this.entry(cwd);
		await entry.ready;
		if (this.closed || entry.closed) throw new Error("MCP project runtime was disposed during preparation");
		return entry.bridge;
	}

	getTools(cwd: string): PluginAgentTool[] {
		if (this.closed) return [];
		return this.entry(cwd).bridge.getTools();
	}

	private enqueue(entry: ProjectRuntime): ReturnType<McpBridge["reload"]> {
		entry.busy++;
		const run = entry.tail.then(async () => {
			if (this.closed || entry.closed) throw new Error("MCP project runtime is closed");
			try {
				const summary = await entry.bridge.reload();
				if (!this.closed && !entry.closed) this.publish(entry.cwd);
				return summary;
			} finally {
				if (this.closed || entry.closed) entry.bridge.dispose();
			}
		});
		const tracked = run.finally(() => {
			entry.busy--;
		});
		entry.tail = tracked.catch(() => {});
		return tracked;
	}

	/** Global configuration is shared on disk, while connections remain project-owned. */
	async reload(cwd: string, scope: "project" | "global" = "project"): Promise<void> {
		const entry = this.entry(cwd);
		await Promise.all((scope === "global" ? [...this.projects.values()] : [entry]).map((p) => this.enqueue(p)));
	}

	async disposeProject(cwd: string): Promise<void> {
		const key = this.key(cwd);
		const entry = this.projects.get(key);
		if (!entry) return;
		this.projects.delete(key);
		entry.closed = true;
		entry.watcher.dispose();
		entry.bridge.dispose();
		const cleanup = entry.tail.catch(() => {}).then(() => entry.bridge.dispose());
		this.pendingDisposals.add(cleanup);
		try {
			await cleanup;
		} finally {
			this.pendingDisposals.delete(cleanup);
		}
	}

	async dispose(): Promise<void> {
		this.closed = true;
		clearInterval(this.idleTimer);
		await Promise.all([...this.projects.keys()].map((cwd) => this.disposeProject(cwd)));
		await Promise.all(this.pendingDisposals);
	}
}
