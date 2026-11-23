import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientStateStore, RECENT_PROJECTS_MAX } from "../../server/client-state.js";
import {
	createProjectSource,
	type ProjectSource,
} from "../../packages/keel/src/adapters/state/client-state-projects.js";
import { createProjectSource as createProjectSourceFromBarrel } from "../../packages/keel/src/adapters/state/index.js";
import type { TransportPort } from "../../packages/keel/src/contracts/ports.js";
import {
	orderProjects,
	buildProjectsFrame,
	pushProjects,
	type ProjectEntry,
	type RecentProjectsSource,
} from "../../packages/keel/src/domains/projects/index.js";
import type { ServerMessage } from "../../server/protocol.js";

function transportStub(closed = false): { sent: ServerMessage[]; transport: TransportPort } {
	const sent: ServerMessage[] = [];
	return { sent, transport: { send: (msg) => void sent.push(msg), isClosed: () => closed } };
}

function sourceOf(recent: readonly ProjectEntry[], removed: readonly string[] = []): RecentProjectsSource {
	return { recent: async () => [...recent], removed: () => removed };
}

const readFailure = new Error("client-state 读不出来");

describe("projects 帧（domains/projects）", () => {
	it("最近列表为空：把当前 cwd 插到最前，`lastUsed` 写 0", async () => {
		const { sent, transport } = transportStub();
		const projects = await pushProjects({ transport, clientId: "c1", cwd: "/work/alpha", source: sourceOf([]) });

		expect(projects).toEqual([{ path: "/work/alpha", lastUsed: 0 }]);
		expect(sent).toEqual([{ type: "projects", projects: [{ path: "/work/alpha", lastUsed: 0 }] }]);
	});

	it("当前项目已在列表里：不刷 `lastUsed`、不重排、不重复插入", async () => {
		const recent: ProjectEntry[] = [
			{ path: "/work/beta", lastUsed: 900 },
			{ path: "/work/alpha", lastUsed: 400 },
		];
		const { transport } = transportStub();
		const projects = await pushProjects({ transport, clientId: "c1", cwd: "/work/alpha", source: sourceOf(recent) });

		expect(projects).toEqual(recent);
		expect(projects).toHaveLength(2);
	});

	it("当前项目被移除过（墓碑）：不补回列表", async () => {
		const recent: ProjectEntry[] = [{ path: "/work/beta", lastUsed: 900 }];
		const { transport } = transportStub();
		const projects = await pushProjects({
			transport,
			clientId: "c1",
			cwd: "/work/alpha",
			source: sourceOf(recent, ["/work/alpha"]),
		});

		expect(projects).toEqual(recent);
	});

	it("空列表且当前项目在墓碑里：列表保持为空", async () => {
		const { transport } = transportStub();
		const projects = await pushProjects({
			transport,
			clientId: "c1",
			cwd: "/work/alpha",
			source: sourceOf([], ["/work/alpha"]),
		});

		expect(projects).toEqual([]);
	});

	it("插入只在最前一条：其余项目的顺序与时间原样保留", async () => {
		const { transport } = transportStub();
		const projects = await pushProjects({
			transport,
			clientId: "c1",
			cwd: "/work/new",
			source: sourceOf([
				{ path: "/work/c", lastUsed: 500 },
				{ path: "/work/b", lastUsed: 300 },
				{ path: "/work/d", lastUsed: 100 },
			]),
		});

		expect(projects).toEqual([
			{ path: "/work/new", lastUsed: 0 },
			{ path: "/work/c", lastUsed: 500 },
			{ path: "/work/b", lastUsed: 300 },
			{ path: "/work/d", lastUsed: 100 },
		]);
	});

	it("`lastUsed` 降序：来源的降序不会被当前 cwd 的插入打乱（插入项永远 0）", async () => {
		const { transport } = transportStub();
		const projects = await pushProjects({
			transport,
			clientId: "c1",
			cwd: "/work/new",
			source: sourceOf([
				{ path: "/work/a", lastUsed: 900 },
				{ path: "/work/b", lastUsed: 500 },
				{ path: "/work/c", lastUsed: 100 },
			]),
		});

		expect(projects.map((p) => p.lastUsed)).toEqual([0, 900, 500, 100]);
		expect(projects.map((p) => p.path)).toEqual(["/work/new", "/work/a", "/work/b", "/work/c"]);
	});

	it("`lastUsed` 相同：保持来源里的相对顺序（不做二次排序）", async () => {
		const projects = orderProjects({
			cwd: "/work/new",
			recent: [
				{ path: "/work/b", lastUsed: 500 },
				{ path: "/work/a", lastUsed: 500 },
			],
			removed: [],
		});

		expect(projects.map((p) => p.path)).toEqual(["/work/new", "/work/b", "/work/a"]);
	});

	it("路径键归一：大小写/尾斜杠不同也算同一个项目（不重复插入、墓碑照样命中）", () => {
		const known = orderProjects({
			cwd: "D:\\Work\\Repo",
			recent: [{ path: "d:/work/repo", lastUsed: 7 }],
			removed: [],
		});
		expect(known).toEqual([{ path: "d:/work/repo", lastUsed: 7 }]);

		const tombstoned = orderProjects({ cwd: "D:\\Work\\Repo", recent: [], removed: ["d:/work/repo/"] });
		expect(tombstoned).toEqual([]);
	});

	it("插入后仍不超过 RECENT_PROJECTS_MAX 条，末位被挤掉", async () => {
		const recent = Array.from({ length: RECENT_PROJECTS_MAX }, (_, i) => ({
			path: `/work/p${i}`,
			lastUsed: 10_000 - i,
		}));
		const { transport } = transportStub();
		const projects = await pushProjects({
			transport,
			clientId: "c1",
			cwd: "/work/new",
			source: sourceOf(recent),
		});

		expect(projects).toHaveLength(RECENT_PROJECTS_MAX);
		expect(projects[0]).toEqual({ path: "/work/new", lastUsed: 0 });
		expect(projects[RECENT_PROJECTS_MAX - 1]).toEqual(recent[RECENT_PROJECTS_MAX - 2]);
	});

	it("最近列表读不出来：发空帧、不抛", async () => {
		const { sent, transport } = transportStub();
		const projects = await pushProjects({
			transport,
			clientId: "c1",
			cwd: "/work/alpha",
			source: {
				recent: async () => {
					throw readFailure;
				},
				removed: () => [],
			},
		});

		expect(projects).toEqual([]);
		expect(sent).toEqual([{ type: "projects", projects: [] }]);
	});

	it("墓碑读不出来：同样发空帧、不抛", async () => {
		const { sent, transport } = transportStub();
		const projects = await pushProjects({
			transport,
			clientId: "c1",
			cwd: "/work/alpha",
			source: {
				recent: async () => [{ path: "/work/beta", lastUsed: 900 }],
				removed: () => {
					throw readFailure;
				},
			},
		});

		expect(projects).toEqual([]);
		expect(sent).toEqual([{ type: "projects", projects: [] }]);
	});

	it('帧形状固定是 `{ type: "projects", projects }`', async () => {
		const frame = buildProjectsFrame([{ path: "/work/alpha", lastUsed: 0 }]);
		expect(frame).toEqual({ type: "projects", projects: [{ path: "/work/alpha", lastUsed: 0 }] });
		expect(Object.keys(frame)).toEqual(["type", "projects"]);

		const { sent, transport } = transportStub();
		const projects = await pushProjects({ transport, clientId: "c1", cwd: "/work/alpha", source: sourceOf([]) });
		expect(sent).toHaveLength(1);
		expect(sent[0]).toStrictEqual({ type: "projects", projects });
	});

	it("通道已关：不发帧，但仍把列表交回去", async () => {
		const { sent, transport } = transportStub(true);
		const projects = await pushProjects({ transport, clientId: "c1", cwd: "/work/alpha", source: sourceOf([]) });

		expect(sent).toEqual([]);
		expect(projects).toEqual([{ path: "/work/alpha", lastUsed: 0 }]);
	});

	it("返回的是副本：来源的数组与条目不被改动", () => {
		const recent: ProjectEntry[] = [{ path: "/work/b", lastUsed: 100 }];
		const projects = orderProjects({ cwd: "/work/a", recent, removed: [] });

		expect(projects).not.toBe(recent);
		expect(projects[1]).not.toBe(recent[0]);
		expect(recent).toEqual([{ path: "/work/b", lastUsed: 100 }]);
	});
});

describe("项目来源适配器（adapters/state）", () => {
	const dirs: string[] = [];
	const opened: ProjectSource[] = [];

	afterEach(() => {
		for (const source of opened.splice(0)) source.close();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	function tempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "core-projects-"));
		dirs.push(dir);
		return dir;
	}

	function open(options: Parameters<typeof createProjectSource>[0]): ProjectSource {
		const source = createProjectSource(options);
		opened.push(source);
		return source;
	}

	it("真 ClientStateStore 往返：remember → recent 读到，forget → 墓碑生效并落盘", async () => {
		const dir = tempDir();
		const file = join(dir, "client-state.json");
		const alpha = join(dir, "alpha");
		const beta = join(dir, "beta");
		mkdirSync(alpha);
		mkdirSync(beta);

		const seed = new ClientStateStore(file);
		seed.remember("client-1", alpha);
		seed.remember("client-1", beta);

		const source = open({ file, sessionRoots: [] });
		const recent = await source.recent("client-1");
		expect(recent.map((p) => p.path).sort()).toEqual([alpha, beta].sort());
		expect(recent.every((p) => p.lastUsed > 0)).toBe(true);

		source.forget("client-1", alpha);
		expect((await source.recent("client-1")).map((p) => p.path)).toEqual([beta]);
		expect(source.removed("client-1")).toContain(alpha);

		// 落盘：新开一个 store 也看得见墓碑与删掉的列表项。
		const reloaded = new ClientStateStore(file);
		expect(reloaded.getRemovedProjects("client-1")).toContain(alpha);
		expect((await reloaded.getRecentProjects("client-1")).map((p) => p.path)).toEqual([beta]);
	});

	it("扫盘根目录不存在时静默：recent 仍给出 client-state 的列表", async () => {
		const dir = tempDir();
		const file = join(dir, "client-state.json");
		const alpha = join(dir, "alpha");
		mkdirSync(alpha);
		new ClientStateStore(file).remember("client-1", alpha);

		const source = open({ file, sessionRoots: [join(dir, "missing-sessions")] });
		expect((await source.recent("client-1")).map((p) => p.path)).toEqual([alpha]);
	});

	it("只给 file：默认会话根目录不存在时同样不抛、不扫出东西", async () => {
		vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
		const dir = tempDir();
		const file = join(dir, "client-state.json");
		const alpha = join(dir, "alpha");
		mkdirSync(alpha);
		new ClientStateStore(file).remember("client-1", alpha);

		const source = open({ file });
		expect((await source.recent("client-1")).map((p) => p.path)).toEqual([alpha]);
	});

	it("close 之后仍能读最近列表（只是不再扫盘）", async () => {
		const dir = tempDir();
		const file = join(dir, "client-state.json");
		const alpha = join(dir, "alpha");
		mkdirSync(alpha);
		new ClientStateStore(file).remember("client-1", alpha);

		const source = open({ file, sessionRoots: [] });
		source.close();
		expect((await source.recent("client-1")).map((p) => p.path)).toEqual([alpha]);
	});

	it("barrel 导出与直接导入是同一个实现", () => {
		expect(createProjectSourceFromBarrel).toBe(createProjectSource);
	});
});
