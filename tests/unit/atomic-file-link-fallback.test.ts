import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 注入硬链接故障：队列里每项只作用于下一次 link 调用，用来模拟「文件系统不支持硬链接」的各种错误码。
const faults = vi.hoisted(() => ({
	linkSync: [] as string[],
	link: [] as string[],
	copySync: 0,
	copy: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		linkSync: (from: Parameters<typeof actual.linkSync>[0], to: Parameters<typeof actual.linkSync>[1]) => {
			const injected = faults.linkSync.shift();
			if (injected) throw Object.assign(new Error(`injected ${injected}`), { code: injected });
			return actual.linkSync(from, to);
		},
		copyFileSync: (...args: Parameters<typeof actual.copyFileSync>) => {
			faults.copySync++;
			return actual.copyFileSync(...args);
		},
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		link: async (from: Parameters<typeof actual.link>[0], to: Parameters<typeof actual.link>[1]) => {
			const injected = faults.link.shift();
			if (injected) throw Object.assign(new Error(`injected ${injected}`), { code: injected });
			return actual.link(from, to);
		},
		copyFile: (...args: Parameters<typeof actual.copyFile>) => {
			faults.copy++;
			return actual.copyFile(...args);
		},
	};
});

import { LINK_UNSUPPORTED_CODES, publishFileExclusive, publishFileExclusiveSync } from "../../server/atomic-file.js";
import { persistContextEvidence } from "../../server/context-evidence.js";
import { createPublicationJournal, readPublicationJournal } from "../../server/device-center/publication-journal.js";
import { publicationFixture } from "../helpers/publish-intent-fixture.js";
import { writeUploadExclusiveSync } from "../../server/uploads.js";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-link-fallback-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	faults.linkSync.length = 0;
	faults.link.length = 0;
	faults.copySync = 0;
	faults.copy = 0;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// 取同步抛出错误的 code：比 toThrow 的对象匹配更直白，失败信息里也直接给出实际码。
function thrownCode(fn: () => unknown): string | undefined {
	try {
		fn();
	} catch (error) {
		return (error as NodeJS.ErrnoException).code;
	}
	throw new Error("expected the call to throw");
}

describe("exclusive publish primitive", () => {
	it("硬链接可用时零拷贝发布，且不替调用方删临时文件", () => {
		const dir = tempDir();
		const temp = join(dir, "staged");
		const dest = join(dir, "final");
		writeFileSync(temp, "payload");

		expect(publishFileExclusiveSync(temp, dest)).toBe("link");
		expect(readFileSync(dest, "utf8")).toBe("payload");
		expect(existsSync(temp)).toBe(true);
		expect(faults.copySync).toBe(0);
	});

	it("目标已存在时抛 EEXIST 而不是覆盖", () => {
		const dir = tempDir();
		const temp = join(dir, "staged");
		const dest = join(dir, "final");
		writeFileSync(temp, "new");
		writeFileSync(dest, "old");

		expect(thrownCode(() => publishFileExclusiveSync(temp, dest))).toBe("EEXIST");
		expect(readFileSync(dest, "utf8")).toBe("old");
	});

	it("硬链接不可用（EACCES）时降级为排他复制，语义不变", () => {
		const dir = tempDir();
		const temp = join(dir, "staged");
		const dest = join(dir, "final");
		writeFileSync(temp, "payload");
		faults.linkSync.push("EACCES");

		expect(publishFileExclusiveSync(temp, dest)).toBe("copy");
		expect(readFileSync(dest, "utf8")).toBe("payload");
		// 与 link 一致：成功后临时文件留给调用方的 finally 清理。
		expect(existsSync(temp)).toBe(true);
		expect(faults.copySync).toBe(1);
	});

	it("降级到复制后目标已存在同样是 EEXIST，不静默覆盖", () => {
		const dir = tempDir();
		const temp = join(dir, "staged");
		const dest = join(dir, "final");
		writeFileSync(temp, "new");
		writeFileSync(dest, "old");
		faults.linkSync.push("EACCES");

		expect(thrownCode(() => publishFileExclusiveSync(temp, dest))).toBe("EEXIST");
		expect(readFileSync(dest, "utf8")).toBe("old");
	});

	it("非「硬链接不可用」错误照常抛出，不拿降级掩盖真实故障", () => {
		const dir = tempDir();
		const temp = join(dir, "staged");
		const dest = join(dir, "final");
		writeFileSync(temp, "payload");
		for (const code of ["ENOENT", "ENOSPC", "EIO"]) {
			faults.linkSync.push(code);
			expect(thrownCode(() => publishFileExclusiveSync(temp, dest))).toBe(code);
		}
		expect(faults.copySync).toBe(0);
		expect(existsSync(dest)).toBe(false);
	});

	it("异步版与同步版同一契约", async () => {
		const dir = tempDir();
		const temp = join(dir, "staged");
		const dest = join(dir, "final");
		const rejected = join(dir, "rejected");
		await writeFile(temp, "payload");
		await writeFile(join(dir, "existing"), "old");

		expect(await publishFileExclusive(temp, dest)).toBe("link");
		expect(await readFile(dest, "utf8")).toBe("payload");
		await expect(publishFileExclusive(temp, dest)).rejects.toMatchObject({ code: "EEXIST" });

		faults.link.push("EACCES");
		expect(await publishFileExclusive(temp, rejected)).toBe("copy");
		expect(await readFile(rejected, "utf8")).toBe("payload");
		expect(faults.copy).toBe(1);

		faults.link.push("EACCES");
		await expect(publishFileExclusive(temp, dest)).rejects.toMatchObject({ code: "EEXIST" });
		expect(await readFile(dest, "utf8")).toBe("payload");

		faults.link.push("ENOENT");
		await expect(publishFileExclusive(temp, join(dir, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(faults.copy).toBe(2);
	});

	it("不支持码清单与瞬时码清单分开维护", () => {
		expect(LINK_UNSUPPORTED_CODES).toEqual(["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"]);
	});
});

describe("调用点：硬链接不可用时仍能独占发布", () => {
	it("网页上传在 link 报 EACCES 时照常落盘并清掉暂存文件", () => {
		const dir = tempDir();
		const dest = join(dir, "123-upload.txt");
		faults.linkSync.push("EACCES");

		writeUploadExclusiveSync(dest, Buffer.from("uploaded"));

		expect(readFileSync(dest, "utf8")).toBe("uploaded");
		// 暂存文件由现有的 finally 清理，目录里只剩发布后的目标文件。
		expect(readdirSync(dir)).toEqual(["123-upload.txt"]);
		// 确认真的走了降级分支，而不是恰好没碰到 link。
		expect(faults.copySync).toBe(1);
	});

	it("证据快照在 link 报 EACCES 时照常持久化", async () => {
		const dir = tempDir();
		const sessionFile = join(dir, "session.jsonl");
		await writeFile(sessionFile, "");
		const text = "evidence line\n".repeat(2000);
		faults.link.push("EACCES");

		const target = await persistContextEvidence(sessionFile, text);

		expect(target).toBeTruthy();
		expect(await readFile(target!, "utf8")).toBe(text);
		expect((await readdir(join(dir, "session.jsonl.evidence"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(faults.copy).toBe(1);
	});

	it("发布日志在 link 报 EACCES 时照常写入，且重复创建不覆盖已有日志", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "pi-link-fallback-journal-"));
		dirs.push(dataDir);
		const { intent } = publicationFixture();
		const repository = {
			repoRoot: join(dataDir, "repo"),
			commonDir: join(dataDir, "repo", ".git"),
			repositoryId: intent.repositoryId,
			objectFormat: intent.objectFormat,
		};
		faults.link.push("EACCES");

		const journal = await createPublicationJournal(dataDir, intent, repository);
		expect(journal.phase).toBe("prepared");
		expect(await readPublicationJournal(dataDir, intent)).toMatchObject({ hash: journal.hash });
		expect(faults.copy).toBe(1);
	});
});
