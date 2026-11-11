import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockHost } from "../../plugin-sdk/index.mjs";
import { parseUiContributions } from "../../server/plugins.js";
import pm2Plugin, {
	buildPm2StartArgv,
	formatAppLine,
	formatAppStatus,
	formatBytes,
	formatUptime,
	parsePm2List,
	parsePm2ListOutput,
	pm2EntryCandidates,
	stripAnsi,
	INSTALL_COMMAND,
	UNINSTALL_COMMAND,
} from "../../plugins/pm2-manager/index.mjs";

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "pm2-manager");
const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));

const cleanups: (() => void)[] = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

describe("pm2-manager manifest", () => {
	it("声明 apiVersion 2 / 三项权限 / 无独立面板（内嵌进后台任务面板）", () => {
		expect(manifest.id).toBe("pm2-manager");
		expect(manifest.apiVersion).toBe(2);
		expect(manifest.view).toBe(false);
		expect(manifest.ui.topbar).toBeUndefined();
		for (const need of ["ui", "tools", "http"]) expect(manifest.permissions).toContain(need);
		expect(manifest.settings.map((s: { key: string }) => s.key)).toEqual(["pm2Bin"]);
	});

	it("ui 经服务端解析出唯一的 tasks.panel 视图条目（内嵌渲染）", () => {
		const parsed = parseUiContributions(manifest.ui) as { items: any[]; arrange: any[] };
		expect(parsed.items).toHaveLength(1);
		const item = parsed.items[0];
		expect(item.slot).toBe("tasks.panel");
		expect(item.kind).toBe("view");
		expect(item.view).toBe("plugin:pm2-manager");
		expect(item.label).toBeTruthy();
		expect(item.labelEn).toBeTruthy();
	});
});

describe("pm2-manager pm2 入口候选与 jlist", () => {
	it("环境变量优先，其次 node 前缀布局，且去重", () => {
		const list = pm2EntryCandidates({
			execPath: "/usr/local/bin/node",
			env: { PI_WEB_PM2: "/opt/pm2/bin/pm2" },
		});
		expect(list[0]).toEqual({ bin: "/opt/pm2/bin/pm2", source: "env:PI_WEB_PM2" });
		expect(list.some((c) => c.bin === join("/usr/local/bin", "node_modules", "pm2", "bin", "pm2"))).toBe(true);
		const bins = list.map((c) => c.bin);
		expect(new Set(bins).size).toBe(bins.length);
	});

	it("无 execPath / 无 env 时返回空数组（不抛错）", () => {
		expect(pm2EntryCandidates()).toEqual([]);
		expect(pm2EntryCandidates({ execPath: "", env: {} })).toEqual([]);
	});

	const jlist = [
		{
			name: "api",
			pid: 4242,
			monit: { cpu: 12, memory: 188743680 },
			pm2_env: {
				status: "online",
				restart_time: 3,
				pm_uptime: 1_700_000_000_000,
				pm_exec_path: "/srv/api/server.js",
				pm_cwd: "/srv/api",
				exec_mode: "fork",
			},
		},
		{ name: "worker", pid: 0, monit: {}, pm2_env: { status: "stopped" } },
		{ nope: true },
	];

	it("jlist 归一化：缺字段回落，无名条目丢弃", () => {
		const apps = parsePm2List(jlist);
		expect(apps).toHaveLength(2);
		expect(apps[0]).toMatchObject({ name: "api", status: "online", cpu: 12, restarts: 3, mode: "fork" });
		expect(apps[1]).toMatchObject({ name: "worker", status: "stopped", cpu: 0, memory: 0, restarts: 0 });
	});

	it("jlist 输出解析容忍 ANSI 与前置噪声，坏输入回空数组", () => {
		const noisy = `\u001B[32m[PM2]\u001B[39m dumping\n${JSON.stringify(jlist)}`;
		expect(parsePm2ListOutput(noisy).map((a) => a.name)).toEqual(["api", "worker"]);
		expect(parsePm2ListOutput("not json at all")).toEqual([]);
		expect(parsePm2ListOutput("")).toEqual([]);
		expect(parsePm2List(null)).toEqual([]);
		expect(stripAnsi("\u001B[31mred\u001B[39m")).toBe("red");
	});

	it("格式化：字节/时长/状态行/工具行", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(188743680)).toBe("180 MB");
		const now = 1_700_000_000_000 + 3 * 3600_000 + 12 * 60_000;
		expect(formatUptime(1_700_000_000_000, now)).toBe("3h12m");
		expect(formatUptime(now + 1000, now)).toBe("—");
		const status = formatAppStatus(
			{ status: "online", cpu: 12, memory: 188743680, restarts: 3, startedAt: 1_700_000_000_000 },
			now,
		);
		expect(status).toContain("online");
		expect(status).toContain("CPU 12%");
		expect(status).toContain("↻3");
		expect(formatAppStatus({ status: "stopped", restarts: 0 })).toBe("stopped");
		const line = formatAppLine(
			{
				name: "api",
				status: "online",
				pid: 42,
				cpu: 1,
				memory: 1024,
				restarts: 0,
				startedAt: now - 5000,
				script: "/srv/a.js",
			},
			now,
		);
		expect(line).toContain("api [online]");
		expect(line).toContain("script=/srv/a.js");
	});
});

describe("pm2-manager 安装/管理/卸载一体", () => {
	it("安装与卸载命令常量分开：装走 i、卸走 uninstall", () => {
		expect(INSTALL_COMMAND).toBe("npm i -g pm2");
		expect(UNINSTALL_COMMAND).toBe("npm uninstall -g pm2");
		expect(UNINSTALL_COMMAND).not.toBe(INSTALL_COMMAND);
	});

	it("buildPm2StartArgv：拼出 pm2 start 参数，缺 script 时报错", () => {
		const ok = buildPm2StartArgv({ script: "server.js", args: ["--port", "8788"], cwd: "/srv" });
		if (!("argv" in ok)) throw new Error("expected argv");
		expect(ok.appName).toBe("server");
		expect(ok.argv).toEqual(["start", "server.js", "--name", "server", "--cwd", "/srv", "--", "--port", "8788"]);
		const named = buildPm2StartArgv({ name: "api", script: "npm", args: ["run", "dev"] });
		if (!("argv" in named)) throw new Error("expected argv");
		expect(named.argv).toEqual(["start", "npm", "--name", "api", "--", "run", "dev"]);
		const miss = buildPm2StartArgv({ name: "api", script: "  " });
		expect("error" in miss && miss.error).toBeTruthy();
	});
});

describe("pm2-manager activate", () => {
	function activate(settings: Record<string, unknown> = {}) {
		const host = createMockHost({ settings });
		const deactivate = pm2Plugin.activate(host as any);
		cleanups.push(() => deactivate?.());
		return host;
	}

	it("注册 pm2 工具：提示词三处齐备、纯英文、长度合规", () => {
		const host = activate();
		const tools = host.mock.agentTools;
		expect(tools.map((t: any) => t.name)).toEqual(["pm2"]);
		const tool = tools[0] as any;
		expect(tool.description.length).toBeLessThanOrEqual(600);
		expect(/[\u4e00-\u9fff]/.test(tool.description)).toBe(false);
		expect(tool.promptSnippet.length).toBeLessThanOrEqual(80);
		expect(tool.promptSnippet.startsWith("pm2")).toBe(false);
		expect(tool.promptGuidelines.length).toBeGreaterThan(0);
		for (const g of tool.promptGuidelines) {
			expect(g.length).toBeLessThanOrEqual(200);
			expect(/[\u4e00-\u9fff]/.test(g)).toBe(false);
		}
		expect(tool.parameters.properties.action.enum).toContain("start");
		expect(tool.parameters.properties.action.enum).toContain("uninstall");
	});

	it("不接管 bash：不订阅 onToolPre / onToolPost（也不注册后台任务）", () => {
		const host = activate();
		expect(host.calls.some((c) => c.method === "registerBackgroundTask")).toBe(false);
		expect((host.mock.handlers as Record<string, unknown[]>)["onToolPre"] ?? []).toHaveLength(0);
		expect((host.mock.handlers as Record<string, unknown[]>)["onToolPost"] ?? []).toHaveLength(0);
	});

	it("挂上四个 HTTP 路由：安装/管理/卸载一体（/uninstall 新增，/action 支持 start）", () => {
		const host = activate();
		const keys = (host.mock.routes as Array<{ method: string; path: string }>)
			.map((r) => `${r.method} ${r.path}`)
			.sort();
		expect(keys).toEqual(["GET /status", "POST /action", "POST /install", "POST /uninstall"]);
	});

	it("停用后注销工具与路由（不留悬挂项）", () => {
		const host = createMockHost({ settings: {} });
		const deactivate = pm2Plugin.activate(host as any);
		expect(host.mock.agentTools).toHaveLength(1);
		deactivate?.();
		expect(host.mock.agentTools).toHaveLength(0);
		expect(host.mock.routes).toHaveLength(0);
	});
});

describe("pm2-manager /action start", () => {
	it("无名 start 按文件名自动命名，不报非法操作（缺 pm2 时回 pm2 缺失而非拦截）", async () => {
		vi.resetModules();
		vi.doMock("node:child_process", () => ({
			execFile: (
				_cmd: string,
				_args: string[],
				_opts: unknown,
				cb: (e: Error | null, stdout: string, stderr: string) => void,
			) => {
				setImmediate(() => cb(new Error("no pm2 in test"), "", ""));
			},
		}));
		try {
			const { createMockHost: freshHost } = await import("../../plugin-sdk/index.mjs");
			const plugin = (await import("../../plugins/pm2-manager/index.mjs")).default;
			const host = freshHost({ settings: {} });
			const deactivate = plugin.activate(host as any);
			try {
				const route = (host.mock.routes as Array<{ method: string; path: string; handler: any }>).find(
					(r) => r.method === "POST" && r.path === "/action",
				);
				expect(route).toBeDefined();
				const payload = await new Promise<Record<string, unknown>>((resolve) => {
					route!.handler(
						{ body: { action: "start", name: "", script: "server.js", cwd: "", args: "" } },
						{ json: (p: Record<string, unknown>) => resolve(p) },
					);
				});
				// 空名字是合法的（buildPm2StartArgv 会取文件名）：守卫只拦缺 script。
				expect(payload.error).not.toBe("非法操作");
				const bad = await new Promise<Record<string, unknown>>((resolve) => {
					route!.handler(
						{ body: { action: "start", name: "", script: "   ", cwd: "", args: "" } },
						{ json: (p: Record<string, unknown>) => resolve(p) },
					);
				});
				// 空 script 被 buildPm2StartArgv 的具体提示拦下（同样 ok:false，不会走到 pm2）。
				expect(bad.ok).toBe(false);
				expect(String(bad.error)).toContain("script");
			} finally {
				deactivate?.();
			}
		} finally {
			vi.doUnmock("node:child_process");
			vi.resetModules();
		}
	});
});

describe("pm2 探测负缓存（0.103 审计）", () => {
	it("未安装结论 5 分钟内缓存：/status 连续轮询不重复 spawn npm 探测", async () => {
		let execFileCalls = 0;
		vi.resetModules();
		vi.doMock("node:child_process", () => ({
			execFile: (
				_cmd: string,
				_args: string[],
				_opts: unknown,
				cb: (e: Error | null, stdout: string, stderr: string) => void,
			) => {
				execFileCalls++;
				setImmediate(() => cb(new Error("no pm2 in test"), "", ""));
			},
		}));
		try {
			const { createMockHost: freshHost } = await import("../../plugin-sdk/index.mjs");
			const plugin = (await import("../../plugins/pm2-manager/index.mjs")).default;
			const host = freshHost({ settings: {} });
			plugin.activate(host as any);
			const statusRoute = (host.mock.routes as Array<{ method: string; path: string; handler: any }>).find(
				(r) => r.method === "GET" && r.path === "/status",
			);
			expect(statusRoute).toBeDefined();
			const callStatus = () =>
				new Promise<{ installed: boolean }>((resolve) => {
					statusRoute!.handler({}, { json: (p: { installed: boolean }) => resolve(p) });
				});
			const first = await callStatus();
			const spawnsAfterFirst = execFileCalls;
			const second = await callStatus();
			expect(first.installed).toBe(false);
			expect(second.installed).toBe(false);
			expect(execFileCalls).toBe(spawnsAfterFirst);
		} finally {
			vi.doUnmock("node:child_process");
			vi.resetModules();
		}
	});
});
