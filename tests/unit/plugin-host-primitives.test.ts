import { describe, expect, it } from "vitest";
import { resolve, join, posix } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createMockHost } from "../../plugin-sdk/index.mjs";
import { PluginManager, type PluginHost } from "../../server/plugins.js";

describe("插件宿主平台原语单测 (PluginHost Primitives)", () => {
	it("resolveInWorkspace() 正确放行工作区内路径并拦截跨界访问（抛出 403）", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-test-host-primitives-"));
		try {
			const host = createMockHost({ cwd: tempDir });

			// 1. 工作区内合法路径与根路径
			const validRel = "src/index.ts";
			const validAbs = host.resolveInWorkspace(validRel);
			expect(validAbs).toBe(resolve(tempDir, validRel));

			const rootAbs = host.resolveInWorkspace(".");
			expect(rootAbs).toBe(resolve(tempDir));

			// 2. 路径遍历逃逸（如 ../../secret）必须抛出 403 异常
			expect(() => {
				host.resolveInWorkspace("../../secret.txt");
			}).toThrowError(/工作区/);

			try {
				host.resolveInWorkspace("../../secret.txt");
				expect.unreachable();
			} catch (err: any) {
				expect(err.statusCode).toBe(403);
			}
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// mock 的 resolveInWorkspace 用零依赖解析实现（SDK 得能在浏览器 import，不能顶格 import
	// node:path）——这组断言把重写的解析器钉在 node:path 的语义上。
	it("mock 的 resolveInWorkspace 与 node:path resolve 语义一致", () => {
		const inside = ["a.txt", "./a.txt", "src/index.ts", "deep/nested/x.md", "a/../b.txt", "sub/./../b.txt", "sub/", ""];
		const escapes = ["..", "../../..", "../../secret.txt", "/etc/passwd", "//etc/passwd", "/workspace-2/x.txt"];
		for (const root of ["/workspace", "/workspace/", resolve(tmpdir(), "pi-parity")]) {
			const host = createMockHost({ cwd: root });
			const resolver = root.startsWith("/") ? posix.resolve : resolve;
			for (const c of inside) {
				expect(host.resolveInWorkspace(c)).toBe(resolver(root, c));
			}
			expect(host.resolveInWorkspace(".")).toBe(resolver(root));
			for (const c of escapes) {
				expect(() => host.resolveInWorkspace(c)).toThrowError(/工作区/);
			}
			// resolve(root,"..") 等于根时不能当「区内」放行：同级目录不是自己
			if (resolver(root, "..") !== resolver(root)) {
				expect(() => host.resolveInWorkspace("..")).toThrowError(/工作区/);
			}
		}
	});

	it("工作区根设为系统根（POSIX / 或 Windows 盘符根）时正常放行区内文件", () => {
		const posixRoot = createMockHost({ cwd: "/" });
		expect(posixRoot.resolveInWorkspace("a.txt")).toBe("/a.txt");
		expect(posixRoot.resolveInWorkspace("src/index.ts")).toBe("/src/index.ts");
		expect(posixRoot.resolveInWorkspace(".")).toBe("/");

		const winRoot = createMockHost({ cwd: "C:\\" });
		expect(winRoot.resolveInWorkspace("a.txt")).toBe("C:\\a.txt");
		expect(winRoot.resolveInWorkspace("src\\index.ts")).toBe("C:\\src\\index.ts");
		expect(winRoot.resolveInWorkspace(".")).toBe("C:\\");
		expect(() => winRoot.resolveInWorkspace("D:\\other.txt")).toThrowError(/工作区/);
	});

	// 越出工作区（POSIX / 盘符 / UNC）一律 403，分隔符保持根风格。
	it("Windows 盘符与 UNC 根保持分隔符且拦越界", () => {
		const drive = createMockHost({ cwd: "C:\\work\\proj" });
		expect(drive.resolveInWorkspace("src\\a.ts")).toBe("C:\\work\\proj\\src\\a.ts");
		// 根内的 `..` 归一放行，跨出根则拦（与 node:path 的 resolve + 越界 403 同语义）
		expect(drive.resolveInWorkspace("C:\\work\\proj\\src\\..\\a.ts")).toBe("C:\\work\\proj\\a.ts");
		expect(() => drive.resolveInWorkspace("C:\\work\\proj\\..\\other\\b.ts")).toThrowError(/工作区/);
		expect(drive.resolveInWorkspace(".")).toBe("C:\\work\\proj");
		expect(() => drive.resolveInWorkspace("C:\\other\\secret.txt")).toThrowError(/工作区/);

		const unc = createMockHost({ cwd: "\\\\nas\\share\\proj" });
		expect(unc.resolveInWorkspace("doc.md")).toBe("\\\\nas\\share\\proj\\doc.md");
		expect(() => unc.resolveInWorkspace("..\\..\\escape.txt")).toThrowError(/工作区/);
	});

	it("真实 PluginManager 宿主：resolveInWorkspace 支持多根工作区且越界 403", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-real-host-test-"));
		const extraRoot = join(tempDir, "extra-root");
		mkdirSync(extraRoot, { recursive: true });

		let capturedHost: PluginHost | null = null;
		const pdir = join(tempDir, "plugins", "test-jail");
		mkdirSync(pdir, { recursive: true });
		writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: "test-jail" }));
		writeFileSync(join(pdir, "index.mjs"), `export default { activate(h) { globalThis.__testHost = h; } };`);

		const mgr = new PluginManager(tempDir, tempDir);
		try {
			// 注入多根工作区
			mgr.notifyWorkspaceRoots([extraRoot]);
			await mgr.ensureLoaded();
			capturedHost = (globalThis as any).__testHost;
			expect(capturedHost).toBeDefined();

			// 主工作区路径
			const mainFile = capturedHost!.resolveInWorkspace("hello.txt");
			expect(mainFile).toBe(resolve(tempDir, "hello.txt"));

			// 额外根工作区路径（多根工作区原生支持）
			const extraFile = capturedHost!.resolveInWorkspace(join(extraRoot, "extra.txt"));
			expect(extraFile).toBe(resolve(extraRoot, "extra.txt"));

			// 越界路径抛 403
			expect(() => {
				capturedHost!.resolveInWorkspace(resolve(tempDir, "../escape.txt"));
			}).toThrowError(/工作区/);

			try {
				capturedHost!.resolveInWorkspace(resolve(tempDir, "../escape.txt"));
				expect.unreachable();
			} catch (e: any) {
				expect(e.statusCode).toBe(403);
			}
		} finally {
			delete (globalThis as any).__testHost;
			mgr.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("host.fetch() 记录调用并正常发起请求", async () => {
		const host = createMockHost();
		let called = false;
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = (async (url: any) => {
				called = true;
				return new Response(JSON.stringify({ ok: true }));
			}) as any;

			const res = await host.fetch("https://example.com/api");
			expect(called).toBe(true);
			expect(res.ok).toBe(true);
			expect(host.calls.some((c) => c.method === "fetch")).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
