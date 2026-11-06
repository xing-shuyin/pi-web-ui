import { describe, expect, it } from "vitest";
import { resolve, join, parse, sep } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createMockHost } from "../../plugin-sdk/testing.mjs";
import { PluginManager, type PluginHost } from "../../server/plugins.js";

describe("插件宿主平台原语单测 (PluginHost Primitives)", () => {
	it("resolveInWorkspace() 正确放行工作区内路径并拦截跨界访问（抛出 403）", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-test-host-primitives-"));
		try {
			const host = createMockHost({ cwd: tempDir });

			const validRel = "src/index.ts";
			const validAbs = host.resolveInWorkspace(validRel);
			expect(validAbs).toBe(resolve(tempDir, validRel));

			const rootAbs = host.resolveInWorkspace(".");
			expect(rootAbs).toBe(resolve(tempDir));

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

	it("mock 使用平台原生路径解析，并拒绝同名前缀的兄弟目录", () => {
		const inside = ["a.txt", "./a.txt", "src/index.ts", "deep/nested/x.md", "a/../b.txt", "sub/./../b.txt", "sub/", ""];
		const workspace = resolve(tmpdir(), "pi-parity");
		for (const root of [workspace, workspace + sep, "./relative-workspace"]) {
			const host = createMockHost({ cwd: root });
			for (const candidate of [...inside, resolve(root, "absolute.txt")]) {
				expect(host.resolveInWorkspace(candidate)).toBe(resolve(root, candidate));
			}
			expect(host.resolveInWorkspace(".")).toBe(resolve(root));
			for (const candidate of ["..", "../../..", "../../secret.txt", resolve(resolve(root) + "-other", "x.txt")]) {
				expect(() => host.resolveInWorkspace(candidate)).toThrowError(expect.objectContaining({ statusCode: 403 }));
			}
		}
	});

	it("工作区根设为本机系统根时正常放行区内文件", () => {
		const root = parse(resolve(tmpdir())).root;
		const host = createMockHost({ cwd: root });
		for (const candidate of ["a.txt", "src/index.ts", ".", "..", ""]) {
			expect(host.resolveInWorkspace(candidate)).toBe(resolve(root, candidate));
		}
	});

	it.skipIf(process.platform === "win32")("POSIX 反斜杠是文件名字符，遵守原生路径语义", () => {
		const host = createMockHost({ cwd: "/work/proj" });
		for (const candidate of ["src\\a.ts", "..\\outside.txt", "C:notes.txt", "C:\\notes.txt"]) {
			expect(host.resolveInWorkspace(candidate)).toBe(resolve("/work/proj", candidate));
		}
	});

	it.skipIf(process.platform !== "win32")("Windows 盘符、盘符相对路径与 UNC 使用原生解析且拦越界", () => {
		const drive = createMockHost({ cwd: "C:\\work\\proj" });
		for (const candidate of ["src\\a.ts", "C:src\\a.ts", "C:\\work\\proj\\src\\..\\a.ts", "."]) {
			expect(drive.resolveInWorkspace(candidate)).toBe(resolve("C:\\work\\proj", candidate));
		}
		for (const candidate of ["C:\\work\\proj\\..\\other\\b.ts", "C:\\other\\secret.txt", "D:\\other.txt"]) {
			expect(() => drive.resolveInWorkspace(candidate)).toThrowError(expect.objectContaining({ statusCode: 403 }));
		}
		const unc = createMockHost({ cwd: "\\\\nas\\share\\proj" });
		expect(unc.resolveInWorkspace("doc.md")).toBe(resolve("\\\\nas\\share\\proj", "doc.md"));
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
			mgr.notifyWorkspaceRoots([extraRoot]);
			await mgr.ensureLoaded();
			capturedHost = (globalThis as any).__testHost;
			expect(capturedHost).toBeDefined();

			const mainFile = capturedHost!.resolveInWorkspace("hello.txt");
			expect(mainFile).toBe(resolve(tempDir, "hello.txt"));

			const extraFile = capturedHost!.resolveInWorkspace(join(extraRoot, "extra.txt"));
			expect(extraFile).toBe(resolve(extraRoot, "extra.txt"));

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
