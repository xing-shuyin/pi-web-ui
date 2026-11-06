import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLAIM_FILES_TOOL_NAME, makeClaimFilesTool, type ClaimFilesHost } from "../../server/claim-files-tool.js";
import { ClaimStore } from "../../server/claim-store.js";

const CWD = resolve("/repo/proj");

function setup(self: { convId: string; title: string } = { convId: "cA", title: "对话A" }) {
	const dir = mkdtempSync(join(tmpdir(), "claimtool-"));
	const store = new ClaimStore(join(dir, "claims.json"));
	const host: ClaimFilesHost = {
		cwd: () => CWD,
		self: () => self,
		store: () => store,
	};
	const tool = makeClaimFilesTool(host, () => "zh");
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const ctx = {} as any;
	const run = async (params: Record<string, unknown>) => {
		const r = (await tool.execute("t1", params, undefined, undefined, ctx)) as {
			content: { type: string; text: string }[];
			details: unknown;
		};
		return { text: r.content[0].text, details: r.details };
	};
	return { dir, store, run };
}

describe("claim_files", () => {
	it("工具名 + 默认 list 为空", async () => {
		const { dir, run } = setup();
		try {
			expect(
				makeClaimFilesTool({ cwd: () => CWD, self: () => ({ convId: "c", title: "t" }), store: () => undefined }).name,
			).toBe(CLAIM_FILES_TOOL_NAME);
			const r = await run({});
			expect(r.text).toContain("暂无认领");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("claim → list 看到；冲突先到先得；release 全放", async () => {
		const dir = mkdtempSync(join(tmpdir(), "claimtool-"));
		try {
			const store = new ClaimStore(join(dir, "claims.json"));
			const mk = (self: { convId: string; title: string }) => {
				const tool = makeClaimFilesTool({ cwd: () => CWD, self: () => self, store: () => store }, () => "zh");
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const ctx = {} as any;
				return async (params: Record<string, unknown>) => {
					const r = (await tool.execute("t1", params, undefined, undefined, ctx)) as {
						content: { type: string; text: string }[];
					};
					return r.content[0].text;
				};
			};
			const runA = mk({ convId: "cA", title: "对话A" });
			const runB = mk({ convId: "cB", title: "对话B" });
			expect(await runA({ action: "claim", paths: ["a.ts"], note: "改登录" })).toContain("已认领 1 个");
			const l = await runA({ action: "list" });
			expect(l).toContain("a.ts");
			expect(l).toContain("对话A");
			const grab = await runB({ action: "claim", paths: ["a.ts"] });
			expect(grab).toContain("已被别人认领");
			expect(await runB({ action: "release", paths: ["a.ts"] })).toContain("没有你名下");
			expect(await runA({ action: "release" })).toContain("已释放");
			expect(await runA({ action: "list" })).toContain("暂无认领");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("逃逸路径拒绝；坏 action 报错；store 未接线降级", async () => {
		const { dir, run } = setup();
		try {
			const bad = await run({ action: "claim", paths: ["../evil.ts"] });
			expect(bad.text).toContain("不在项目目录内");
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const badAction = await run({ action: "nope" } as any);
			expect(badAction.text).toContain("action 非法");
			const noStore = makeClaimFilesTool(
				{ cwd: () => CWD, self: () => ({ convId: "c", title: "t" }), store: () => undefined },
				() => "zh",
			);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const r = (await noStore.execute("t1", { action: "list" }, undefined, undefined, {} as any)) as {
				content: { type: string; text: string }[];
			};
			expect(r.content[0].text).toContain("暂不可用");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
