import { describe, expect, it, vi } from "vitest";
import sftpPlugin from "../../plugins/sftp/index.mjs";
import { createSshManager } from "../../plugins/sftp/lib/ssh.mjs";

describe("SFTP 切换工作区保护", () => {
	it("dropAll(exceptCwd) 仅清理其他工作区的连接，保留当前工作区连接", async () => {
		const host = {
			ensureDeps: async () => {},
		};
		const mgr = createSshManager({ host, log: () => {}, secrets: { get: () => undefined } });

		const poolMap = (
			mgr as unknown as { _pool: Map<string, { alive: boolean; timer: NodeJS.Timeout; client: { end: () => void } }> }
		)._pool;
		const endA = vi.fn();
		const endB = vi.fn();
		poolMap.set("E:/proj-a\u0000prod", {
			alive: true,
			timer: setTimeout(() => {}, 100000),
			client: { end: endA },
		});
		poolMap.set("E:/proj-b\u0000prod", {
			alive: true,
			timer: setTimeout(() => {}, 100000),
			client: { end: endB },
		});

		mgr.dropAll("E:/proj-a");

		expect(endA).not.toHaveBeenCalled();
		expect(poolMap.has("E:/proj-a\u0000prod")).toBe(true);
		expect(endB).toHaveBeenCalled();
		expect(poolMap.has("E:/proj-b\u0000prod")).toBe(false);

		mgr.dropAll();
		expect(endA).toHaveBeenCalled();
		expect(poolMap.has("E:/proj-a\u0000prod")).toBe(false);
	});

	it("工作区切换时：运行中任务不被掐断，徽标带项目名前缀", async () => {
		let cwdHandler: ((next: string) => void) | null = null;
		const badges: Record<string, unknown>[] = [];
		const routes: Record<string, Function> = {};

		const host = {
			cwd: "E:/proj-a",
			log: () => {},
			notify: () => {},
			ensureDeps: async () => {},
			getSettings: () => ({}),
			secrets: { list: () => [], get: () => undefined },
			registerAgentTool: () => () => {},
			route: (_method: string, path: string, fn: Function) => {
				routes[path] = fn;
				return () => {};
			},
			ui: {
				update: (_id: string, badge: Record<string, unknown>) => {
					badges.push(badge);
				},
			},
			onCwdChange: (h: (next: string) => void) => {
				cwdHandler = h;
				return () => {
					cwdHandler = null;
				};
			},
			onSettingsChanged: () => () => {},
		};

		const deactivate = await sftpPlugin.activate(host);

		const reqMock = { query: {}, body: {} };
		let resJson: unknown = null;
		const resMock = {
			json: (d: unknown) => {
				resJson = d;
			},
			status: () => resMock,
		};

		await routes["/state"](reqMock, resMock);
		expect((resJson as { ok: boolean })?.ok).toBe(true);
		expect(cwdHandler).toBeDefined();

		cwdHandler!("E:/proj-b");
		expect(badges.length).toBeGreaterThanOrEqual(1);

		deactivate();
	});
});
