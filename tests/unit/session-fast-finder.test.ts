/**
 * session-fast-finder.test.ts
 *
 * 验证 findMostRecentSessionFileFast:
 * 1. 空目录 / 不存在目录安全返回 undefined；
 * 2. 毫秒级按 mtime 定位最新 .jsonl 文件，无需调用 SessionManager.list 全量解析；
 * 3. 当指定 targetCwd 时，仅读取首行 header 过滤匹配该 cwd 的最新会话；
 * 4. 忽略非 .jsonl 文件。
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { findMostRecentSessionFileFast } from "../../server/session-parser.js";

let tmpDirs: string[] = [];

async function makeTmpDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `pi-fast-finder-${prefix}-`));
	tmpDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const d of tmpDirs) {
		await rm(d, { recursive: true, force: true }).catch(() => {});
	}
	tmpDirs = [];
});

describe("findMostRecentSessionFileFast", () => {
	it("不存在或空的目录返回 undefined", async () => {
		expect(await findMostRecentSessionFileFast("/non/existent/path")).toBeUndefined();
		const emptyDir = await makeTmpDir("empty");
		expect(await findMostRecentSessionFileFast(emptyDir)).toBeUndefined();
	});

	it("忽略非 .jsonl 文件并按 mtime 正确返回最新会话", async () => {
		const dir = await makeTmpDir("mtime-test");
		const f1 = join(dir, "session-old.jsonl");
		const f2 = join(dir, "session-new.jsonl");
		const nonJsonl = join(dir, "notes.txt");

		const header1 = JSON.stringify({ type: "session", id: "s1", cwd: "/proj" }) + "\n";
		const header2 = JSON.stringify({ type: "session", id: "s2", cwd: "/proj" }) + "\n";

		await writeFile(f1, header1, "utf8");
		await writeFile(f2, header2, "utf8");
		await writeFile(nonJsonl, "some notes", "utf8");

		// 设置 f1 为过去的时间，f2 为更新的时间
		const now = Date.now() / 1000;
		await utimes(f1, now - 100, now - 100);
		await utimes(f2, now, now);
		await utimes(nonJsonl, now + 10, now + 10);

		const result = await findMostRecentSessionFileFast(dir);
		expect(result).toBe(f2);
	});

	it("根据 targetCwd 仅探测首行匹配对应项目的最新会话", async () => {
		const dir = await makeTmpDir("multi-project");
		const projA_old = join(dir, "projA-old.jsonl");
		const projA_new = join(dir, "projA-new.jsonl");
		const projB_newest = join(dir, "projB-newest.jsonl");

		const headA1 = JSON.stringify({ type: "session", id: "a1", cwd: "/workspace/project-alpha" }) + "\n";
		const headA2 = JSON.stringify({ type: "session", id: "a2", cwd: "/workspace/project-alpha" }) + "\n";
		const headB = JSON.stringify({ type: "session", id: "b1", cwd: "/workspace/project-beta" }) + "\n";

		await writeFile(projA_old, headA1, "utf8");
		await writeFile(projA_new, headA2, "utf8");
		await writeFile(projB_newest, headB, "utf8");

		const now = Date.now() / 1000;
		await utimes(projA_old, now - 200, now - 200);
		await utimes(projA_new, now - 100, now - 100);
		await utimes(projB_newest, now, now); // projB 是整个目录最新的

		// 若不带 targetCwd，返回最新的 projB
		expect(await findMostRecentSessionFileFast(dir)).toBe(projB_newest);

		// 若带 targetCwd 为 project-alpha，忽略虽然更新但属于 projB 的文件，精确返回 projA_new
		const resultAlpha = await findMostRecentSessionFileFast(dir, "/workspace/project-alpha");
		expect(resultAlpha).toBe(projA_new);

		// 验证 project-beta 得到 projB_newest
		const resultBeta = await findMostRecentSessionFileFast(dir, "/workspace/project-beta");
		expect(resultBeta).toBe(projB_newest);
	});

	it("传入工作区目录时自动解析物理存储目录中的会话", async () => {
		const workdir = await makeTmpDir("workspace");
		const storageDir = await makeTmpDir("storage");
		const prev = process.env.PI_CODING_AGENT_SESSION_DIR;
		try {
			process.env.PI_CODING_AGENT_SESSION_DIR = storageDir;
			const sessionFile = join(storageDir, "session-resolved.jsonl");
			const header = JSON.stringify({ type: "session", id: "s-res", cwd: workdir }) + "\n";
			await writeFile(sessionFile, header, "utf8");

			const result = await findMostRecentSessionFileFast(workdir, workdir);
			expect(result).toBe(sessionFile);
		} finally {
			if (prev !== undefined) {
				process.env.PI_CODING_AGENT_SESSION_DIR = prev;
			} else {
				delete process.env.PI_CODING_AGENT_SESSION_DIR;
			}
		}
	});

	it("PI_CODING_AGENT_SESSION_DIR 设为根目录时优先返回项目子目录中更新的会话（issue #711）", async () => {
		const agentDir = await makeTmpDir("agent");
		const workdir = await makeTmpDir("workspace");
		const sessionsRoot = join(agentDir, "sessions");
		await mkdir(sessionsRoot, { recursive: true });
		const prevSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;

			// 旧扁平会话在 sessionsRoot 顶层
			const legacyFile = join(sessionsRoot, "legacy.jsonl");
			await writeFile(legacyFile, JSON.stringify({ type: "session", id: "s-legacy", cwd: workdir }) + "\n", "utf8");
			await utimes(legacyFile, new Date(1_000), new Date(1_000));

			// 新会话在专属子目录
			const projectDir = SessionManager.create(workdir).getSessionDir();
			const newFile = join(projectDir, "new.jsonl");
			await writeFile(newFile, JSON.stringify({ type: "session", id: "s-new", cwd: workdir }) + "\n", "utf8");
			await utimes(newFile, new Date(10_000), new Date(10_000));

			const result = await findMostRecentSessionFileFast(workdir, workdir);
			expect(result).toBe(newFile);
		} finally {
			if (prevSessionDir !== undefined) process.env.PI_CODING_AGENT_SESSION_DIR = prevSessionDir;
			else delete process.env.PI_CODING_AGENT_SESSION_DIR;
			if (prevAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = prevAgentDir;
			else delete process.env.PI_CODING_AGENT_DIR;
		}
	});
});
