import { describe, expect, it } from "vitest";
import { renameRemote } from "../../plugins/sftp/lib/engine.mjs";

function makeSftp(opts: { renameFail?: (from: string, to: string) => boolean; exists?: Record<string, boolean> }) {
	const calls: Array<{ method: string; args: string[] }> = [];
	const sftp = {
		rename(from: string, to: string, cb: (e: Error | null) => void) {
			calls.push({ method: "rename", args: [from, to] });
			if (opts.renameFail?.(from, to)) setImmediate(() => cb(new Error("rename failed")));
			else setImmediate(() => cb(null));
		},
		unlink(p: string, cb: (e: Error | null) => void) {
			calls.push({ method: "unlink", args: [p] });
			setImmediate(() => cb(null));
		},
		stat(p: string, cb: (e: Error | null, st?: object) => void) {
			calls.push({ method: "stat", args: [p] });
			if (opts.exists?.[p]) setImmediate(() => cb(null, { size: 1, isFile: true }));
			else setImmediate(() => cb(new Error("No such file")));
		},
	};
	return { sftp, calls };
}

describe("renameRemote 安全覆盖路径（0.103 审计）", () => {
	it("首次 rename 成功：零额外调用，不 stat/unlink", async () => {
		const { sftp, calls } = makeSftp({});
		await renameRemote(sftp, "/a", "/b");
		expect(calls).toEqual([{ method: "rename", args: ["/a", "/b"] }]);
	});

	it("瞬时失败且目标不存在：原样抛出且不删目标（老实现会无条件 unlink）", async () => {
		const { sftp, calls } = makeSftp({ renameFail: () => true, exists: {} });
		await expect(renameRemote(sftp, "/a", "/b")).rejects.toThrowError("rename failed");
		expect(calls.some((c) => c.method === "unlink")).toBe(false);
		expect(calls.some((c) => c.method === "stat")).toBe(true);
	});

	it("目标存在（覆盖场景）：目标先挪备份、改名成功后清备份", async () => {
		const { sftp, calls } = makeSftp({
			renameFail: (from, to) =>
				from === "/a" && to === "/b" && calls.filter((c) => c.method === "rename" && c.args[0] === "/a").length <= 1,
			exists: { "/b": true },
		});
		await renameRemote(sftp, "/a", "/b");
		expect(calls[0]).toEqual({ method: "rename", args: ["/a", "/b"] });
		expect(calls[1]).toEqual({ method: "stat", args: ["/b"] });
		expect(calls[2]?.method).toBe("rename");
		expect(calls[2]?.args[0]).toBe("/b");
		expect(calls[2]?.args[1]).toMatch(/^\/b\.pi-ren-bak-/);
		expect(calls[3]).toEqual({ method: "rename", args: ["/a", "/b"] });
		expect(calls[4]?.method).toBe("unlink");
		expect(calls[4]?.args[0]).toBe(calls[2]?.args[1]);
	});

	it("覆盖时第二次 rename 也失败：备份改回原名，目标内容不丢", async () => {
		const { sftp, calls } = makeSftp({ renameFail: (from) => from === "/a", exists: { "/b": true } });
		await expect(renameRemote(sftp, "/a", "/b")).rejects.toThrowError("rename failed");
		const bakCall = calls.find((c) => c.method === "rename" && /^\/b\.pi-ren-bak-/.test(c.args[0]));
		expect(bakCall).toBeDefined();
		expect(calls[calls.length - 1]).toEqual({ method: "rename", args: [bakCall!.args[0], "/b"] });
	});
});
