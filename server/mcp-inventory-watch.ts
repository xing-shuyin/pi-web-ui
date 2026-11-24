import { watch } from "node:fs";
import { dirname } from "node:path";

/** 抖一次就够：一次保存常常触发多条 fs 事件。 */
const DEFAULT_DEBOUNCE_MS = 600;

/** 单测注入的最小 watcher 形状（`node:fs` 的 `FSWatcher` 也满足它）。 */
export type McpInventoryWatchFn = (
	dir: string,
	options: { persistent: boolean },
	listener: (eventType: string, filename: string | Buffer | null) => void,
) => { on(event: "error", listener: () => void): unknown; close(): void };

export interface McpInventoryWatchOptions {
	/** 每次 `watch()` 现取两份配置路径：cwd 会变，不能构造期快照。 */
	paths: () => { globalPath: string; projectPath: string };
	isDisposed: () => boolean;
	/** 防抖后只调一次（只读通知：不触发 MCP 重载）。 */
	notify: () => void;
	debounceMs?: number;
	watchFn?: McpInventoryWatchFn;
}

/**
 * `global`/`project` 两份 `mcp.json` 的只读监听（gitWatch 式防抖）。
 *
 * 老实现长在 `ClientSession` 里（三个私有字段 + 两个方法）：抽出来是为了让老树与核心适配器
 * 用同一份防抖，而不是各写一份。语义保持不变：路径不变且已有 watcher 就不重装；只认 `mcp.json`；
 * 事件合并成一次 `notify`；watcher 出错即整体收摊。
 */
export class McpInventoryWatch {
	private watchers: { on(event: "error", listener: () => void): unknown; close(): void }[] = [];
	private key: string | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly options: McpInventoryWatchOptions) {}

	watch(): void {
		try {
			const { globalPath, projectPath } = this.options.paths();
			const key = `${globalPath}\n${projectPath}`;
			if (this.key === key && this.watchers.length > 0) return;
			this.close();
			this.key = key;
			const dirs = new Set<string>();
			try {
				dirs.add(dirname(globalPath));
			} catch {}
			try {
				dirs.add(dirname(projectPath));
			} catch {}
			const watchFn = this.options.watchFn ?? watch;
			for (const dir of dirs) {
				try {
					const watcher = watchFn(dir, { persistent: false }, (_event, filename) => {
						if (typeof filename === "string" && filename !== "mcp.json") return;
						if (this.options.isDisposed() || this.timer) return;
						this.timer = setTimeout(() => {
							this.timer = null;
							if (!this.options.isDisposed()) this.options.notify();
						}, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
					});
					watcher.on("error", () => this.close());
					this.watchers.push(watcher);
				} catch {}
			}
		} catch {
			this.close();
		}
	}

	close(): void {
		for (const watcher of this.watchers) {
			try {
				watcher.close();
			} catch {}
		}
		this.watchers = [];
		this.key = null;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}
}
