import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const SDK = "@earendil-works/pi-coding-agent";
const PREPARE = "../../server/transcript-prepare.js";
const OPENER = "../../packages/keel/src/adapters/sdk/session-opener.js";

type OpenerModule = typeof import("../../packages/keel/src/adapters/sdk/session-opener.js");

interface FakeSession {
	sessionFile?: string;
	dispose: Mock;
	isStreaming: boolean;
	getLastAssistantText: () => string | undefined;
}

interface FakeManager {
	getSessionId: () => string;
	getSessionFile: () => string | undefined;
}

interface SdkStub {
	createAgentSessionServices?: Mock;
	createAgentSessionFromServices?: Mock;
	create?: Mock;
	open?: Mock;
}

interface OpenerHarness {
	mod: OpenerModule;
	turns: typeof import("../../server/session-turns.js");
	sdk: {
		createAgentSessionServices: Mock;
		createAgentSessionFromServices: Mock;
		create: Mock;
		open: Mock;
	};
	session: FakeSession;
}

function makeManager(sessionId: string, sessionFile: string | undefined): FakeManager {
	return {
		getSessionId: () => sessionId,
		getSessionFile: () => sessionFile,
	};
}

function makeSession(sessionFile: string | undefined): FakeSession {
	return {
		sessionFile,
		dispose: vi.fn(),
		isStreaming: false,
		getLastAssistantText: () => undefined,
	};
}

/**
 * 每个用例自己搭一份 SDK 假体（`vi.doMock` 而不是文件级 `vi.mock`）：
 * 真建会话的那个用例要拿到**未打桩**的 SDK，文件级 mock 会让它假绿。
 */
async function importOpener(stub: SdkStub = {}, prepare?: Mock): Promise<OpenerHarness> {
	vi.resetModules();
	vi.doUnmock(SDK);
	vi.doUnmock(PREPARE);

	const session = makeSession("/sessions/new.jsonl");
	const services = stub.createAgentSessionServices ?? vi.fn(async () => ({ cwd: "/tmp/ws", agentDir: "/tmp/agent" }));
	const fromServices =
		stub.createAgentSessionFromServices ?? vi.fn(async () => ({ session, extensionsResult: {}, warning: undefined }));
	const create = stub.create ?? vi.fn(() => makeManager("sess-new", "/sessions/new.jsonl"));
	const open = stub.open ?? vi.fn((path: string) => makeManager("sess-old", path));

	if (prepare) vi.doMock(PREPARE, () => ({ prepareTranscriptForOpen: prepare }));
	vi.doMock(SDK, async (importOriginal) => {
		const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
		return {
			...actual,
			createAgentSessionServices: services,
			createAgentSessionFromServices: fromServices,
			SessionManager: { create, open },
		};
	});
	const mod = (await import(OPENER)) as OpenerModule;
	// 与 adapter 同一个模块图（resetModules 之后加载），否则退役集合不是同一份 WeakSet。
	const turns = await import("../../server/session-turns.js");
	return {
		mod,
		turns,
		sdk: { createAgentSessionServices: services, createAgentSessionFromServices: fromServices, create, open },
		session,
	};
}

const tempDirs: string[] = [];

async function makeTempDir(prefix = "pi-core-adapter-sdk-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => {
	vi.resetModules();
	vi.doUnmock(SDK);
	vi.doUnmock(PREPARE);
});

afterEach(async () => {
	vi.doUnmock(SDK);
	vi.doUnmock(PREPARE);
	vi.resetModules();
	for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("openTurnSession：新建会话", () => {
	it("把 cwd/agentDir 原样交给 SDK，并返回 manager 的身份与转录路径", async () => {
		const cwd = await makeTempDir();
		const agentDir = await makeTempDir();
		const { mod, sdk, session } = await importOpener();

		const opened = await mod.openTurnSession({ cwd, agentDir });

		expect(sdk.create).toHaveBeenCalledWith(resolve(cwd));
		expect(sdk.open).not.toHaveBeenCalled();
		expect(sdk.createAgentSessionServices).toHaveBeenCalledWith({ cwd: resolve(cwd), agentDir: resolve(agentDir) });
		const fromServicesArg = sdk.createAgentSessionFromServices.mock.calls[0][0] as {
			services: unknown;
			sessionManager: FakeManager;
		};
		expect(fromServicesArg.services).toBe(await sdk.createAgentSessionServices.mock.results[0].value);
		expect(fromServicesArg.sessionManager.getSessionId()).toBe("sess-new");
		expect(fromServicesArg.sessionManager.getSessionFile()).toBe("/sessions/new.jsonl");
		expect(opened.sessionId).toBe("sess-new");
		expect(opened.sessionFile).toBe("/sessions/new.jsonl");
		// 交出去的必须是 SDK 原会话（guardSession 就地包 dispose，不另起代理对象）。
		expect(opened.session).toBe(session);
	});

	it("没有转录文件时不返回 sessionFile 字段（不编一个假路径出来）", async () => {
		const cwd = await makeTempDir();
		const agentDir = await makeTempDir();
		const { mod } = await importOpener({ create: vi.fn(() => makeManager("sess-mem", undefined)) });

		const opened = await mod.openTurnSession({ cwd, agentDir });

		expect(opened.sessionId).toBe("sess-mem");
		expect("sessionFile" in opened).toBe(false);
	});
});

describe("openTurnSession：打开已有转录", () => {
	it("解析成绝对路径后交给 SDK，且不新建会话", async () => {
		const cwd = await makeTempDir();
		const agentDir = await makeTempDir();
		const file = join(cwd, "existing.jsonl");
		await writeFile(file, "", "utf8");
		const { mod, sdk } = await importOpener();

		const opened = await mod.openTurnSession({ cwd, agentDir, sessionFile: file });

		expect(sdk.create).not.toHaveBeenCalled();
		expect(sdk.open).toHaveBeenCalledWith(resolve(file));
		expect(opened.sessionId).toBe("sess-old");
		expect(opened.sessionFile).toBe(resolve(file));
	});

	it("顺序是「打开前修复 → open」：修复先落盘，随后 SDK 才读同一份文件", async () => {
		const cwd = await makeTempDir();
		const agentDir = await makeTempDir();
		const file = join(cwd, "existing.jsonl");
		await writeFile(file, "", "utf8");
		const order: string[] = [];
		const prepare = vi.fn(async () => {
			order.push("prepare");
			return { repair: null, healed: 0, read: false };
		});
		const { mod } = await importOpener(
			{
				open: vi.fn((path: string) => {
					order.push("open");
					return makeManager("sess-old", path);
				}),
			},
			prepare,
		);

		await mod.openTurnSession({ cwd, agentDir, sessionFile: file });

		expect(prepare).toHaveBeenCalledWith(resolve(file));
		expect(order).toEqual(["prepare", "open"]);
	});
});

describe("openTurnSession：失败必有上下文", () => {
	it("转录文件不存在：报错含 cwd 与文件，且不建会话、不回退成新会话", async () => {
		const cwd = await makeTempDir();
		const agentDir = await makeTempDir();
		const file = join(cwd, "missing.jsonl");
		const { mod, sdk } = await importOpener();

		const error = await mod.openTurnSession({ cwd, agentDir, sessionFile: file }).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(mod.OpenSessionError);
		expect((error as InstanceType<OpenerModule["OpenSessionError"]>).code).toBe("session_open_failed");
		expect((error as InstanceType<OpenerModule["OpenSessionError"]>).phase).toBe("open-transcript");
		expect(String((error as Error).message)).toContain(resolve(cwd));
		expect(String((error as Error).message)).toContain(resolve(file));
		expect(sdk.create).not.toHaveBeenCalled();
		expect(sdk.createAgentSessionServices).not.toHaveBeenCalled();
	});

	it("转录版本比内核新：报错含 cwd 与文件，且修复/建会话都没发生", async () => {
		const cwd = await makeTempDir();
		const agentDir = await makeTempDir();
		const file = join(cwd, "future.jsonl");
		await writeFile(file, `${JSON.stringify({ type: "session", version: 999, id: "x", cwd })}\n`, "utf8");
		const prepare = vi.fn(async () => ({ repair: null, healed: 0, read: false }));
		const { mod, sdk } = await importOpener({}, prepare);

		const error = await mod.openTurnSession({ cwd, agentDir, sessionFile: file }).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(mod.OpenSessionError);
		expect((error as InstanceType<OpenerModule["OpenSessionError"]>).phase).toBe("open-transcript");
		expect(String((error as Error).message)).toContain(resolve(cwd));
		expect(String((error as Error).message)).toContain(resolve(file));
		expect(String((error as Error).message)).toContain("999");
		expect(prepare).not.toHaveBeenCalled();
		expect(sdk.open).not.toHaveBeenCalled();
		expect(sdk.createAgentSessionServices).not.toHaveBeenCalled();
	});

	it("SDK 建会话失败：错误带上 cwd/file 与原始原因（cause 不丢）", async () => {
		const cwd = await makeTempDir();
		const agentDir = await makeTempDir();
		const boom = new Error("no model available for this workspace");
		const { mod } = await importOpener({
			createAgentSessionFromServices: vi.fn(async () => {
				throw boom;
			}),
		});

		const error = (await mod.openTurnSession({ cwd, agentDir }).catch((err: unknown) => err)) as InstanceType<
			OpenerModule["OpenSessionError"]
		>;

		expect(error).toBeInstanceOf(mod.OpenSessionError);
		expect(error.phase).toBe("create-session");
		expect(error.message).toContain(resolve(cwd));
		expect(error.message).toContain("<新建会话>");
		expect(error.message).toContain("no model available for this workspace");
		expect(error.cause).toBe(boom);
	});
});

describe("openTurnSession：dispose 幂等", () => {
	it("连调两次只 dispose SDK 会话一次，并记进退役集合", async () => {
		const cwd = await makeTempDir();
		const agentDir = await makeTempDir();
		const { mod, turns, session } = await importOpener();
		// guardSession 会把 session.dispose 换成守卫版本，所以先把原始 spy 抓在手里。
		const disposeSpy = session.dispose;

		const opened = await mod.openTurnSession({ cwd, agentDir });
		expect(turns.isRetiredSession(opened.session)).toBe(false);

		opened.dispose();
		opened.dispose();

		expect(disposeSpy).toHaveBeenCalledTimes(1);
		expect(turns.isRetiredSession(opened.session)).toBe(true);
	});

	it("SDK dispose 抛错也不放开重复 dispose（先置位再调用）", async () => {
		const cwd = await makeTempDir();
		const agentDir = await makeTempDir();
		const { mod } = await importOpener({
			createAgentSessionFromServices: vi.fn(async () => ({
				session: {
					sessionFile: "/sessions/boom.jsonl",
					dispose: vi.fn(() => {
						throw new Error("dispose exploded");
					}),
					isStreaming: false,
					getLastAssistantText: () => undefined,
				},
				extensionsResult: {},
			})),
		});

		const opened = await mod.openTurnSession({ cwd, agentDir });

		expect(() => opened.dispose()).toThrow("dispose exploded");
		expect(() => opened.dispose()).not.toThrow();
	});
});

describe("真建 SDK 会话（需要可用的 PI_CODING_AGENT_DIR）", () => {
	const agentDir = process.env.PI_CODING_AGENT_DIR;

	it.skipIf(!agentDir)("新建会话：拿到 id 与转录路径，dispose 幂等", async () => {
		const cwd = await makeTempDir("pi-core-adapter-sdk-real-");
		const { openTurnSession } = await import(OPENER);

		const opened = await openTurnSession({ cwd, agentDir: agentDir as string });
		expect(opened.sessionId.length).toBeGreaterThan(0);
		expect(opened.sessionFile).toBeTypeOf("string");
		expect(opened.session.isStreaming).toBe(false);
		opened.dispose();
		opened.dispose();

		// 会话目录由 SDK 决定（`<默认 agentDir>/sessions/--<cwd>--/`），这把临时会话自己收拾干净。
		await rm(dirname(opened.sessionFile as string), { recursive: true, force: true });
	});

	it.skipIf(!agentDir)("重开已有转录：转录头里的 sessionId 原样回来（版本校验 → 打开前修复 → open）", async () => {
		const cwd = await makeTempDir("pi-core-adapter-sdk-real-");
		const file = join(cwd, "resume.jsonl");
		await writeFile(
			file,
			`${JSON.stringify({ type: "session", version: 1, id: "known-session-id", timestamp: Date.now(), cwd })}\n`,
			"utf8",
		);
		const { openTurnSession } = await import(OPENER);

		const opened = await openTurnSession({ cwd, agentDir: agentDir as string, sessionFile: file });

		expect(opened.sessionId).toBe("known-session-id");
		expect(opened.sessionFile).toBe(resolve(file));
		opened.dispose();
	});
});
