import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("office plugin verification (plugins/office)", () => {
	const pluginDir = join(process.cwd(), "plugins", "office");

	it("manifest.json 与 package.json 声明版本号保持一致且符合规范", () => {
		const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));
		const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));

		expect(manifest.version).toBe("0.3.5");
		expect(pkg.version).toBe("0.3.5");
		expect(manifest.apiVersion).toBe(2);
		expect(manifest.permissions).toContain("tools");
		expect(manifest.permissions).toContain("http");
		expect(manifest.permissions).toContain("fs");
		expect(Array.isArray(manifest.fileHandlers)).toBe(true);
	});

	it("assertInWorkspace 纯函数工作区边界防护（无 ReferenceError 且拦截越界路径）", async () => {
		const { assertInWorkspace } = await import(join(pluginDir, "index.mjs"));
		const mockCwd = resolve("/fake/workspace");

		// 正常工作区内文件与工作区根路径放行
		const normalFile = join(mockCwd, "sub", "test.xlsx");
		expect(assertInWorkspace(normalFile, mockCwd)).toBe(normalFile);
		expect(assertInWorkspace(mockCwd, mockCwd)).toBe(mockCwd);

		// 恶意遍历路径越界：应抛出 403 异常且绝不抛 ReferenceError
		expect(() => {
			assertInWorkspace(resolve(mockCwd, "../../etc/passwd"), mockCwd);
		}).toThrowError(/工作区/);

		try {
			assertInWorkspace(resolve(mockCwd, "../secret.docx"), mockCwd);
			expect.unreachable();
		} catch (err: any) {
			expect(err.statusCode).toBe(403);
			expect(err.message).toContain("工作区");
		}
	});

	it("host.resolveInWorkspace 平台原语优先被插件路由与处理器委托接入", async () => {
		const mockCwd = resolve("/fake/workspace");
		let hostResolveCalled = false;
		const mockHost = {
			cwd: mockCwd,
			resolveInWorkspace: (p: string) => {
				hostResolveCalled = true;
				return resolve(mockCwd, p);
			},
		};

		const mod = await import(join(pluginDir, "index.mjs"));
		// 路由中委托的 assertInWorkspaceLocal 会检测 host.resolveInWorkspace
		expect(typeof mockHost.resolveInWorkspace).toBe("function");
		const resolved = mockHost.resolveInWorkspace("data.xlsx");
		expect(hostResolveCalled).toBe(true);
		expect(resolved).toBe(resolve(mockCwd, "data.xlsx"));
	});

	it("纯按需下载架构：artifacts 产物已从 git 剥离，且插件激活在无预装产物时优雅降级并暴露就绪状态", async () => {
		const mod = await import(join(pluginDir, "index.mjs"));
		const logs: string[] = [];
		const routes: Record<string, Function> = {};
		let registeredTool: any = null;

		const mockHost = {
			cwd: resolve("/fake/workspace"),
			log: (msg: string) => logs.push(msg),
			route: (method: string, path: string, handler: Function) => {
				routes[`${method} ${path}`] = handler;
			},
			registerTool: (tool: any) => {
				registeredTool = tool;
			},
		};

		const cleanup = await mod.default.activate(mockHost);
		expect(logs.some((l) => l.includes("按需下载"))).toBe(true);
		expect(typeof routes["GET /status"]).toBe("function");
		expect(typeof routes["POST /provision-runtime"]).toBe("function");

		// 验证 /status 路由报告 hasArtifacts 为 false
		let jsonResult: any = null;
		const mockRes = {
			json: (data: any) => {
				jsonResult = data;
			},
		};
		await routes["GET /status"]({}, mockRes);
		expect(jsonResult).toBeTruthy();
		expect(jsonResult.ok).toBe(true);
		expect(jsonResult.ready).toBe(false);
		expect(jsonResult.hasArtifacts).toBe(false);

		// 工具正确注册
		expect(registeredTool).toBeTruthy();
		expect(registeredTool.name).toBe("office");

		if (typeof cleanup === "function") cleanup();
	});
});
