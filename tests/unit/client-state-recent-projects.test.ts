import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientStateStore, RECENT_PROJECTS_MAX } from "../../server/client-state.js";

describe("ClientStateStore 最近项目删除全局持久化", () => {
	let dir: string;
	let file: string;
	let store: ClientStateStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-client-state-test-"));
		file = join(dir, "client-state.json");
		store = new ClientStateStore(file);
	});

	afterEach(() => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	});

	it("在 client A 删除的项目，对新 client B 同样保持删除状态（全局 tombstone）", () => {
		store.remember("clientA", "/path/to/project1");
		store.remember("clientA", "/path/to/project2");
		store.remember("clientB", "/path/to/project1");

		store.removeProject("clientA", "/path/to/project1");

		expect(store.getRemovedProjects("clientA")).toContain("/path/to/project1");
		expect(store.getRemovedProjects("clientB")).toContain("/path/to/project1");
		expect(store.getRemovedProjects("clientC")).toContain("/path/to/project1");

		expect(store.get("clientB").projects.map((p) => p.path)).not.toContain("/path/to/project1");
	});

	it("服务重启（新 ClientStateStore 实例）后 tombstone 依然有效", () => {
		store.remember("clientA", "/path/to/project1");
		store.removeProject("clientA", "/path/to/project1");

		const reopened = new ClientStateStore(file);
		expect(reopened.getRemovedProjects("brandNewClient")).toContain("/path/to/project1");
	});

	it("用户显式重新打开该项目时，清除全局 tombstone", () => {
		store.remember("clientA", "/path/to/project1");
		store.removeProject("clientA", "/path/to/project1");
		expect(store.getRemovedProjects("clientB")).toContain("/path/to/project1");

		store.remember("clientB", "/path/to/project1");

		expect(store.getRemovedProjects("clientA")).not.toContain("/path/to/project1");
		expect(store.getRemovedProjects("clientB")).not.toContain("/path/to/project1");
		expect(store.getRemovedProjects("clientC")).not.toContain("/path/to/project1");
	});

	it("路径大小写或斜杠不一致时，依然能正确移出并匹配 tombstone (Windows 归一化)", () => {
		const originalPath = process.platform === "win32" ? "C:\\Users\\test\\ProjectA" : "/Users/test/ProjectA";
		const variantPath = process.platform === "win32" ? "c:\\users\\test\\projecta" : "/Users/test/ProjectA";

		store.remember("clientA", originalPath);
		expect(store.get("clientA").projects.length).toBe(1);

		store.removeProject("clientA", variantPath);

		expect(store.get("clientA").projects.length).toBe(0);
		const removed = store.getRemovedProjects("clientB");
		expect(removed.some((p) => p.toLowerCase() === originalPath.toLowerCase())).toBe(true);
	});

	it("浏览/切换（promote: false）不刷新最近对话时间，只在未登记时以 lastUsed: 0 补位", () => {
		const chatted = join(dir, "chatted");
		mkdirSync(chatted);
		store.remember("clientA", chatted);
		const before = store.get("clientA").projects.find((p) => p.path === chatted)!;
		expect(before.lastUsed).toBeGreaterThan(0);

		store.remember("clientA", chatted, { promote: false });
		expect(store.get("clientA").projects.find((p) => p.path === chatted)!.lastUsed).toBe(before.lastUsed);

		const browsed = join(dir, "browsed");
		mkdirSync(browsed);
		store.remember("clientA", browsed, { promote: false });
		const browsedEntry = store.get("clientA").projects.find((p) => p.path === browsed)!;
		expect(browsedEntry.lastUsed).toBe(0);
		// 没聊过天也不妨碍它成为「上次打开的项目」
		expect(store.get("clientA").lastCwd).toBe(browsed);
	});

	it("启动/加载时自动将老 client 中的 removedProjects 迁移到全局 __settings__", () => {
		const oldContent = {
			clientOld: {
				projects: [],
				removedProjects: ["/legacy/path/to/projectX"],
			},
			__settings__: {
				projects: [],
			},
		};
		writeFileSync(file, JSON.stringify(oldContent, null, 2) + "\n");

		const newStore = new ClientStateStore(file);
		expect(newStore.getRemovedProjects("brandNewClient")).toContain("/legacy/path/to/projectX");
	});

	it("迁移按归一化路径取最新记录，跨全局和所有 client 排序截断并立即持久化", () => {
		const duplicate = join(dir, "duplicate");
		const newest = { path: `${duplicate}/.`, lastUsed: RECENT_PROJECTS_MAX + 100 };
		const globalOnly = { path: join(dir, "global-only"), lastUsed: RECENT_PROJECTS_MAX + 200 };
		const projects = Array.from({ length: RECENT_PROJECTS_MAX + 5 }, (_, i) => ({
			path: join(dir, `project-${i}`),
			lastUsed: i + 1,
		}));
		writeFileSync(
			file,
			JSON.stringify({
				__settings__: { projects: [globalOnly, { path: duplicate, lastUsed: 0 }] },
				clientA: {
					lastActive: Date.now(),
					projects: [...projects.slice(0, 50), newest],
				},
				clientB: {
					lastActive: Date.now(),
					projects: [...projects.slice(50), { path: duplicate, lastUsed: 2 }],
				},
			}),
		);

		const expected = [globalOnly, newest, ...projects.reverse()].slice(0, RECENT_PROJECTS_MAX);
		expect(store.get("__settings__").projects).toEqual(expected);
		const persisted = JSON.parse(readFileSync(file, "utf8"));
		expect(Object.keys(persisted)).toHaveLength(3);
		expect(persisted.__settings__.projects).toEqual(expected);
		expect(new ClientStateStore(file).get("__settings__").projects).toEqual(expected);
	});

	it("迁移先汇总所有墓碑，过期 client 与全局中的项目均不能复活", async () => {
		const globalRemoved = join(dir, "global-removed");
		const legacyRemoved = join(dir, "legacy-removed");
		mkdirSync(globalRemoved);
		mkdirSync(legacyRemoved);
		const expected = [{ path: dir, lastUsed: 1 }];
		writeFileSync(
			file,
			JSON.stringify({
				__settings__: {
					projects: [{ path: legacyRemoved, lastUsed: 4 }],
					removedProjects: [`${globalRemoved}/.`],
				},
				legacy: {
					projects: [...expected, { path: globalRemoved, lastUsed: 3 }],
				},
				otherLegacy: {
					projects: [{ path: legacyRemoved, lastUsed: 2 }],
					removedProjects: [`${legacyRemoved}/.`],
				},
			}),
		);

		expect(await store.getRecentProjects("new-client")).toEqual(expected);
		expect(store.get("__settings__").projects).toEqual(expected);
		const reopened = new ClientStateStore(file);
		expect(await reopened.getRecentProjects("another-client")).toEqual(expected);
		expect(reopened.get("__settings__").projects).toEqual(expected);
		expect(reopened.getRemovedProjects("another-client")).toEqual(
			expect.arrayContaining([`${globalRemoved}/.`, `${legacyRemoved}/.`]),
		);
	});

	it("getRecentProjects 跨 client 聚合且过滤墓碑与不存在目录", async () => {
		store.remember("clientA", dir);
		store.remember("clientB", join(dir, "non-existent-subfolder"));

		const recentA = await store.getRecentProjects("clientA");
		expect(recentA.map((p) => p.path)).toContain(dir);
		expect(recentA.map((p) => p.path)).not.toContain(join(dir, "non-existent-subfolder"));

		const recentBrandNew = await store.getRecentProjects("brandNewClient");
		expect(recentBrandNew.map((p) => p.path)).toContain(dir);

		store.removeProject("clientA", dir);
		const recentAfterRemove = await store.getRecentProjects("brandNewClient");
		expect(recentAfterRemove.map((p) => p.path)).not.toContain(dir);
	});

	it("mergeDiscoveredProjects 能合并新发现的项目并尊重墓碑", async () => {
		store.removeProject("clientA", dir);
		store.mergeDiscoveredProjects([{ path: dir, lastUsed: 12345 }]);

		expect((await store.getRecentProjects("clientA")).map((p) => p.path)).not.toContain(dir);
	});
});
