import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneDirNames } from "../../plugins/sftp/lib/ignore.mjs";
import {
	BATCH_MIN_FILES,
	parseFindOutput,
	readTarStream,
	scanRemoteViaFind,
	shellQuote,
	tarHeader,
	tarStream,
} from "../../plugins/sftp/lib/engine.mjs";
const cleanups: (() => void)[] = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "sftp-fast-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

async function collect(source: AsyncIterable<Buffer>) {
	const parts: Buffer[] = [];
	let maxChunk = 0;
	for await (const c of source) {
		parts.push(c);
		maxChunk = Math.max(maxChunk, c.length);
	}
	return { buffer: Buffer.concat(parts), maxChunk };
}

async function* chunksOf(buf: Buffer, size: number) {
	for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

async function streamEntries(source: AsyncIterable<Buffer>, opts: { skip?: string[]; maxBytes?: number } = {}) {
	const out = new Map<string, Buffer>();
	const res = await readTarStream(source, {
		maxBytes: opts.maxBytes,
		onEntry: async (entry: { name: string }) => {
			if (opts.skip?.includes(entry.name)) return null;
			const parts: Buffer[] = [];
			return {
				write: async (c: Buffer) => void parts.push(c),
				close: async () => void out.set(entry.name, Buffer.concat(parts)),
			};
		},
	});
	return { res, out };
}

function readTar(buf: Buffer) {
	const out: { name: string; size: number; data: Buffer }[] = [];
	let off = 0;
	let zeroBlocks = 0;
	while (off + 512 <= buf.length) {
		const h = buf.subarray(off, off + 512);
		if (!h.some((b) => b !== 0)) {
			zeroBlocks++;
			off += 512;
			continue;
		}
		const str = (o: number, len: number) => {
			const raw = h.subarray(o, o + len);
			const end = raw.indexOf(0);
			return raw.subarray(0, end < 0 ? raw.length : end).toString("utf8");
		};
		const stored = parseInt(str(148, 8).trim(), 8);
		const clone = Buffer.from(h);
		clone.fill(0x20, 148, 156);
		let sum = 0;
		for (const b of clone) sum += b;
		expect(sum, `checksum 必须是头内容（chksum 位置算 8 个空格）的和`).toBe(stored);
		expect(str(257, 6)).toBe("ustar");
		expect(String.fromCharCode(h[156] ?? 0)).toBe("0");
		const size = parseInt(str(124, 12).trim() || "0", 8);
		const prefix = str(345, 155);
		const name = str(0, 100);
		off += 512;
		out.push({ name: prefix ? `${prefix}/${name}` : name, size, data: Buffer.from(buf.subarray(off, off + size)) });
		off += Math.ceil(size / 512) * 512;
	}
	return { entries: out, zeroBlocks };
}

describe("readTarStream（流式解包）", () => {
	it("与自写的写入口径对得上；给再碎的 chunk 也能拼回来", async () => {
		const dir = tempDir();
		const big = Buffer.alloc(777, 0x62);
		writeFileSync(join(dir, "a.txt"), "hi");
		writeFileSync(join(dir, "big.bin"), big);
		const { buffer } = await collect(
			tarStream([
				{ rel: "a.txt", abs: join(dir, "a.txt"), size: 2, mtime: 0 },
				{ rel: "sub/big.bin", abs: join(dir, "big.bin"), size: big.length, mtime: 0 },
			]),
		);
		const { res, out } = await streamEntries(chunksOf(buffer, 100));
		expect(res.ok).toBe(true);
		expect([...out.keys()]).toEqual(["a.txt", "sub/big.bin"]);
		expect(out.get("a.txt")?.toString("utf8")).toBe("hi");
		expect(out.get("sub/big.bin")?.equals(big)).toBe(true);
	});

	it("不要的成员只读掉不落盘，后面的成员仍然对齐（跳过不能把流带偏）", async () => {
		const dir = tempDir();
		for (const n of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(dir, n), `内容-${n}`);
		const { buffer } = await collect(
			tarStream(
				["a.txt", "b.txt", "c.txt"].map((n) => ({
					rel: n,
					abs: join(dir, n),
					size: Buffer.byteLength(`内容-${n}`),
					mtime: 0,
				})),
			),
		);
		const { res, out } = await streamEntries(chunksOf(buffer, 64), { skip: ["b.txt"] });
		expect(res.ok).toBe(true);
		expect([...out.keys()]).toEqual(["a.txt", "c.txt"]);
		expect(out.get("c.txt")?.toString("utf8")).toBe("内容-c.txt");
	});

	it("checksum 被改过 → 拒绝（远端/中简改一个字节就不能信）", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "a.txt"), "hi");
		const { buffer } = await collect(tarStream([{ rel: "a.txt", abs: join(dir, "a.txt"), size: 2, mtime: 0 }]));
		const bad = Buffer.from(buffer);
		bad[0] = 0x62;
		const { res } = await streamEntries(chunksOf(bad, 100));
		expect(res.ok).toBe(false);
	});

	it("不是 ustar / 正文被截断 → 拒绝，而不是把半截内容当文件交出去", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "a.txt"), "hello");
		const { buffer } = await collect(tarStream([{ rel: "a.txt", abs: join(dir, "a.txt"), size: 5, mtime: 0 }]));
		const { res: cut } = await streamEntries(chunksOf(buffer.subarray(0, 512 + 3), 100));
		expect(cut.ok).toBe(false);
		const { res: notTar } = await streamEntries(chunksOf(Buffer.alloc(1024, 0x41), 100));
		expect(notTar.ok).toBe(false);
	});

	it("空流当零个文件（不算失败）；超过 maxBytes 直接报错", async () => {
		const { res } = await streamEntries(chunksOf(Buffer.alloc(0), 100));
		expect(res).toEqual({ ok: true, entries: [] });
		const dir = tempDir();
		writeFileSync(join(dir, "a.txt"), "x".repeat(2048));
		const { buffer } = await collect(tarStream([{ rel: "a.txt", abs: join(dir, "a.txt"), size: 2048, mtime: 0 }]));
		await expect(streamEntries(chunksOf(buffer, 100), { maxBytes: 1024 })).rejects.toThrow(/超过上限/);
	});
});

describe("pruneDirNames：哪些规则能直接交给 find -prune", () => {
	it("只收纯目录名，取反/带斜杠/带通配符的一律留给 JS 判定", () => {
		expect(pruneDirNames(["node_modules", "dist/", "*.log", "!keep", "src/tmp", "**", ".git", "a?b"])).toEqual([
			"node_modules",
			"dist",
			".git",
		]);
	});

	it("空值与内部护栏名字不重复登记", () => {
		expect(pruneDirNames(["", "  ", "dist", "dist"])).toEqual(["dist"]);
	});
});

describe("shellQuote", () => {
	it("普通路径包单引号，含单引号的路径正确转义", () => {
		expect(shellQuote("/srv/app")).toBe("'/srv/app'");
		expect(shellQuote("/srv/it's")).toBe("'/srv/it'\\''s'");
	});
});

describe("tarHeader / tarStream（流式打包）", () => {
	it("产出的是**流**：没有一个 chunk 是整包；内容能被独立读取器解回", async () => {
		const dir = tempDir();
		const small = Buffer.from("hello");
		const big = Buffer.alloc(1200, 0x61);
		writeFileSync(join(dir, "a.txt"), small);
		writeFileSync(join(dir, "big.bin"), big);
		const { buffer, maxChunk } = await collect(
			tarStream(
				[
					{ rel: "a.txt", abs: join(dir, "a.txt"), size: small.length, mtime: 1700000000 },
					{ rel: "sub/big.bin", abs: join(dir, "big.bin"), size: big.length, mtime: 1700000000 },
				],
				{ chunkSize: 512 },
			),
		);
		expect(maxChunk).toBeLessThanOrEqual(1024);
		expect(maxChunk).toBeLessThan(buffer.length);
		const { entries, zeroBlocks } = readTar(buffer);
		expect(entries.map((e) => e.name)).toEqual(["a.txt", "sub/big.bin"]);
		expect(entries[0]?.data.toString("utf8")).toBe("hello");
		expect(entries[1]?.size).toBe(1200);
		expect(entries[1]?.data.equals(big)).toBe(true);
		expect(zeroBlocks).toBe(2);
	});

	it("打包期间被改动（字节数与计划不符）→ 抛错，让整批回落逐文件", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "a.txt"), "12345");
		await expect(collect(tarStream([{ rel: "a.txt", abs: join(dir, "a.txt"), size: 99, mtime: 0 }]))).rejects.toThrow(
			/打包期间被改动/,
		);
	});

	it("长路径在 / 处切成 prefix + name（ustar 正道），装不下就只能拒收", () => {
		const longDir = "d".repeat(80);
		const rel = `${longDir}/${"n".repeat(90)}.txt`;
		const head = tarHeader({ name: rel, size: 1, mtime: 0 });
		expect(head).not.toBeNull();
		expect(head?.length).toBe(512);
		const parsed = readTar(Buffer.concat([head as Buffer, Buffer.from("x"), Buffer.alloc(511), Buffer.alloc(1024)]));
		expect(parsed.entries[0]?.name).toBe(rel);

		expect(tarHeader({ name: "x".repeat(120), size: 1, mtime: 0 })).toBeNull();
		expect(BATCH_MIN_FILES).toBeGreaterThan(1);
	});
});
describe("parseFindOutput", () => {
	it("NUL 分隔：文件名里的换行不会把它拆坏", () => {
		const out = "f\t12\t1700000000\twe\nird.txt\0f\t3\t1700000000\ta.txt\0";
		expect(parseFindOutput(out)?.records.map((r) => r.rel)).toEqual(["we\nird.txt", "a.txt"]);
	});

	it("不认 \\0 的服务端退化为按行切，仍然能解析", () => {
		const out = "f\t12\t1700000000\ta.txt\nf\t3\t1700000000\tb/c.txt\n";
		expect(parseFindOutput(out)?.records.map((r) => r.rel)).toEqual(["a.txt", "b/c.txt"]);
	});

	it("字段数不对 → null（宁可不快，也不能猜）", () => {
		expect(parseFindOutput("f\t12\ta.txt\n")).toBeNull();
	});

	it("空输出是「零个文件」，不是失败", () => {
		expect(parseFindOutput("")).toEqual({ records: [] });
	});
});

describe("scanRemoteViaFind", () => {
	function fakeExec(stdout: string, { code = 0, truncated = false, stderr = "" } = {}) {
		const calls: { cmd: string; opts: unknown }[] = [];
		const exec = async (cmd: string, opts: unknown) => {
			calls.push({ cmd, opts });
			return { code, stdout, stderr, truncated };
		};
		return { exec, calls };
	}

	it("命令形状：把内部护栏与纯目录名的 ignore 规则翻译成 -prune", async () => {
		const { exec, calls } = fakeExec("f\t3\t1700000000\ta.txt\0");
		const out = await scanRemoteViaFind(exec, "/srv/app/", () => false, { pruneNames: ["node_modules", "*.log"] });
		expect(out.ok).toBe(true);
		const cmd = calls[0]?.cmd ?? "";
		expect(cmd.startsWith("find '/srv/app' ")).toBe(true);
		expect(cmd).toContain("-name '.sftp-trash'");
		expect(cmd).toContain("-name '.sftp-tmp*'");
		expect(cmd).toContain("-name 'node_modules'");
		expect(cmd).not.toContain("*.log");
		expect(cmd).toContain("-printf");
		expect(cmd.endsWith("'")).toBe(true);
	});

	it("解析出文件；目录项、内部护栏、ignore、越界名字一律不要", async () => {
		const rows = [
			"f\t3\t1700000000\ta.txt",
			"d\t4096\t1700000000\tsub",
			"f\t1\t1700000000\t.sftp-trash/2024/x.txt",
			"f\t1\t1700000000\t.sftp-tmp-stage-1/a.txt",
			"f\t1\t1700000000\t../../etc/passwd",
			"f\t1\t1700000000\tnode_modules/pkg/index.js",
			"f\t9\t1700000000\tsrc/main.ts",
		]
			.map((r) => `${r}\0`)
			.join("");
		const { exec } = fakeExec(rows);
		const ignore = (rel: string) => rel.startsWith("node_modules");
		const out = await scanRemoteViaFind(exec, "/srv/app", ignore);
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		const found = out.files as Map<string, { size: number; path: string; mtime: number | null }>;
		expect([...found.keys()].sort()).toEqual(["a.txt", "src/main.ts"]);
		expect(found.get("src/main.ts")?.size).toBe(9);
		expect(found.get("src/main.ts")?.path).toBe("/srv/app/src/main.ts");
		expect(out.via).toBe("find");
	});

	it("mtime 非数字 → 记成「远端没给 mtime」（与 readdir 路径同一口径）", async () => {
		const { exec } = fakeExec("f\t3\t?\ta.txt\0");
		const out = await scanRemoteViaFind(exec, "/srv/app", () => false);
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect((out.files as Map<string, { mtime: number | null }>).get("a.txt")?.mtime).toBeNull();
		expect(out.mtimeMissing).toBe(true);
	});

	it("退出码非 0 / 输出被截断 / 解析不了 → ok:false（调用方回落逐目录扫描）", async () => {
		const bad = await scanRemoteViaFind(fakeExec("", { code: 1, stderr: "find: not found" }).exec, "/srv", () => false);
		expect(bad).toEqual({ ok: false, reason: "find: not found" });
		const cut = await scanRemoteViaFind(fakeExec("f\t3\t1\ta.txt\0", { truncated: true }).exec, "/srv", () => false);
		expect(cut.ok).toBe(false);
		const garbled = await scanRemoteViaFind(fakeExec("garbage\n").exec, "/srv", () => false);
		expect(garbled.ok).toBe(false);
	});

	it("已经取消的信号：直接抛，不当成「快扫失败」吞掉", async () => {
		const { exec, calls } = fakeExec("f\t3\t1\ta.txt\0");
		await expect(
			scanRemoteViaFind(exec, "/srv", () => false, { signal: AbortSignal.abort(new Error("停下了")) }),
		).rejects.toThrow(/停下了/);
		expect(calls).toHaveLength(0);
	});
});
