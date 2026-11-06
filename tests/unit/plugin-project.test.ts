import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject, isInsideRoot, resolveInsideRoot } from "../../server/plugin-project.js";

const hasGit = ((): boolean => {
	try {
		return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
	} catch {
		return false;
	}
})();

let base: string;
let ws: string;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "pi-plugin-project-"));
	ws = join(base, "ws");
	mkdirSync(ws, { recursive: true });
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function gitCli(args: string[], cwd: string) {
	return spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
}

const IDENTITY = [
	"-c",
	"user.email=pi-web-ui-test@example.com",
	"-c",
	"user.name=pi-web-ui-test",
	"-c",
	"commit.gpgsign=false",
];

function makeRepo(name: string, files: Record<string, string>): string {
	const dir = join(base, "repos", name);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(dir, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content, "utf8");
	}
	expect(gitCli(["init", "--quiet"], dir).status).toBe(0);
	expect(gitCli([...IDENTITY, "add", "-A"], dir).status).toBe(0);
	expect(gitCli([...IDENTITY, "commit", "--quiet", "-m", "init"], dir).status).toBe(0);
	return pathToFileURL(dir).href;
}

function readText(p: string): string {
	return readFileSync(p, "utf8").replace(/\r\n/g, "\n");
}

function commitAll(dir: string, message: string): void {
	expect(gitCli([...IDENTITY, "add", "-A"], dir).status).toBe(0);
	expect(gitCli([...IDENTITY, "commit", "--quiet", "-m", message], dir).status).toBe(0);
}

describe("路径判定（纯函数，不需要 git）", () => {
	it("relative() 判定越界；win32 大小写不敏感", () => {
		expect(isInsideRoot(ws, ws)).toBe(true);
		expect(isInsideRoot(ws, join(ws, "a", "b"))).toBe(true);
		expect(isInsideRoot(ws, join(base, "outside"))).toBe(false);
		expect(isInsideRoot(ws, join(ws, ".."))).toBe(false);
		expect(isInsideRoot(ws, ws.toUpperCase())).toBe(process.platform === "win32");
	});

	it("resolveInsideRoot：正常相对路径 → 绝对路径；越界/绝对/空 → null", () => {
		expect(resolveInsideRoot(ws, "a/b.txt")).toBe(join(ws, "a", "b.txt"));
		expect(resolveInsideRoot(ws, "./a/../b.txt")).toBe(join(ws, "b.txt"));
		expect(resolveInsideRoot(ws, "../x")).toBeNull();
		expect(resolveInsideRoot(ws, "a/../../x")).toBeNull();
		expect(resolveInsideRoot(ws, join(base, "abs.txt"))).toBeNull();
		expect(resolveInsideRoot(ws, "")).toBeNull();
		if (process.platform === "win32") {
			expect(resolveInsideRoot(ws, "C:\\Windows\\evil.txt")).toBeNull();
		}
	});
});

describe.skipIf(!hasGit)("组装项目（本地 file:// 仓库，零网络）", () => {
	it("clone 本地仓库到 subdir：文件真的落到 <dir>/<subdir> 下", async () => {
		const url = makeRepo("basic", { "README.md": "# hello\n", "src/index.ts": "export {};\n" });
		const res = await createProject({ dir: ws, repos: [{ url, subdir: "sub" }] });
		expect(res.ok).toBe(true);
		expect(res.error).toBeUndefined();
		expect(res.dir).toBe(ws);
		expect(readText(join(ws, "sub", "README.md"))).toBe("# hello\n");
		expect(existsSync(join(ws, "sub", "src", "index.ts"))).toBe(true);
		expect(res.log).toContain(`clone ${url} → sub`);
	});

	it("repos 缺省 subdir = clone 进根目录本身", async () => {
		const url = makeRepo("atroot", { "a.txt": "a\n" });
		const res = await createProject({ dir: ws, repos: [{ url }] });
		expect(res.ok).toBe(true);
		expect(existsSync(join(ws, "a.txt"))).toBe(true);
		expect(res.log.some((l) => l.startsWith("mkdir"))).toBe(false);
	});

	it("ref 指定分支：clone 出来的是该分支的内容", async () => {
		const url = makeRepo("branches", { "base.txt": "base\n" });
		const repoDir = join(base, "repos", "branches");
		const defaultBranch = gitCli(["rev-parse", "--abbrev-ref", "HEAD"], repoDir).stdout.trim();
		expect(gitCli(["checkout", "--quiet", "-b", "feature"], repoDir).status).toBe(0);
		writeFileSync(join(repoDir, "feature-only.txt"), "feature\n", "utf8");
		commitAll(repoDir, "feature");

		const onFeature = await createProject({ dir: ws, repos: [{ url, subdir: "feat", ref: "feature" }] });
		expect(onFeature.ok).toBe(true);
		expect(existsSync(join(ws, "feat", "feature-only.txt"))).toBe(true);

		const onDefault = await createProject({ dir: ws, repos: [{ url, subdir: "main", ref: defaultBranch }] });
		expect(onDefault.ok).toBe(true);
		expect(existsSync(join(ws, "main", "feature-only.txt"))).toBe(false);
		expect(readText(join(ws, "main", "base.txt"))).toBe("base\n");
	}, 30000);

	it("files 写入：自动建中间目录、内容逐字节正确", async () => {
		const res = await createProject({
			dir: ws,
			files: { ".code-workspace": `{ "folders": [] }\n`, "deep/a/b/中文.txt": "多字节内容 ✓\n" },
		});
		expect(res.ok).toBe(true);
		expect(readFileSync(join(ws, ".code-workspace"), "utf8")).toBe(`{ "folders": [] }\n`);
		expect(readFileSync(join(ws, "deep", "a", "b", "中文.txt"), "utf8")).toBe("多字节内容 ✓\n");
		expect(res.log).toContain("write deep/a/b/中文.txt");
	});

	it("clone + 写文件 + git init 一条龙；进度回调与 log 一致", async () => {
		const url = makeRepo("full", { "a.txt": "a\n" });
		const lines: string[] = [];
		const res = await createProject(
			{ dir: ws, repos: [{ url, subdir: "repo" }], files: { "cfg/app.json": "{}\n" }, gitInit: true },
			{ onProgress: (line) => lines.push(line) },
		);
		expect(res.ok).toBe(true);
		expect(lines).toEqual(res.log);
		expect(res.log).toContain("mkdir repo");
		expect(res.log).toContain("write cfg/app.json");
		expect(res.log).toContain("git init");
		expect(res.log.some((l) => l.startsWith("git: "))).toBe(true);
		expect(existsSync(join(ws, ".git"))).toBe(true);
		expect(existsSync(join(ws, "repo", "a.txt"))).toBe(true);
		expect(readFileSync(join(ws, "cfg", "app.json"), "utf8")).toBe("{}\n");
	});

	it("进度回调抛错不影响组装（UI 层的事不拖累执行）", async () => {
		const res = await createProject(
			{ dir: ws, files: { "a.txt": "a" } },
			{
				onProgress: () => {
					throw new Error("ui boom");
				},
			},
		);
		expect(res.ok).toBe(true);
		expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("a");
	});
});

describe.skipIf(!hasGit)("失败即停（ok:false + 可读原因 + 保留日志）", () => {
	it("clone 不存在的仓库 → ok:false、log 非空、原因可读", async () => {
		const url = pathToFileURL(join(base, "repos", "missing")).href;
		const res = await createProject({ dir: ws, repos: [{ url, subdir: "sub" }] });
		expect(res.ok).toBe(false);
		expect(res.error).toBeTruthy();
		expect(res.error).toMatch(/clone/i);
		expect(res.error?.length ?? 0).toBeGreaterThan(0);
		expect(res.log.length).toBeGreaterThan(0);
		expect(res.log.join("\n")).toContain(`clone ${url} → sub`);
		expect(res.log.join("\n")).toContain("失败：");
	});

	it("多仓库中途失败：前面的成果与日志保留，后面的步骤不再执行", async () => {
		const good = makeRepo("good", { "a.txt": "a\n" });
		const bad = pathToFileURL(join(base, "repos", "missing")).href;
		const res = await createProject({
			dir: ws,
			repos: [
				{ url: good, subdir: "one" },
				{ url: bad, subdir: "two" },
			],
			files: { "cfg/x.json": "{}" },
			gitInit: true,
		});
		expect(res.ok).toBe(false);
		expect(existsSync(join(ws, "one", "a.txt"))).toBe(true);
		expect(res.log.join("\n")).toContain(`clone ${good} → one`);
		expect(existsSync(join(ws, "cfg", "x.json"))).toBe(false);
		expect(existsSync(join(ws, ".git"))).toBe(false);
	});

	it("目标子目录已存在且未给 replace → ok:false，且绝不静默覆盖", async () => {
		const url = makeRepo("exists", { "a.txt": "a\n" });
		mkdirSync(join(ws, "sub"), { recursive: true });
		writeFileSync(join(ws, "sub", "mine.txt"), "我的东西\n", "utf8");
		const res = await createProject({ dir: ws, repos: [{ url, subdir: "sub" }] });
		expect(res.ok).toBe(false);
		expect(res.error).toContain("已存在");
		expect(readFileSync(join(ws, "sub", "mine.txt"), "utf8")).toBe("我的东西\n");
		expect(existsSync(join(ws, "sub", "a.txt"))).toBe(false);
	});

	it("replace:true → 删掉目标再来，旧内容不再残留", async () => {
		const url = makeRepo("replace", { "a.txt": "a\n" });
		mkdirSync(join(ws, "sub"), { recursive: true });
		writeFileSync(join(ws, "sub", "mine.txt"), "old\n", "utf8");
		const res = await createProject({ dir: ws, repos: [{ url, subdir: "sub", replace: true }] });
		expect(res.ok).toBe(true);
		expect(existsSync(join(ws, "sub", "mine.txt"))).toBe(false);
		expect(readText(join(ws, "sub", "a.txt"))).toBe("a\n");
		expect(res.log.join("\n")).toContain("rm -rf sub");
	});

	it("replace 指向项目根目录 → 拒绝（授权只覆盖这个目录，不是「可以删它」）", async () => {
		const url = makeRepo("replaceroot", { "a.txt": "a\n" });
		writeFileSync(join(ws, "keep.txt"), "keep\n", "utf8");
		const res = await createProject({ dir: ws, repos: [{ url, replace: true }] });
		expect(res.ok).toBe(false);
		expect(res.error).toContain("replace");
		expect(readFileSync(join(ws, "keep.txt"), "utf8")).toBe("keep\n");
	});

	it("dir 校验：相对路径 / 不存在 / 不是目录 全部拒绝", async () => {
		const relative = await createProject({ dir: join("relative", "ws"), gitInit: true });
		expect(relative.ok).toBe(false);
		expect(relative.error).toContain("绝对路径");
		expect(relative.log.length).toBeGreaterThan(0);

		const missing = join(base, "not-there");
		const absent = await createProject({ dir: missing, gitInit: true });
		expect(absent.ok).toBe(false);
		expect(absent.error).toContain("不存在");
		expect(existsSync(missing)).toBe(false);

		const asFile = join(base, "file.txt");
		writeFileSync(asFile, "x", "utf8");
		const notDir = await createProject({ dir: asFile, gitInit: true });
		expect(notDir.ok).toBe(false);
		expect(notDir.error).toContain("文件夹");
	});

	it("url / ref 以 '-' 开头（git 选项注入）→ 拒绝", async () => {
		const url = await createProject({ dir: ws, repos: [{ url: "--upload-pack=touch pwned" }] });
		expect(url.ok).toBe(false);
		expect(url.error).toContain("注入");

		const ref = await createProject({ dir: ws, repos: [{ url: "https://example.com/x.git", ref: "-c" }] });
		expect(ref.ok).toBe(false);
		expect(ref.error).toContain("ref");
	});

	it("gitBin 指向不存在的可执行文件 → ok:false、不抛异常", async () => {
		const res = await createProject(
			{ dir: ws, repos: [{ url: "file:///nowhere/repo.git" }] },
			{ gitBin: join(base, "no-such-git-binary") },
		);
		expect(res.ok).toBe(false);
		expect(res.error).toContain("git");
		expect(res.log.length).toBeGreaterThan(0);
	});

	it("gitTimeoutMs 超时 → 杀掉进程树并报「超时」（不挂死）", async () => {
		const url = makeRepo("slow", { "a.txt": "a\n" });
		const res = await createProject({ dir: ws, repos: [{ url, subdir: "sub" }] }, { gitTimeoutMs: 1 });
		expect(res.ok).toBe(false);
		expect(res.error).toContain("超时");
	}, 30000);

	it("files 条目数与单文件大小超限 → 拒绝", async () => {
		const tooMany: Record<string, string> = {};
		for (let i = 0; i < 33; i++) tooMany[`f${i}.txt`] = "x";
		const many = await createProject({ dir: ws, files: tooMany });
		expect(many.ok).toBe(false);
		expect(many.error).toContain("超限");

		const big = await createProject({ dir: ws, files: { "big.txt": "x".repeat(1024 * 1024 + 1) } });
		expect(big.ok).toBe(false);
		expect(big.error).toContain("1MB");

		expect(readdirSync(ws)).toEqual([]);
	});
});

describe.skipIf(!hasGit)("路径越界防护", () => {
	it("files 的 ../ 与绝对路径 key → ok:false，磁盘上没有多出任何文件", async () => {
		const escapeRel = join(base, "evil.txt");
		const escapeAbs = join(base, "abs-evil.txt");
		const res = await createProject({
			dir: ws,
			files: { "../evil.txt": "pwn", [escapeAbs]: "pwn", "ok.txt": "ok" },
		});
		expect(res.ok).toBe(false);
		expect(res.error).toContain("越界");
		expect(existsSync(escapeRel)).toBe(false);
		expect(existsSync(escapeAbs)).toBe(false);
		expect(existsSync(join(ws, "ok.txt"))).toBe(false);
		expect(readdirSync(ws)).toEqual([]);
	});

	it("subdir 越界 → ok:false，且目录内什么都没建出来", async () => {
		const url = makeRepo("escape", { "a.txt": "a\n" });
		const escapeTarget = join(tmpdir(), "pi-plugin-project-escape-x");
		const res = await createProject({ dir: ws, repos: [{ url, subdir: "../../pi-plugin-project-escape-x" }] });
		expect(res.ok).toBe(false);
		expect(res.error).toContain("越界");
		expect(existsSync(escapeTarget)).toBe(false);
		expect(readdirSync(ws)).toEqual([]);
	});

	it("符号链接指向 dir 之外 → 拒绝（realpath 复核，不是字符串比对）", async () => {
		const outside = join(base, "outside");
		mkdirSync(outside, { recursive: true });
		try {
			symlinkSync(outside, join(ws, "link"), process.platform === "win32" ? "junction" : "dir");
		} catch {
			return;
		}

		const viaFile = await createProject({ dir: ws, files: { "link/evil.txt": "pwn" } });
		expect(viaFile.ok).toBe(false);
		expect(viaFile.error).toContain("越界");
		expect(existsSync(join(outside, "evil.txt"))).toBe(false);

		const url = makeRepo("linkrepo", { "a.txt": "a\n" });
		const viaRepo = await createProject({ dir: ws, repos: [{ url, subdir: "link/sub" }] });
		expect(viaRepo.ok).toBe(false);
		expect(viaRepo.error).toContain("越界");
		expect(existsSync(join(outside, "sub"))).toBe(false);
	});
});
