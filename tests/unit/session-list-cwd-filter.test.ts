import { existsSync } from "node:fs";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { ClientSession } from "../../server/agent-service.js";
import { normalizePathKey } from "../../server/client-state.js";
import { fakeClientSession } from "../helpers/fake-session.js";

const caches = ClientSession as unknown as {
	sessionInfosCache: Map<string, { infos: SessionInfo[]; at: number }>;
	sessionInfosInFlight: Map<string, Promise<SessionInfo[]>>;
	sessionFileCache: Map<string, unknown>;
};

const loadSessionInfos = (
	ClientSession.prototype as unknown as Record<string, (this: unknown) => Promise<SessionInfo[]>>
).loadSessionInfos;

const fakeThis = (cwd: string) => Object.assign(fakeClientSession(), { cwd });

const envOriginal = {
	PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};

let idSeq = 0;
let tmpDirs: string[] = [];

async function makeTmpDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `pi-438-${prefix}-`));
	tmpDirs.push(dir);
	return dir;
}

async function writeSession(
	dir: string,
	opts: { cwd: string | null; atMs: number; id?: string },
): Promise<{ path: string; id: string }> {
	const id = opts.id ?? `s${idSeq++}`;
	const header: Record<string, unknown> = { type: "session", id, timestamp: new Date(opts.atMs).toISOString() };
	if (opts.cwd !== null) header.cwd = opts.cwd;
	const fp = join(dir, `2026-01-01T00-00-${String(idSeq % 60).padStart(2, "0")}_${id}.jsonl`);
	await writeFile(fp, `${JSON.stringify(header)}\n`);
	await utimes(fp, new Date(opts.atMs), new Date(opts.atMs));
	return { path: fp, id };
}

async function setFlatRoot(root: string | null): Promise<void> {
	if (root === null) delete process.env.PI_CODING_AGENT_SESSION_DIR;
	else process.env.PI_CODING_AGENT_SESSION_DIR = root;
}

beforeEach(() => {
	caches.sessionInfosCache.clear();
	caches.sessionInfosInFlight.clear();
	caches.sessionFileCache.clear();
});

afterEach(async () => {
	if (envOriginal.PI_CODING_AGENT_SESSION_DIR === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
	else process.env.PI_CODING_AGENT_SESSION_DIR = envOriginal.PI_CODING_AGENT_SESSION_DIR;
	if (envOriginal.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = envOriginal.PI_CODING_AGENT_DIR;
	for (const dir of tmpDirs.splice(0)) {
		if (existsSync(dir)) {
			await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		}
	}
});

describe("loadSessionInfos — 扁平布局 cwd 过滤（issue #438）", () => {
	it("只返回当前 cwd 的会话，其他项目的文件不混入", async () => {
		const root = await makeTmpDir("flat");
		const cwdA = await makeTmpDir("proj-a");
		const cwdB = await makeTmpDir("proj-b");
		await setFlatRoot(root);

		const other = await writeSession(root, { cwd: cwdB, atMs: 3_000 });
		const ownOld = await writeSession(root, { cwd: cwdA, atMs: 1_000 });
		const ownNew = await writeSession(root, { cwd: cwdA, atMs: 2_000 });

		const infos = await loadSessionInfos.call(fakeThis(cwdA));
		expect(infos.map((i) => normalizePathKey(i.cwd))).toEqual([normalizePathKey(cwdA), normalizePathKey(cwdA)]);
		expect(infos.map((i) => i.path).sort()).toEqual([ownOld.path, ownNew.path].sort());
		expect(infos.map((i) => i.id)).not.toContain(other.id);
		expect(infos[0].path).toBe(ownNew.path);
	});

	it("Windows 大小写/斜杠差异不漏配（normalizePathKey 口径）", { skip: process.platform !== "win32" }, async () => {
		const root = await makeTmpDir("flat-win");
		const cwdA = await makeTmpDir("proj-a");
		await setFlatRoot(root);

		const lowered = cwdA.toLowerCase().replaceAll("\\", "/");
		const own = await writeSession(root, { cwd: lowered, atMs: 1_000 });
		await writeSession(root, { cwd: "d:\\somewhere-else", atMs: 2_000 });

		const infos = await loadSessionInfos.call(fakeThis(cwdA));
		expect(infos.map((i) => i.id)).toEqual([own.id]);
	});

	it("缺 cwd 字段的损坏文件不误收（normalizePathKey('') 会 resolve 到 process.cwd()）", async () => {
		const root = await makeTmpDir("flat-corrupt");
		const cwdA = await makeTmpDir("proj-a");
		await setFlatRoot(root);

		await writeSession(root, { cwd: null, atMs: 5_000 });
		const own = await writeSession(root, { cwd: cwdA, atMs: 1_000 });

		const infos = await loadSessionInfos.call(fakeThis(cwdA));
		expect(infos.map((i) => i.path)).toEqual([own.path]);
	});

	it("超过 200 个本项目会话仍完整保留，其他项目不混入", { timeout: 60_000 }, async () => {
		const root = await makeTmpDir("flat-cap");
		const cwdA = await makeTmpDir("proj-a");
		const cwdB = await makeTmpDir("proj-b");
		await setFlatRoot(root);

		const baseMs = 1_000_000;
		const ownFiles: { id: string }[] = [];
		for (let i = 0; i < 201; i++) {
			ownFiles.push(
				await writeSession(root, { cwd: cwdA, atMs: baseMs + i * 1000, id: `own-${String(i).padStart(3, "0")}` }),
			);
		}
		for (let i = 0; i < 10; i++) {
			await writeSession(root, { cwd: cwdB, atMs: baseMs + 500_000 + i * 1000, id: `other-${i}` });
		}

		const infos = await loadSessionInfos.call(fakeThis(cwdA));
		expect(infos).toHaveLength(201);
		const ids = infos.map((i) => i.id);
		expect(ids.some((id) => id.startsWith("other-"))).toBe(false);
		expect(ids).toContain("own-000");
		expect(ids).toContain("own-200");
		expect(infos.every((i) => normalizePathKey(i.cwd) === normalizePathKey(cwdA))).toBe(true);
	});
});

describe("loadSessionInfos — 默认分层布局行为不变", () => {
	it("每-cwd 子目录布局：只读本 cwd 子目录，其他 cwd 的子目录不混入", async () => {
		const agentDir = await makeTmpDir("agent");
		const cwdA = await makeTmpDir("proj-a");
		const cwdB = await makeTmpDir("proj-b");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await setFlatRoot(null);

		const dirA = SessionManager.create(cwdA).getSessionDir();
		const own = await writeSession(dirA, { cwd: cwdA, atMs: 1_000 });
		const own2 = await writeSession(dirA, { cwd: cwdA, atMs: 2_000 });
		const dirB = SessionManager.create(cwdB).getSessionDir();
		const foreign = await writeSession(dirB, { cwd: cwdB, atMs: 3_000 });

		const infos = await loadSessionInfos.call(fakeThis(cwdA));
		expect(infos.map((i) => i.id).sort()).toEqual([own.id, own2.id].sort());
		expect(infos.map((i) => i.id)).not.toContain(foreign.id);
		expect(existsSync(dirB)).toBe(true);
	});
});

describe("loadSessionInfos — PI_CODING_AGENT_SESSION_DIR 指向会话根时兼收新旧会话（issue #711）", () => {
	it("同时读取项目专属子目录中的新会话与根目录下的扁平旧会话", async () => {
		const agentDir = await makeTmpDir("agent");
		const cwdA = await makeTmpDir("proj-a");
		const cwdB = await makeTmpDir("proj-b");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const sessionsRoot = join(agentDir, "sessions");
		await setFlatRoot(sessionsRoot);

		const dirA = SessionManager.create(cwdA).getSessionDir();
		const newSession1 = await writeSession(dirA, { cwd: cwdA, atMs: 5_000, id: "new-1" });
		const newSession2 = await writeSession(dirA, { cwd: cwdA, atMs: 6_000, id: "new-2" });

		const legacySession = await writeSession(sessionsRoot, { cwd: cwdA, atMs: 1_000, id: "legacy-1" });

		const otherLegacy = await writeSession(sessionsRoot, { cwd: cwdB, atMs: 2_000, id: "other-legacy" });
		const dirB = SessionManager.create(cwdB).getSessionDir();
		const otherNew = await writeSession(dirB, { cwd: cwdB, atMs: 7_000, id: "other-new" });

		const infos = await loadSessionInfos.call(fakeThis(cwdA));
		const ids = infos.map((i) => i.id);

		expect(ids).toContain(newSession1.id);
		expect(ids).toContain(newSession2.id);
		expect(ids).toContain(legacySession.id);

		expect(ids).not.toContain(otherLegacy.id);
		expect(ids).not.toContain(otherNew.id);

		expect(ids).toEqual([newSession2.id, newSession1.id, legacySession.id]);
	});

	it("同一个 sessionId 重复出现在两处时按最新版本去重", async () => {
		const agentDir = await makeTmpDir("agent");
		const cwdA = await makeTmpDir("proj-a");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const sessionsRoot = join(agentDir, "sessions");
		await setFlatRoot(sessionsRoot);

		const dirA = SessionManager.create(cwdA).getSessionDir();
		await writeSession(sessionsRoot, { cwd: cwdA, atMs: 1_000, id: "dup-id" });
		const newer = await writeSession(dirA, { cwd: cwdA, atMs: 8_000, id: "dup-id" });

		const infos = await loadSessionInfos.call(fakeThis(cwdA));
		expect(infos.filter((i) => i.id === "dup-id")).toHaveLength(1);
		expect(infos[0].path).toBe(newer.path);
	});
});
