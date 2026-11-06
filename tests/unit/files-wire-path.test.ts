import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesService, isAbsoluteWirePath, workspacePath } from "../../server/files-service.js";
import type { ServerMessage } from "../../server/protocol.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "piweb-wirepath-test-"));
	dirs.push(dir);
	return dir;
}

describe("isAbsoluteWirePath", () => {
	it("通用形态：机器根 / posix 绝对 / UNC 斜杠形式 / 相对", () => {
		expect(isAbsoluteWirePath("@root")).toBe(true);
		expect(isAbsoluteWirePath("/etc/passwd")).toBe(true);
		expect(isAbsoluteWirePath("//host/share")).toBe(true);
		expect(isAbsoluteWirePath("a/b")).toBe(false);
		expect(isAbsoluteWirePath("")).toBe(false);
	});
	describe.skipIf(process.platform !== "win32")("win32 专属", () => {
		it("盘符绝对、裸盘符、盘符相对路径（冒号后无分隔符）都判绝对", () => {
			expect(isAbsoluteWirePath("C:/Users/x")).toBe(true);
			expect(isAbsoluteWirePath("C:\\Users\\x")).toBe(true);
			expect(isAbsoluteWirePath("C:")).toBe(true);
			expect(isAbsoluteWirePath("D:x")).toBe(true);
		});
		it("反斜杠 UNC 判绝对", () => {
			expect(isAbsoluteWirePath("\\\\host\\share")).toBe(true);
		});
		it("workspacePath 拒绝盘符相对 / UNC / 跨盘目标", () => {
			const root = tempRoot();
			expect(workspacePath(root, "D:x")).toBeNull();
			expect(workspacePath(root, "\\\\host\\share")).toBeNull();
			expect(workspacePath(root, "//host/share")).toBeNull();
			expect(workspacePath(root, `${root[0] === "C" ? "D" : "C"}:/Windows`)).toBeNull();
		});
	});
	describe.skipIf(process.platform === "win32")("posix 专属", () => {
		it('posix 上 "C:x" 是合法相对文件名，不算绝对 wire 路径', () => {
			expect(isAbsoluteWirePath("C:x")).toBe(false);
		});
	});
});

describe("workspacePath", () => {
	it("工作区内相对路径照常解析（跨平台回归）", () => {
		const root = tempRoot();
		const wp = workspacePath(root, "sub/file.txt");
		expect(wp).not.toBeNull();
		expect(wp!.rel).toBe("sub/file.txt");
		expect(wp!.abs.toLowerCase().startsWith(root.toLowerCase())).toBe(true);
	});
	it('".." 逃逸照旧拒绝（跨平台回归）', () => {
		const root = tempRoot();
		expect(workspacePath(root, "../escape.txt")).toBeNull();
		expect(workspacePath(root, "a/../../escape.txt")).toBeNull();
	});
	describe.skipIf(process.platform !== "win32")("win32 跨盘 relative 返回绝对路径", () => {
		it("拒绝其它盘符的绝对目标", () => {
			const root = tempRoot();
			const other = `${root[0] === "C" ? "D" : "C"}:\\somewhere`;
			expect(workspacePath(root, other)).toBeNull();
		});
	});
});

function makeService(cwd: string) {
	const seen: ServerMessage[] = [];
	const svc = new FilesService({
		emit: (m) => void seen.push(m),
		isDisposed: () => false,
		getCwd: () => cwd,
		getActiveCwd: () => cwd,
	});
	return { svc, seen };
}

describe("uploadFile 文件名与覆盖语义", () => {
	it("尾点 / 纯点文件名拒绝", async () => {
		const cwd = tempRoot();
		const { svc, seen } = makeService(cwd);
		const data = Buffer.from("hi").toString("base64");
		await svc.uploadFile("", "a..", data);
		await svc.uploadFile("", "..", data);
		const errs = seen.filter((m) => m.type === "notice" && m.level === "error");
		expect(errs.length).toBe(2);
		expect(existsSync(join(cwd, "a.."))).toBe(false);
	});

	it.skipIf(process.platform !== "win32")("Windows 保留名拒绝", async () => {
		const cwd = tempRoot();
		const { svc, seen } = makeService(cwd);
		await svc.uploadFile("", "con.txt", Buffer.from("hi").toString("base64"));
		const errs = seen.filter((m) => m.type === "notice" && m.level === "error");
		expect(errs.length).toBe(1);
		expect(existsSync(join(cwd, "con.txt"))).toBe(false);
	});

	it("目标已存在时拒绝而不是静默覆盖（与 file-transfer 路由同语义）", async () => {
		const cwd = tempRoot();
		const { svc, seen } = makeService(cwd);
		writeFileSync(join(cwd, "a.txt"), "keep");
		await svc.uploadFile("", "a.txt", Buffer.from("overwritten").toString("base64"));
		const errs = seen.filter((m) => m.type === "notice" && m.level === "error");
		expect(errs.length).toBe(1);
		expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("keep");
	});

	it("正常上传照常工作", async () => {
		const cwd = tempRoot();
		const { svc, seen } = makeService(cwd);
		await svc.uploadFile("sub", "b.txt", Buffer.from("hello").toString("base64"));
		expect(readFileSync(join(cwd, "sub", "b.txt"), "utf8")).toBe("hello");
		const errs = seen.filter((m) => m.type === "notice" && m.level === "error");
		expect(errs.length).toBe(0);
	});
});

describe("searchFiles 支持相对路径和绝对路径匹配", () => {
	it("支持相对路径检索与直接路径匹配", async () => {
		const cwd = tempRoot();
		const subDir = join(cwd, "nested", "deep");
		mkdirSync(subDir, { recursive: true });
		writeFileSync(join(subDir, "target.txt"), "content");
		const { svc, seen } = makeService(cwd);

		await svc.searchFiles("nested/deep", 101);
		const res1 = seen.find((m) => m.type === "search_files_result" && m.reqId === 101) as any;
		expect(res1).toBeDefined();
		expect(res1.ok).toBe(true);
		expect(res1.results.some((r: any) => r.path === "nested/deep/target.txt")).toBe(true);

		const absFile = join(subDir, "target.txt");
		await svc.searchFiles(absFile, 102);
		const res2 = seen.find((m) => m.type === "search_files_result" && m.reqId === 102) as any;
		expect(res2).toBeDefined();
		expect(res2.ok).toBe(true);
		expect(res2.results.some((r: any) => r.name === "target.txt")).toBe(true);
	});
});
