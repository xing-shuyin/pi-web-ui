import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CLIENT_STATE_RETENTION_MS,
	ClientStateStore,
	MAX_TRACKED_CLIENTS,
	RECENT_PROJECTS_MAX,
} from "../../server/client-state.js";

const DAY = 24 * 60 * 60 * 1000;

/** 计数探针：覆写存活性探测，统计探测次数并按白名单返回存活（不碰真实 fs）。 */
class CountingStore extends ClientStateStore {
	probes = 0;
	constructor(
		file: string,
		private allowed: ReadonlySet<string>,
	) {
		super(file);
	}

	protected override async pathExists(path: string): Promise<boolean> {
		this.probes++;
		return this.allowed.has(path);
	}
}

describe("ClientStateStore 死 clientId 清理（issue #441）", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-client-state-cleanup-"));
		file = join(dir, "client-state.json");
	});

	afterEach(() => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("超过保留期的死 clientId 被淘汰，最近活跃的保留，全局键与墓碑不受影响", () => {
		const now = Date.now();
		writeFileSync(
			file,
			JSON.stringify(
				{
					__settings__: { projects: [], removedProjects: ["/gone/a"] },
					stale: {
						lastActive: now - CLIENT_STATE_RETENTION_MS - DAY,
						projects: [{ path: "/stale/p", lastUsed: now - CLIENT_STATE_RETENTION_MS - DAY }],
						removedProjects: ["/gone/b"],
					},
					fresh: {
						lastActive: now - 60 * 60 * 1000,
						projects: [{ path: "/fresh/p", lastUsed: now - 60 * 60 * 1000 }],
					},
					// 旧存档：无 lastActive，但 projects.lastUsed 可推断出同样陈旧
					legacy: { projects: [{ path: "/legacy/p", lastUsed: now - CLIENT_STATE_RETENTION_MS - DAY }] },
					// 完全无时间戳可推断：不按年龄淘汰，仅受键数上限约束
					noTs: { projects: [], workspaceRoots: { "/x": ["/x/root"] } },
				},
				null,
				2,
			) + "\n",
		);

		const store = new ClientStateStore(file);

		// 死键：显式 lastActive 超期 → 淘汰
		expect(store.get("stale")).toEqual({ projects: [] });
		// 死键：旧存档按 projects.lastUsed 推断超期 → 同样淘汰
		expect(store.get("legacy")).toEqual({ projects: [] });
		// 最近活跃的保留，数据完好
		expect(store.get("fresh").projects.map((p) => p.path)).toEqual(["/fresh/p"]);
		// 无时间戳可推断的保留（保守：不按年龄淘汰）
		expect(store.get("noTs").workspaceRoots).toEqual({ "/x": ["/x/root"] });

		// 全局键不受清理影响；各死 client 的墓碑已在淘汰前并入全局键，不丢失
		expect(store.getRemovedProjects("someone")).toEqual(expect.arrayContaining(["/gone/a", "/gone/b"]));

		// 清理只动内存态，任意写路径触发 save 后自然落盘
		store.remember("fresh", join(dir, "some-project"));
		const persisted = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		expect(Object.keys(persisted)).not.toContain("stale");
		expect(Object.keys(persisted)).not.toContain("legacy");
		expect(Object.keys(persisted)).toContain("__settings__");
		expect(Object.keys(persisted)).toContain("fresh");
	});

	it("超过键数上限时按最近活跃保留前 50 个，淘汰最旧的", () => {
		const now = Date.now();
		const entries: Record<string, unknown> = { __settings__: { projects: [] } };
		for (let i = 0; i < MAX_TRACKED_CLIENTS + 5; i++) {
			const id = `c${String(i).padStart(2, "0")}`;
			entries[id] = {
				locale: id,
				projects: [{ path: `/p/${i}`, lastUsed: now - 2 * 60 * 60 * 1000 + i * 60_000 }],
			};
		}
		writeFileSync(file, JSON.stringify(entries, null, 2) + "\n");

		const store = new ClientStateStore(file);

		// 最旧的 5 个（c00..c04）被上限淘汰
		for (let i = 0; i < 5; i++) {
			expect(store.get(`c${String(i).padStart(2, "0")}`).locale).toBeUndefined();
		}
		// 最近活跃的 50 个保留
		expect(store.get("c05").locale).toBe("c05");
		expect(store.get(`c${String(MAX_TRACKED_CLIENTS + 4).padStart(2, "0")}`).locale).toBe("c54");

		store.remember("c54", join(dir, "p"));
		const persisted = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		const clientKeys = Object.keys(persisted).filter((k) => k !== "__settings__");
		expect(clientKeys.length).toBe(MAX_TRACKED_CLIENTS);
	});

	it("getRecentProjects 先截断后探测：探测次数封顶 RECENT_PROJECTS_MAX 且返回最近的那些", async () => {
		const now = Date.now();
		const total = RECENT_PROJECTS_MAX + 10;
		const paths = Array.from({ length: total }, (_, i) => `/p/${i}`);
		writeFileSync(
			file,
			JSON.stringify(
				{
					__settings__: { projects: [] },
					c1: {
						projects: paths.map((path, i) => ({ path, lastUsed: now - (total - i) * 60_000 })),
					},
				},
				null,
				2,
			) + "\n",
		);

		const store = new CountingStore(file, new Set(paths));
		const recent = await store.getRecentProjects("c1");

		// 多出的 10 条候选不探测（旧实现会对全部候选逐个探测后再截断）
		expect(store.probes).toBe(RECENT_PROJECTS_MAX);
		expect(recent.length).toBe(RECENT_PROJECTS_MAX);
		// 返回的是最近的那些（lastUsed 降序），最旧的 10 条从未被探测
		expect(recent[0].path).toBe(`/p/${total - 1}`);
		expect(recent.map((p) => p.path)).not.toContain("/p/0");
	});

	it("getRecentProjects 过滤探测不存活的路径", async () => {
		const now = Date.now();
		const alive = ["/alive/a", "/alive/b"];
		writeFileSync(
			file,
			JSON.stringify(
				{
					__settings__: { projects: [] },
					c1: {
						projects: [
							...alive.map((path, i) => ({ path, lastUsed: now - i })),
							{ path: "/dead/x", lastUsed: now + 1000 },
							{ path: "/dead/y", lastUsed: now + 500 },
						],
					},
				},
				null,
				2,
			) + "\n",
		);

		const store = new CountingStore(file, new Set(alive));
		const recent = await store.getRecentProjects("c1");

		expect(recent.map((p) => p.path).sort()).toEqual(["/alive/a", "/alive/b"]);
		expect(store.probes).toBe(4);
	});

	it("per-client 写路径打点 lastActive（活跃客户端不会被误淘汰）", () => {
		const store = new ClientStateStore(file);
		store.remember("c1", join(dir, "p1"));
		expect(store.get("c1").lastActive).toBeGreaterThanOrEqual(Date.now() - 60_000);

		store.saveProjectModel("c2", "/x", "provider/model");
		expect(store.get("c2").lastActive).toBeGreaterThanOrEqual(Date.now() - 60_000);
	});
});
