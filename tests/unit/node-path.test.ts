import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { augmentNodePath, hasNodeRuntime, resolveNodeDirs, type NodePathOptions } from "../../server/node-path.js";

const windows = process.platform === "win32";
const nodeBin = windows ? "node.exe" : "node";
const npmBin = windows ? "npm.cmd" : "npm";
// `server/native-cli-discovery.ts` 的 posix 候选里有这些系统目录，而 CI 机器上它们确实装着
// node/npm —— 不先把它们放进 PATH，断言就会跟着宿主环境漂移（Linux runner 上必红）。
const SYSTEM_DIRS = windows ? [] : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/snap/bin"];
const basePath = (extra: string[] = []) => [...extra, join(root, "system"), ...SYSTEM_DIRS].join(delimiter);

let root: string;
let options: NodePathOptions;

function install(directory: string, names: string[] = [nodeBin, npmBin]): string {
	mkdirSync(directory, { recursive: true });
	for (const name of names) writeFileSync(join(directory, name), "fixture", { mode: 0o755 });
	return directory;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-node-path-"));
	// 只给一份空环境：不读本机真实的 fnm / nvm / 用户 PATH，测试结果与开发机无关。
	options = { env: { PATH: basePath() }, homeDir: root, nodeExecutable: join(root, "runtime", nodeBin) };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("node PATH augmentation", () => {
	it("prepends the version-manager node directory the shell profile would have added", () => {
		// fnm 当前 shell 的目录：只有交互式 shell 里才在 PATH 上（后台任务 `bash -c` 拿不到 → 127）。
		const multishell = install(join(root, "fnm-multishell"));
		options.env = { ...options.env, FNM_MULTISHELL_PATH: multishell };
		expect(augmentNodePath(options)).toEqual([multishell]);
		expect(options.env!.PATH).toBe(basePath([multishell]));
	});
	it("skips candidate directories that hold no node/npm", () => {
		install(join(root, ".local", "bin"), ["some-cli"]);
		expect(augmentNodePath(options)).toEqual([]);
		expect(options.env!.PATH).toBe(basePath());
	});
	it("never duplicates a directory that is already on PATH", () => {
		const multishell = install(join(root, "fnm-multishell"));
		options.env = {
			PATH: basePath([multishell]),
			FNM_MULTISHELL_PATH: multishell,
		};
		expect(augmentNodePath(options)).toEqual([]);
	});
	it("is idempotent across repeated startup calls", () => {
		const multishell = install(join(root, "fnm-multishell"));
		options.env = { ...options.env, FNM_MULTISHELL_PATH: multishell };
		expect(augmentNodePath(options)).toHaveLength(1);
		expect(augmentNodePath(options)).toEqual([]);
	});
	it("prefers the persistent fnm versions newest-first when no multishell path is exported", () => {
		// fnm 的真实布局：posix 下二进制在 `<store>/<version>/installation/bin`，Windows 下直接是 `installation`。
		const fnmInstall = (version: string) =>
			install(join(root, "fnm", "node-versions", version, ...(windows ? ["installation"] : ["installation", "bin"])));
		const oldVersion = fnmInstall("v18.0.0");
		const newVersion = fnmInstall("v22.11.0");
		options.env = { ...options.env, FNM_DIR: join(root, "fnm") };
		expect(resolveNodeDirs(options).slice(0, 2)).toEqual([newVersion, oldVersion]);
	});
	it("finds the runtime directory of the running node without any PATH entry", () => {
		const runtime = install(join(root, "runtime"));
		expect(resolveNodeDirs(options)).toContain(runtime);
	});
	it("keeps existing PATH entries intact and in order after the prepended dirs", () => {
		const multishell = install(join(root, "fnm-multishell"));
		const extra = join(root, "first-on-path");
		options.env = { PATH: basePath([extra]), FNM_MULTISHELL_PATH: multishell };
		augmentNodePath(options);
		expect(options.env!.PATH).toBe(basePath([multishell, extra]));
	});
	it("detects node runtimes by file presence, not by directory name", () => {
		expect(hasNodeRuntime(install(join(root, "anything")))).toBe(true);
		expect(hasNodeRuntime(install(join(root, "empty"), []))).toBe(false);
	});
});
