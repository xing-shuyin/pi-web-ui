import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import type { SlashCommandsPort } from "../../packages/keel/src/contracts/commands.js";
import type { TransportPort } from "../../packages/keel/src/contracts/ports.js";
import type { CommandDef, ServerMessage } from "../../packages/keel/src/protocol.js";

/** 命令文件落 `<workspace>/.pi/commands.json`（宿主本地方案；远程方案由宿主注入）。 */
const commandsPath = (root: string) => join(root, ".pi", "commands.json");
import { createCommandHandlers } from "../../packages/keel/src/domains/commands/handlers.js";

function fakeTransport(closed = false): { sent: ServerMessage[]; port: TransportPort } {
	const sent: ServerMessage[] = [];
	return { sent, port: { send: (msg) => void sent.push(msg), isClosed: () => closed } };
}

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "keel-commands-"));
}

/** 与 `commandsFilePath()` 一致：`<cwd>/.pi/commands.json`。 */
function commandsFile(cwd: string): string {
	return join(cwd, ".pi", "commands.json");
}

const SAVED: CommandDef[] = [
	{ name: "deploy", command: "./deploy.sh", cwd: "${pwd}" },
	{ name: "lint", command: "npx oxlint" },
];

describe("斜杠命令 handler（B2/T1）· pushSlashCommands 只按一下宿主端口", () => {
	it("异步 push：端口被调一次，内核自己不发帧（帧归 SlashCommandsService）", async () => {
		const push = vi.fn(() => Promise.resolve());
		const { sent, port } = fakeTransport();
		const handlers = createCommandHandlers({
			commandsPathOf: commandsPath,
			cwd: tempDir(),
			transport: port,
			slash: () => ({ push }),
		});
		await handlers.pushSlashCommands();
		expect(push).toHaveBeenCalledTimes(1);
		expect(sent).toEqual([]);
	});

	it("同步 push（void）：照样 await 得到 resolved promise", async () => {
		const push = vi.fn(() => undefined);
		const { port } = fakeTransport();
		const slash: SlashCommandsPort = { push };
		await expect(
			createCommandHandlers({
				commandsPathOf: commandsPath,
				cwd: tempDir(),
				transport: port,
				slash: () => slash,
			}).pushSlashCommands(),
		).resolves.toBeUndefined();
		expect(push).toHaveBeenCalledTimes(1);
	});

	it("slash 缺省 → 同步抛 CoreEngineNotReadyError（不是 rejected promise）", () => {
		const { sent, port } = fakeTransport();
		const handlers = createCommandHandlers({ commandsPathOf: commandsPath, cwd: tempDir(), transport: port });
		let thrown: unknown;
		let returned: unknown;
		try {
			returned = handlers.pushSlashCommands();
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(CoreEngineNotReadyError);
		expect(returned).toBeUndefined();
		expect(sent).toEqual([]);
	});

	it("slash thunk 返回 undefined 也按未接处理", () => {
		const { port } = fakeTransport();
		const handlers = createCommandHandlers({
			commandsPathOf: commandsPath,
			cwd: tempDir(),
			transport: port,
			slash: () => undefined,
		});
		expect(() => handlers.pushSlashCommands()).toThrow(CoreEngineNotReadyError);
	});
});

describe("斜杠命令 handler（B2/T1）· 自定义命令文件往返（真临时目录）", () => {
	it("saveCommands：写进磁盘 + 发 commands 帧 + info 回执", async () => {
		const cwd = tempDir();
		const { sent, port } = fakeTransport();
		await createCommandHandlers({ commandsPathOf: commandsPath, cwd, transport: port }).saveCommands(SAVED);

		expect(JSON.parse(readFileSync(commandsFile(cwd), "utf8"))).toEqual({ commands: SAVED });
		expect(sent[0]).toEqual({ type: "commands", commands: SAVED, path: commandsFile(cwd) });
		expect(sent[1]).toMatchObject({ type: "notice", level: "info" });
		expect(sent[1]).toMatchObject({ text: expect.stringContaining(commandsFile(cwd)) });
	});

	it("listCommands：读回刚写进磁盘的那一份（往返一致，path 指向工作区文件）", async () => {
		const cwd = tempDir();
		const { sent, port } = fakeTransport();
		const handlers = createCommandHandlers({ commandsPathOf: commandsPath, cwd, transport: port });
		await handlers.saveCommands(SAVED);
		sent.length = 0;

		await handlers.listCommands();

		expect(sent).toEqual([{ type: "commands", commands: SAVED, path: commandsFile(cwd) }]);
	});

	it("cwd 给 thunk 时每次现取（切对话换目录不必重建 handler）", async () => {
		const a = tempDir();
		const b = tempDir();
		const { sent, port } = fakeTransport();
		let current = a;
		const handlers = createCommandHandlers({ commandsPathOf: commandsPath, cwd: () => current, transport: port });
		await handlers.saveCommands(SAVED);
		expect(JSON.parse(readFileSync(commandsFile(a), "utf8"))).toEqual({ commands: SAVED });
		current = b;
		sent.length = 0;
		await handlers.listCommands();
		expect(sent).toEqual([{ type: "commands", commands: [], path: commandsFile(b) }]);
	});

	it("命令文件不存在 → 空命令表且不报警告", async () => {
		const cwd = tempDir();
		const { sent, port } = fakeTransport();
		await createCommandHandlers({ commandsPathOf: commandsPath, cwd, transport: port }).listCommands();
		expect(sent).toEqual([{ type: "commands", commands: [], path: commandsFile(cwd) }]);
	});

	it("命令文件不是有效 JSON → 先发 warning，命令表照发（不吞告警）", async () => {
		const cwd = tempDir();
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(commandsFile(cwd), "{ not json", "utf8");
		const { sent, port } = fakeTransport();
		await createCommandHandlers({ commandsPathOf: commandsPath, cwd, transport: port }).listCommands();
		expect(sent[0]).toMatchObject({ type: "notice", level: "warning" });
		expect(sent[1]).toEqual({ type: "commands", commands: [], path: commandsFile(cwd) });
	});
});

describe("斜杠命令 handler（B2/T1）· 写失败不静默", () => {
	it("目录不可建 → 发 notice error 且 promise reject", async () => {
		const cwd = tempDir();
		// 拿一个文件当父目录：mkdir("<file>/sub/.pi") 必失败（Windows/POSIX 都稳定）。
		const blocker = join(cwd, "blocker");
		writeFileSync(blocker, "x", "utf8");
		const { sent, port } = fakeTransport();

		await expect(
			createCommandHandlers({ commandsPathOf: commandsPath, cwd: join(blocker, "sub"), transport: port }).saveCommands(
				SAVED,
			),
		).rejects.toThrow(/保存命令文件失败/);

		expect(sent.filter((m) => m.type === "notice" && m.level === "error")).toHaveLength(1);
		expect(sent.some((m) => m.type === "commands")).toBe(false);
	});

	it("通道已关：磁盘照样写，但一帧都不发", async () => {
		const cwd = tempDir();
		const { sent, port } = fakeTransport(true);
		await createCommandHandlers({ commandsPathOf: commandsPath, cwd, transport: port }).saveCommands(SAVED);
		expect(JSON.parse(readFileSync(commandsFile(cwd), "utf8"))).toEqual({ commands: SAVED });
		expect(sent).toEqual([]);
	});
});
