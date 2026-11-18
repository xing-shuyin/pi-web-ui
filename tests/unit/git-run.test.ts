import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	GIT_DEFAULT_TIMEOUT_MS,
	gitEnv,
	gitFailureMessage,
	runGit,
	runGitText,
	stripGitEnv,
} from "../../server/git-run.js";

const dirs: string[] = [];
function tempRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "pwu-git-run-"));
	dirs.push(dir);
	execFileSync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const hasGit = (() => {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true });
		return true;
	} catch {
		return false;
	}
})();

describe.skipIf(!hasGit)("runGit：git 调用单源", () => {
	it("成功命令返回 trim 后的 stdout", async () => {
		const cwd = tempRepo();
		expect(await runGitText(["rev-parse", "--is-inside-work-tree"], { cwd })).toBe("true");
	});

	it("默认带 -c core.quotepath=false：中文路径不被转义", async () => {
		const cwd = tempRepo();
		writeFileSync(join(cwd, "中文文件.txt"), "x\n");
		const status = await runGitText(["status", "--porcelain"], { cwd });
		expect(status).toContain("中文文件.txt");
		expect(status).not.toContain("\\344");
	});

	it("失败时抛出的消息取 stderr 首行", async () => {
		const cwd = tempRepo();
		const result = await runGit(["rev-parse", "--verify", "no-such-ref"], { cwd });
		expect(result.ok).toBe(false);
		expect(gitFailureMessage(result)).toMatch(/no-such-ref|Needed a single revision|unknown revision/i);
		await expect(runGitText(["rev-parse", "--verify", "no-such-ref"], { cwd })).rejects.toThrow();
	});

	it("config 追加的 -c 生效（硬化参数不靠调用点各写一遍）", async () => {
		const cwd = tempRepo();
		const out = await runGitText(["config", "core.hooksPath"], { cwd, config: ["core.hooksPath=/dev/null"] });
		expect(out).toBe("/dev/null");
	});

	it("input 写进 stdin（git hash-object --stdin）", async () => {
		const cwd = tempRepo();
		const sha = await runGitText(["hash-object", "--stdin"], { cwd, input: "hello\n" });
		expect(sha).toMatch(/^[0-9a-f]{40,64}$/);
	});

	it("cleanEnv 清掉继承的 GIT_* 后仍能正常工作", async () => {
		const cwd = tempRepo();
		const out = await runGitText(["rev-parse", "--is-inside-work-tree"], {
			cwd,
			cleanEnv: true,
			env: { GIT_TERMINAL_PROMPT: "0" },
		});
		expect(out).toBe("true");
	});

	it("超时与取消都走杀树，不会把调用方挂住", async () => {
		const cwd = tempRepo();
		const result = await runGit(["gc", "--prune=now", "--quiet"], { cwd, timeoutMs: 1 });
		expect(result.ok).toBe(false);
		expect(result.timedOut || result.code !== 0).toBe(true);
	});
});

describe("gitEnv / stripGitEnv：环境变量不再各写一遍", () => {
	it("gitEnv 带上禁提示的硬化变量，且可叠加额外值", () => {
		const env = gitEnv({ GIT_INDEX_FILE: "/tmp/x" });
		expect(env.GIT_TERMINAL_PROMPT).toBe("0");
		expect(env.GCM_INTERACTIVE).toBe("never");
		expect(env.GIT_INDEX_FILE).toBe("/tmp/x");
	});

	it("stripGitEnv 删掉全部 GIT_*，其他变量保持", () => {
		const env = stripGitEnv({ ...process.env, GIT_DIR: "/bogus", GIT_INDEX_FILE: "/bogus", PWU_KEEP: "1" });
		expect(Object.keys(env).some((key) => /^GIT_/i.test(key))).toBe(false);
		expect(env.PWU_KEEP).toBe("1");
	});

	it("默认超时是 15s（原来 6 份常量各写一遍）", () => {
		expect(GIT_DEFAULT_TIMEOUT_MS).toBe(15_000);
	});
});
