import { dirname, join, resolve } from "node:path";
import { ClientStateStore } from "../../../client-state.js";
import { discoverRecentProjectsFromDisk } from "../../../session-parser.js";
import { piSessionsRoot } from "../../../session-search.js";

/** 一次扫盘最多发现多少个项目（老实现 `ensureProjectsCache` 的 30）。 */
const DISCOVERY_LIMIT = 30;
/** 扫盘结果的有效期：窗口内 `recent()` 不重复扫盘（老实现 `PROJECTS_CACHE_TTL`）。 */
const DISCOVERY_TTL_MS = 60_000;

export interface ProjectEntry {
	path: string;
	lastUsed: number;
}

export interface ProjectSourceOptions {
	/** `client-state.json` 的路径；持久化仍是 `ClientStateStore` 的事，这里只做窄面转发。 */
	file: string;
	/**
	 * 扫盘发现项目用的会话根目录。默认是 `file` 所在目录的 `sessions/` 加 `PI_CODING_AGENT_SESSION_DIR`：
	 * 默认布局下 client-state 就住在 agent 目录（`~/.pi`），两处一致；分目录部署时显式传。
	 */
	sessionRoots?: readonly string[];
	discoveryTtlMs?: number;
	discoveryLimit?: number;
}

export interface ProjectSource {
	/** 最近项目（含本机其它客户端登记的），`lastUsed` 降序；墓碑与失效路径已由 store 过滤。 */
	recent(clientId: string): Promise<ProjectEntry[]>;
	/** 用户明确移除过的路径（墓碑）：域据此判断「当前项目被移除就不补」。 */
	removed(clientId: string): readonly string[];
	forget(clientId: string, path: string): void;
	/** 之后不再扫盘（读仍可用）：本适配器没有定时器与文件句柄，没有别的资源要收。 */
	close(): void;
}

function defaultSessionRoots(file: string): string[] {
	const roots = [join(dirname(resolve(file)), "sessions")];
	const extra = piSessionsRoot();
	if (extra) roots.push(resolve(extra));
	return roots;
}

/**
 * 项目来源的适配器：`ClientStateStore`（最近列表 / 墓碑 / 移除）+ 扫盘发现。
 *
 * 写回、排序、墓碑规则全在 store 里，这里只负责「把盘上新发现的项目灌进 store，再读最近列表」。
 * 扫盘失败（权限 / 已断连的网络盘）不算失败：最近列表仍以 client-state 为准。
 */
export function createProjectSource(options: ProjectSourceOptions): ProjectSource {
	const store = new ClientStateStore(options.file);
	const roots = options.sessionRoots ? [...options.sessionRoots] : defaultSessionRoots(options.file);
	const ttl = options.discoveryTtlMs ?? DISCOVERY_TTL_MS;
	const limit = options.discoveryLimit ?? DISCOVERY_LIMIT;
	let scannedAt: number | null = null;
	let scanning: Promise<void> | null = null;
	let closed = false;

	async function scanFromDisk(): Promise<void> {
		try {
			store.mergeDiscoveredProjects(await discoverRecentProjectsFromDisk(roots, limit));
			scannedAt = Date.now();
		} catch {
			// 扫不动盘不算失败：store 里的最近列表照旧可读。
		} finally {
			scanning = null;
		}
	}

	function discover(): Promise<void> {
		if (!scanning) scanning = scanFromDisk();
		return scanning;
	}

	return {
		async recent(clientId) {
			// 老实现首次 push 会同步等一次扫盘、之后按 TTL 复用缓存；这里同样是「最多每 TTL 扫一次」。
			if (!closed && (scannedAt === null || Date.now() - scannedAt >= ttl)) await discover();
			return store.getRecentProjects(clientId);
		},
		removed(clientId) {
			return store.getRemovedProjects(clientId);
		},
		forget(clientId, path) {
			store.removeProject(clientId, path);
		},
		close() {
			closed = true;
		},
	};
}
