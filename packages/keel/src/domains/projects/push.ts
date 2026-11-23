import { normalizePathKey, RECENT_PROJECTS_MAX } from "../../projects-schema.js";
import type { ProjectSummary, ServerMessage } from "../../protocol.js";
import type { TransportPort } from "../../contracts/ports.js";

export interface ProjectEntry {
	path: string;
	lastUsed: number;
}

/** 域对项目来源的窄面：只读最近列表与墓碑；扫盘与写回由适配器负责。 */
export interface RecentProjectsSource {
	recent(clientId: string): Promise<ProjectEntry[]>;
	removed(clientId: string): readonly string[];
}

export interface PushProjectsInput {
	transport: TransportPort;
	clientId: string;
	cwd: string;
	source: RecentProjectsSource;
	/**
	 * 帧的时间戳。当前 cwd 的插入项固定写 `lastUsed: 0`（见 `orderProjects`），所以它不参与帧内容，
	 * 收在这里只是让调用方能统一注入时钟。
	 */
	now?: number;
}

export interface OrderProjectsInput {
	cwd: string;
	recent: readonly ProjectEntry[];
	removed: readonly string[];
}

/**
 * 最近列表 + 当前 cwd → 这一帧的项目列表（老实现 `withCurrentCwd` 的三条规则）：
 *
 * - 当前项目在墓碑里：不补（用户明确移除过，换个项目切回来不该自己长出来）；
 * - 当前项目已在列表里：不刷 `lastUsed`（切过去看看不算真实对话，项目顺序只认真实对话）；
 * - 都不满足：插到最前，`lastUsed` 写 0 —— 它与「还没真实对话过」等价，客户端据此把它排在
 *   真实对话过的项目之后，而位置仍是最上面。
 *
 * 返回新数组与新条目：来源的数组/对象原样留给适配器，帧里改不动它们。
 */
export function orderProjects(input: OrderProjectsInput): ProjectSummary[] {
	const currentKey = normalizePathKey(input.cwd);
	const removedKeys = new Set(input.removed.map(normalizePathKey));
	const copied = input.recent.map((p) => ({ path: p.path, lastUsed: p.lastUsed }));
	const known = copied.some((p) => normalizePathKey(p.path) === currentKey);
	if (removedKeys.has(currentKey) || known) return copied;
	return [{ path: input.cwd, lastUsed: 0 }, ...copied].slice(0, RECENT_PROJECTS_MAX);
}

export function buildProjectsFrame(projects: readonly ProjectSummary[]): ServerMessage {
	return { type: "projects", projects: [...projects] };
}

async function readProjects(input: PushProjectsInput): Promise<ProjectSummary[]> {
	try {
		const recent = await input.source.recent(input.clientId);
		return orderProjects({ cwd: input.cwd, recent, removed: input.source.removed(input.clientId) });
	} catch {
		// 读不出来就发空帧（不抛）：客户端自己会把当前 cwd 补回列表，这里不去猜墓碑。
		return [];
	}
}

/** 推一帧 `projects`：最近列表按上面的规则补上当前 cwd，通道已关时不发但仍把列表交回去。 */
export async function pushProjects(input: PushProjectsInput): Promise<ProjectSummary[]> {
	const projects = await readProjects(input);
	if (!input.transport.isClosed()) input.transport.send(buildProjectsFrame(projects));
	return projects;
}
