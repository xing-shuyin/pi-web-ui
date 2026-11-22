import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { isInsideRoots, isInsideRootsLexical, realPathOrNearest } from "../../server/path-boundary.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
	base: string;
	workspace: string;
	outside: string;
	/** 工作区里指向区外的 junction/symlink（建不出来时为 false：某些平台/权限下不允许）。 */
	linkable: boolean;
}

function fixture(): Fixture {
	const base = mkdtempSync(join(tmpdir(), "pi-path-boundary-"));
	roots.push(base);
	const workspace = join(base, "workspace");
	const outside = join(base, "outside");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, "secret.txt"), "top secret");
	let linkable = true;
	try {
		symlinkSync(outside, join(workspace, "link"), process.platform === "win32" ? "junction" : "dir");
	} catch {
		linkable = false;
	}
	return { base, workspace, outside, linkable };
}

describe("realPathOrNearest：目标不存在时用最近存在祖先的 realpath + 剩余段", () => {
	it("不存在的叶子拼在最近存在祖先的真实路径后面", () => {
		const { workspace } = fixture();
		const leaf = join(workspace, "missing", "deeper", "file.txt");
		expect(realPathOrNearest(leaf)).toBe(join(realPathOrNearest(workspace), "missing", "deeper", "file.txt"));
	});

	it("保留原始 `..` 的 OS 解析顺序（先跟随链接再上跳，而不是先折叠）", () => {
		const { workspace, outside, linkable } = fixture();
		if (!linkable) return;
		// OS 语义：workspace/link -> outside，再 `..` 就到了 outside 的父目录。
		const raw = `${workspace}${sep}link${sep}..${sep}secret.txt`;
		const resolved = realPathOrNearest(raw);
		expect(resolved).not.toBe(join(workspace, "secret.txt"));
		expect(realPathOrNearest(join(outside, "..", "secret.txt"))).toBe(resolved);
	});
});

describe("isInsideRoots：两侧都按真实路径比较", () => {
	it("区内普通路径 / 根本身 / 相对路径放行", () => {
		const { workspace } = fixture();
		expect(isInsideRoots(join(workspace, "src", "index.ts"), [workspace])).toBe(true);
		expect(isInsideRoots(workspace, [workspace])).toBe(true);
		expect(isInsideRoots("src/index.ts", [workspace], workspace)).toBe(true);
		expect(isInsideRoots("", [workspace], workspace)).toBe(true);
	});

	it("区外路径与 `..` 越界拒绝", () => {
		const { workspace } = fixture();
		expect(isInsideRoots(join(workspace, "..", "outside", "secret.txt"), [workspace])).toBe(false);
		expect(isInsideRoots("../outside/secret.txt", [workspace], workspace)).toBe(false);
		expect(isInsideRoots("/etc/passwd", [workspace])).toBe(false);
	});

	it("大小写不敏感的文件系统上大小写/分隔符归一后仍判定为区内", () => {
		const { workspace } = fixture();
		// 行为由**文件系统**决定，不是由平台名决定：Linux/大小写敏感的 APFS 上 `WORKSPACE` 就是另一个目录，
		// 写成 `process.platform === "win32"` 会在 CI 的 ubuntu 上直接红。
		writeFileSync(join(workspace, "CaseProbe.txt"), "x");
		const caseInsensitive = existsSync(join(workspace, "caseprobe.txt"));
		const upper = workspace.toUpperCase().replace(/\\/g, "/");
		expect(isInsideRoots(upper, [workspace])).toBe(caseInsensitive);
		expect(isInsideRoots(join(workspace, "a", "b.txt"), [workspace.toUpperCase()])).toBe(caseInsensitive);
	});

	it("区内链接指向区外时判为区外（#972 junction 穿透）", () => {
		const { workspace, outside, linkable } = fixture();
		if (!linkable) return;
		expect(isInsideRoots(join(workspace, "link"), [workspace])).toBe(false);
		expect(isInsideRoots(join(workspace, "link", "secret.txt"), [workspace])).toBe(false);
	});

	it("`link/../x` 不能靠折叠绕过（折叠会算成 workspace/x）", () => {
		const { workspace, linkable } = fixture();
		if (!linkable) return;
		const raw = `${workspace}${sep}link${sep}..${sep}secret.txt`;
		// 词法折叠的结果确实在区内 —— 正是旧实现的洞；真实路径在区外，必须判外。
		expect(join(workspace, "link", "..", "secret.txt")).toBe(join(workspace, "secret.txt"));
		expect(isInsideRoots(raw, [workspace])).toBe(false);
	});

	it("不存在的工作区外叶子路径不被当成区外空白（按最近存在祖先判）", () => {
		const { workspace, outside } = fixture();
		expect(isInsideRoots(join(outside, "nope", "x.txt"), [workspace])).toBe(false);
		expect(isInsideRoots(join(workspace, "nope", "x.txt"), [workspace])).toBe(true);
	});

	it("多个根任一个命中即放行", () => {
		const { workspace, outside } = fixture();
		expect(isInsideRoots(join(outside, "data.json"), [workspace, outside])).toBe(true);
		expect(isInsideRoots(join(outside, "data.json"), [workspace])).toBe(false);
	});

	it("根自身是链接时按 realpath 比较（链接路径下的目标仍算区内）", () => {
		const { workspace, linkable } = fixture();
		if (!linkable) return;
		// workspace/link -> outside：把「链接路径」当根，则区外真实目录就是它的区。
		expect(isInsideRoots(join(workspace, "link", "secret.txt"), [join(workspace, "link")])).toBe(true);
	});
});

describe("isInsideRootsLexical：只用于远程虚拟路径（不做本地 realpath）", () => {
	const remoteRoot = "/project/game-share";

	it("远程相对/绝对路径按 POSIX 词法判定", () => {
		expect(isInsideRootsLexical("src/index.ts", [remoteRoot], remoteRoot)).toBe(true);
		expect(isInsideRootsLexical("/project/game-share/README.md", [remoteRoot])).toBe(true);
		expect(isInsideRootsLexical(remoteRoot, [remoteRoot])).toBe(true);
		expect(isInsideRootsLexical(".", [remoteRoot], remoteRoot)).toBe(true);
	});

	it("越界与同级前缀不误判", () => {
		expect(isInsideRootsLexical("/etc/passwd", [remoteRoot])).toBe(false);
		expect(isInsideRootsLexical("../../etc/passwd", [remoteRoot], remoteRoot)).toBe(false);
		expect(isInsideRootsLexical("/project/game-share-other/x", [remoteRoot])).toBe(false);
		expect(isInsideRootsLexical("/project/game-share", ["/project/game-share/"])).toBe(true);
	});
});
