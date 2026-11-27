import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";
import { handleFileMessage, handleSessionLifecycleMessage } from "../../server/dispatch-domain-handlers.js";
import { orderProjects, pushProjects } from "../../packages/keel/src/domains/projects/index.js";
import { resolveProjectDisplayName } from "../../web/src/title-settings.js";

describe("项目改名与打开项目指定名称", () => {
	let dir: string;
	let file: string;
	let store: ClientStateStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-project-rename-test-"));
		file = join(dir, "client-state.json");
		store = new ClientStateStore(file);
	});

	afterEach(() => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	});

	it("ClientStateStore 支持保存、读取、覆盖和清除项目名称，并在 getRecentProjects 中返回", async () => {
		const projDir = join(dir, "my-repo");
		mkdirSync(projDir);
		store.remember("clientA", projDir);

		expect(store.getProjectName(projDir)).toBeUndefined();
		store.saveProjectName(projDir, "  核心后端  ");
		expect(store.getProjectName(projDir)).toBe("核心后端");

		const recent1 = await store.getRecentProjects("clientA");
		expect(recent1).toHaveLength(1);
		expect(recent1[0]?.name).toBe("核心后端");

		// 持久化重启后依然存在
		const reopened = new ClientStateStore(file);
		expect(reopened.getProjectName(projDir)).toBe("核心后端");

		// 传空字符串清除自定义名，恢复默认
		reopened.saveProjectName(projDir, "   ");
		expect(reopened.getProjectName(projDir)).toBeUndefined();
		const recent2 = await reopened.getRecentProjects("clientA");
		expect(recent2[0]?.name).toBeUndefined();
	});

	it("orderProjects / pushProjects 保留最近项目名称并为当前 cwd 补上自定义名称", async () => {
		const sent: unknown[] = [];
		const projects = await pushProjects({
			transport: { send: (m) => void sent.push(m), isClosed: () => false },
			clientId: "c1",
			cwd: "/work/current",
			source: {
				recent: async () => [{ path: "/work/other", lastUsed: 100, name: "其他项目" }],
				removed: () => [],
				nameOf: (p) => (p === "/work/current" ? "当前自定义名" : undefined),
			},
		});

		expect(projects).toEqual([
			{ path: "/work/current", lastUsed: 0, name: "当前自定义名" },
			{ path: "/work/other", lastUsed: 100, name: "其他项目" },
		]);
		expect(orderProjects({ cwd: "/work/other", recent: projects, removed: [] })).toEqual(projects);
	});

	it("dispatch 处理 set_cwd(name)、make_dir(setAsCwd, name) 与 rename_project", async () => {
		const setCwd = vi.fn(async () => {});
		const makeDir = vi.fn(async () => {});
		const renameProject = vi.fn(async () => {});
		const cs = {
			setCwd,
			makeDir,
			renameProject,
			emitNotice: vi.fn(),
		} as any;

		expect(handleFileMessage({ type: "set_cwd", path: "/work/a", name: "项目A" }, cs)).toBe(true);
		expect(handleFileMessage({ type: "make_dir", path: "/work/b", setAsCwd: true, name: "项目B" }, cs)).toBe(true);
		expect(handleSessionLifecycleMessage({ type: "rename_project", path: "/work/c", name: "项目C" }, cs)).toBe(true);

		// 等待入队的异步任务完成
		await new Promise((r) => setTimeout(r, 20));
		expect(setCwd).toHaveBeenCalledWith("/work/a");
		expect(makeDir).toHaveBeenCalledWith("/work/b", true);
		expect(renameProject).toHaveBeenCalledWith("/work/a", "项目A");
		expect(renameProject).toHaveBeenCalledWith("/work/b", "项目B");
		expect(renameProject).toHaveBeenCalledWith("/work/c", "项目C");
	});

	it("resolveProjectDisplayName 优先返回自定义项目名，未设置时回退目录名", () => {
		const projects = [{ path: "/work/alpha", name: "阿尔法" }, { path: "/work/beta" }];
		expect(resolveProjectDisplayName("/work/alpha", projects)).toBe("阿尔法");
		expect(resolveProjectDisplayName("/work/alpha/", projects)).toBe("阿尔法");
		expect(resolveProjectDisplayName("/work/beta", projects)).toBe("beta");
		expect(resolveProjectDisplayName("/work/gamma", projects)).toBe("gamma");
	});
});
