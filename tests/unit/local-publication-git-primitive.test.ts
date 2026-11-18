import { describe, expect, it } from "vitest";
import type { RunGitResult } from "../../server/git-run.js";
import { publicationExitFrom, PublicationStopUnconfirmedError } from "../../server/device-center/local-publication.js";

/** 发布协议的 git 原语已收敛到 `git-run` 单源；这里锁住「失败关闭」的映射规则。 */
function result(overrides: Partial<RunGitResult> = {}): RunGitResult {
	return {
		ok: true,
		code: 0,
		signal: null,
		stdout: "out",
		stderr: "",
		timedOut: false,
		aborted: false,
		...overrides,
	};
}

describe("publicationExitFrom：单源结果 → 发布协议结果", () => {
	it("正常结束：原样透传 code/signal/stdout/stderr，不带 error", () => {
		const exit = publicationExitFrom(result({ stdout: " abc \n" }));
		expect(exit).toEqual({ code: 0, signal: null, stdout: " abc \n", stderr: "" });
		expect("error" in exit).toBe(false);
	});

	it("停不下来（unstopped）→ 抛 PublicationStopUnconfirmedError（fail-closed）", () => {
		expect(() => publicationExitFrom(result({ code: null, timedOut: true, unstopped: true }))).toThrow(
			PublicationStopUnconfirmedError,
		);
		// 只有 timedOut 不算「停止未确认」：进程确实停下来了就照常返回
		const stopped = publicationExitFrom(result({ code: null, timedOut: true }));
		expect(stopped.code).toBe(null);
		expect(stopped.error).toBeUndefined();
	});

	it("输出超限被杀 → 带回 error（调用方据此判失败）", () => {
		const exit = publicationExitFrom(result({ ok: false, code: null, overflowed: true }));
		expect(exit.error?.message).toMatch(/exceeded bound/);
	});

	it("起不来（spawnError）→ 带回 error", () => {
		const exit = publicationExitFrom(result({ ok: false, code: null, spawnError: "spawn git ENOENT" }));
		expect(exit.error?.message).toMatch(/ENOENT/);
	});

	it("被信号终止时保留 signal 字段（checkedGit 靠它判失败）", () => {
		const exit = publicationExitFrom(result({ ok: false, code: null, signal: "SIGKILL" }));
		expect(exit).toMatchObject({ code: null, signal: "SIGKILL" });
	});
});
