import { afterEach, describe, expect, it, vi } from "vitest";
import {
	existsSync,
	fsyncSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: vi.fn(actual.readFileSync),
		writeFileSync: vi.fn(actual.writeFileSync),
		renameSync: vi.fn(actual.renameSync),
		fsyncSync: vi.fn(actual.fsyncSync),
		unlinkSync: vi.fn(actual.unlinkSync),
	};
});
afterEach(() => vi.resetAllMocks());
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	deleteMcpServer,
	getGlobalMcpPath,
	getProjectMcpPath,
	isValidMcpServerName,
	listAllMcpServers,
	readMcpConfigFile,
	saveMcpServer,
	toggleMcpServer,
	writeMcpConfigFile,
} from "../../server/mcp-manager.js";
import type { UiMcpServer } from "../../server/protocol.js";
import type { McpBridge } from "../../server/mcp-bridge.js";

function makeTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("mcp-manager effective runtime status", () => {
	it.each([true, false])("does not assign the project instance to an overridden global row (enabled=%s)", (enabled) => {
		const dir = makeTempDir("mcp-overridden-");
		try {
			const agentDir = join(dir, "agent");
			const cwd = join(dir, "project");
			writeMcpConfigFile(getGlobalMcpPath(agentDir), { same: { command: "global" } });
			writeMcpConfigFile(getProjectMcpPath(cwd), { same: { command: "project", enabled } });
			const getServerStatus = vi.fn(() => ({ status: "running", tools: [{ name: "project-tool" }] }));
			const { servers } = listAllMcpServers({ agentDir, cwd, bridge: { getServerStatus } as unknown as McpBridge });
			expect(servers[0]).toMatchObject({ scope: "global", status: "stopped", overriddenBy: "project", tools: [] });
			expect(servers[1]).toMatchObject({ scope: "project", status: enabled ? "running" : "stopped" });
			expect(getServerStatus).toHaveBeenCalledTimes(enabled ? 1 : 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves a failed configuration warning while the old instance still runs", () => {
		const dir = makeTempDir("mcp-previous-");
		try {
			const agentDir = join(dir, "agent");
			writeMcpConfigFile(getGlobalMcpPath(agentDir), { same: { command: "new-command" } });
			const bridge = {
				getServerStatus: () => ({ status: "running", usingPreviousConfig: true, error: "spawn failed", tools: [] }),
			} as unknown as McpBridge;
			expect(listAllMcpServers({ agentDir, cwd: join(dir, "project"), bridge }).servers[0]).toMatchObject({
				status: "running",
				usingPreviousConfig: true,
				error: "spawn failed",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("mcp-manager transactions", () => {
	function fixture() {
		const dir = makeTempDir("mcp-transaction-");
		const agentDir = join(dir, "agent");
		const cwd = join(dir, "project");
		const source = join(agentDir, "mcp.json");
		const target = join(cwd, ".pi", "mcp.json");
		writeMcpConfigFile(source, { old: { command: "node", args: ["old.js"], enabled: true } });
		writeMcpConfigFile(target, {});
		const move = {
			agentDir,
			cwd,
			prevName: "old",
			prevScope: "global" as const,
			server: { name: "new", scope: "project" as const, command: "node", args: ["new.js"], enabled: true },
		};
		return { dir, source, target, move };
	}

	it.each(["write", "sync", "rename"])(
		"same-file rename is one atomic commit; %s failure preserves original bytes",
		(phase) => {
			const f = fixture();
			try {
				const before = readFileSync(f.source, "utf8");
				if (phase === "write")
					vi.mocked(writeFileSync).mockImplementationOnce(() => {
						throw new Error("write fault");
					});
				if (phase === "sync")
					vi.mocked(fsyncSync).mockImplementationOnce(() => {
						throw new Error("sync fault");
					});
				if (phase === "rename")
					vi.mocked(renameSync).mockImplementationOnce(() => {
						throw new Error("rename fault");
					});
				const opts = { ...f.move, server: { ...f.move.server, scope: "global" as const } };
				expect(saveMcpServer(opts).ok).toBe(false);
				expect(readFileSync(f.source, "utf8")).toBe(before);
				expect(readdirSync(join(f.dir, "agent"))).toEqual(["mcp.json"]);
				vi.mocked(renameSync).mockClear();
				expect(saveMcpServer(opts).ok).toBe(true);
				expect(vi.mocked(renameSync)).toHaveBeenCalledTimes(1);
				expect(readMcpConfigFile(f.source).servers.old).toBeUndefined();
				expect(readMcpConfigFile(f.source).servers.new.command).toBe("node");
			} finally {
				rmSync(f.dir, { recursive: true, force: true });
			}
		},
	);

	it.each(["journal", "target", "source", "cleanup"])(
		"migration resumes safely after %s commit failure and module reload",
		async (phase) => {
			const f = fixture();
			try {
				const rename = vi.mocked(renameSync).getMockImplementation()!;
				const unlink = vi.mocked(unlinkSync).getMockImplementation()!;
				vi.mocked(renameSync).mockImplementation((from, to) => {
					if (
						String(to) ===
						(phase === "journal"
							? `${f.source}.migration.json`
							: phase === "target"
								? f.target
								: phase === "source"
									? f.source
									: "")
					)
						throw new Error(`${phase} fault`);
					return rename(from, to);
				});
				vi.mocked(unlinkSync).mockImplementation((path) => {
					if (phase === "cleanup" && String(path) === `${f.source}.migration.json`) throw new Error("cleanup fault");
					return unlink(path);
				});
				expect(saveMcpServer(f.move).ok).toBe(false);
				const src = readMcpConfigFile(f.source).servers.old;
				const dst = readMcpConfigFile(f.target).servers.new;
				expect(!!src || !!dst).toBe(true);
				expect(!!dst).toBe(phase === "source" || phase === "cleanup");
				expect(!!src).toBe(phase !== "cleanup");
				vi.mocked(renameSync).mockImplementation(rename);
				vi.mocked(unlinkSync).mockImplementation(unlink);
				vi.resetModules();
				const reloaded = await import("../../server/mcp-manager.js");
				expect(reloaded.saveMcpServer(f.move)).toEqual({ ok: true });
				expect(readMcpConfigFile(f.source).servers.old).toBeUndefined();
				expect(readMcpConfigFile(f.target).servers.new.args).toEqual(["new.js"]);
				expect(existsSync(`${f.source}.migration.json`)).toBe(false);
			} finally {
				rmSync(f.dir, { recursive: true, force: true });
			}
		},
	);

	it.each(["source", "target"])("retry refuses an intervening %s edit", (side) => {
		const f = fixture();
		try {
			const rename = vi.mocked(renameSync).getMockImplementation()!;
			vi.mocked(renameSync).mockImplementation((from, to) => {
				if (String(to) === f.source) throw new Error("source fault");
				return rename(from, to);
			});
			expect(saveMcpServer(f.move).ok).toBe(false);
			vi.mocked(renameSync).mockImplementation(rename);
			writeMcpConfigFile(side === "source" ? f.source : f.target, {
				[side === "source" ? "old" : "new"]: { command: "edited" },
			});
			const before = [readFileSync(f.source, "utf8"), readFileSync(f.target, "utf8")];
			expect(saveMcpServer(f.move).ok).toBe(false);
			expect([readFileSync(f.source, "utf8"), readFileSync(f.target, "utf8")]).toEqual(before);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	it.each(["global", "project"] as const)("refuses existing target names in %s scope even if identical", (scope) => {
		const f = fixture();
		try {
			const path = scope === "global" ? f.source : f.target;
			writeMcpConfigFile(path, {
				...readMcpConfigFile(path).servers,
				new: { command: "node", args: ["new.js"], enabled: true },
			});
			const before = [readFileSync(f.source, "utf8"), readFileSync(f.target, "utf8")];
			expect(saveMcpServer({ ...f.move, server: { ...f.move.server, scope } }).ok).toBe(false);
			expect([readFileSync(f.source, "utf8"), readFileSync(f.target, "utf8")]).toEqual(before);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	it.each([
		"{broken",
		"[]",
		"null",
		'{"mcpServers":[]}',
		'{"mcpServers":{"x":null}}',
		'{"servers":{},"mcpServers":{}}',
	])("never overwrites damaged config: %s", (text) => {
		const f = fixture();
		try {
			writeFileSync(f.source, text);
			expect(readMcpConfigFile(f.source).error).toBeTruthy();
			expect(listAllMcpServers(f.move).servers).toContainEqual(
				expect.objectContaining({ name: f.source, scope: "global", status: "error", error: expect.any(String) }),
			);
			expect(() => writeMcpConfigFile(f.source, {})).toThrow();
			expect(saveMcpServer({ ...f.move, server: { ...f.move.server, scope: "global" } }).ok).toBe(false);
			expect(deleteMcpServer({ ...f.move, name: "old", scope: "global" }).ok).toBe(false);
			expect(toggleMcpServer({ ...f.move, name: "old", scope: "global", enabled: false }).ok).toBe(false);
			expect(readFileSync(f.source, "utf8")).toBe(text);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	it.each(["source", "target"])("unreadable %s stops migration before touching source", (side) => {
		const f = fixture();
		try {
			const read = vi.mocked(readFileSync).getMockImplementation()!;
			const before = readFileSync(f.source, "utf8");
			vi.mocked(readFileSync).mockImplementation(((path: any, ...args: any[]) => {
				if (String(path) === (side === "source" ? f.source : f.target))
					throw Object.assign(new Error("denied"), { code: "EACCES" });
				return (read as any)(path, ...args);
			}) as typeof readFileSync);
			expect(saveMcpServer(f.move).ok).toBe(false);
			expect(() => writeMcpConfigFile(side === "source" ? f.source : f.target, {})).toThrow("denied");
			expect(listAllMcpServers(f.move).servers).toContainEqual(
				expect.objectContaining({ status: "error", error: expect.stringContaining("denied") }),
			);
			vi.mocked(readFileSync).mockImplementation(read);
			expect(readFileSync(f.source, "utf8")).toBe(before);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	it.each(["{broken", "null", '{"version":2}'])("refuses damaged or unknown recovery intent: %s", (journal) => {
		const f = fixture();
		try {
			writeFileSync(`${f.source}.migration.json`, journal);
			const before = [readFileSync(f.source, "utf8"), readFileSync(f.target, "utf8")];
			expect(saveMcpServer(f.move).ok).toBe(false);
			expect([readFileSync(f.source, "utf8"), readFileSync(f.target, "utf8")]).toEqual(before);
			expect(readFileSync(`${f.source}.migration.json`, "utf8")).toBe(journal);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	it("damaged destination and missing source never remove or create records", () => {
		const f = fixture();
		try {
			const before = readFileSync(f.source, "utf8");
			writeFileSync(f.target, "{broken");
			expect(saveMcpServer(f.move).ok).toBe(false);
			expect(readFileSync(f.source, "utf8")).toBe(before);
			expect(readFileSync(f.target, "utf8")).toBe("{broken");
			writeFileSync(f.target, "{}");
			writeMcpConfigFile(f.source, {});
			expect(saveMcpServer(f.move).ok).toBe(false);
			expect(readFileSync(f.target, "utf8")).toBe("{}");
			expect(existsSync(`${f.source}.migration.json`)).toBe(false);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	it("preserves legacy format, metadata and unrecognized server fields", () => {
		const f = fixture();
		try {
			writeFileSync(
				f.source,
				JSON.stringify({
					metadata: { custom: true },
					servers: { old: { command: "node" }, extra: { custom: "keep", command: "python" } },
				}),
			);
			expect(saveMcpServer({ ...f.move, server: { ...f.move.server, scope: "global" } }).ok).toBe(true);
			expect(JSON.parse(readFileSync(f.source, "utf8"))).toMatchObject({
				metadata: { custom: true },
				servers: { extra: { custom: "keep" }, new: { command: "node" } },
			});
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});
});

describe("mcp-manager", () => {
	it("isValidMcpServerName 校验服务器名", () => {
		expect(isValidMcpServerName("filesystem")).toBe(true);
		expect(isValidMcpServerName("my-server_1")).toBe(true);
		expect(isValidMcpServerName("invalid server")).toBe(false);
		expect(isValidMcpServerName("server:1")).toBe(false);
		expect(isValidMcpServerName("")).toBe(false);
	});

	it("readMcpConfigFile / writeMcpConfigFile 读写与保持格式", () => {
		const dir = makeTempDir("mcp-test-");
		try {
			const file = join(dir, "mcp.json");
			writeMcpConfigFile(file, {
				git: { command: "node", args: ["git.js"] },
			});
			const read1 = readMcpConfigFile(file);
			expect(read1.exists).toBe(true);
			expect(read1.legacy).toBe(false);
			expect(read1.servers.git.command).toBe("node");

			writeMcpConfigFile(
				file,
				{
					git: { command: "node", args: ["git.js"] },
				},
				true,
			);
			const read2 = readMcpConfigFile(file);
			expect(read2.legacy).toBe(true);
			expect(read2.servers.git.command).toBe("node");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("listAllMcpServers 能分别汇总全局和项目级服务器", () => {
		const agentDir = makeTempDir("mcp-agent-");
		const cwd = makeTempDir("mcp-proj-");
		try {
			writeMcpConfigFile(join(agentDir, "mcp.json"), {
				globalSrv: { command: "node", args: ["g.js"], description: "Global Server" },
			});
			writeMcpConfigFile(join(cwd, ".pi", "mcp.json"), {
				projSrv: { command: "python", args: ["p.py"], description: "Project Server" },
			});

			const res = listAllMcpServers({ agentDir, cwd });
			expect(res.servers.length).toBe(2);

			const g = res.servers.find((s) => s.name === "globalSrv");
			expect(g).toBeDefined();
			expect(g?.scope).toBe("global");
			expect(g?.command).toBe("node");

			const p = res.servers.find((s) => s.name === "projSrv");
			expect(p).toBeDefined();
			expect(p?.scope).toBe("project");
			expect(p?.command).toBe("python");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("saveMcpServer 支持新增、修改、重命名跨作用域移动", () => {
		const agentDir = makeTempDir("mcp-agent-");
		const cwd = makeTempDir("mcp-proj-");
		try {
			const srv1: UiMcpServer = {
				name: "test-global",
				scope: "global",
				command: "npx",
				args: ["-y", "mcp-pkg"],
				enabled: true,
			};
			const res1 = saveMcpServer({ agentDir, cwd, server: srv1 });
			expect(res1.ok).toBe(true);

			const list1 = listAllMcpServers({ agentDir, cwd });
			expect(list1.servers.find((s) => s.name === "test-global")?.scope).toBe("global");

			const srv2: UiMcpServer = {
				name: "test-proj",
				scope: "project",
				command: "npx",
				args: ["-y", "mcp-pkg-v2"],
				enabled: true,
			};
			const res2 = saveMcpServer({
				agentDir,
				cwd,
				server: srv2,
				prevName: "test-global",
				prevScope: "global",
			});
			expect(res2.ok).toBe(true);

			const list2 = listAllMcpServers({ agentDir, cwd });
			expect(list2.servers.find((s) => s.name === "test-global")).toBeUndefined();
			const projHit = list2.servers.find((s) => s.name === "test-proj");
			expect(projHit).toBeDefined();
			expect(projHit?.scope).toBe("project");
			expect(projHit?.args).toEqual(["-y", "mcp-pkg-v2"]);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("toggleMcpServer 与 deleteMcpServer", () => {
		const agentDir = makeTempDir("mcp-agent-");
		const cwd = makeTempDir("mcp-proj-");
		try {
			writeMcpConfigFile(join(agentDir, "mcp.json"), {
				srv: { command: "node", args: ["s.js"], enabled: true },
			});

			const togRes = toggleMcpServer({ agentDir, cwd, name: "srv", scope: "global", enabled: false });
			expect(togRes.ok).toBe(true);

			const afterTog = listAllMcpServers({ agentDir, cwd });
			expect(afterTog.servers.find((s) => s.name === "srv")?.enabled).toBe(false);

			const projTog = toggleMcpServer({ agentDir, cwd, name: "srv", scope: "project", enabled: false });
			expect(projTog.ok).toBe(true);
			const projCfg = readMcpConfigFile(join(cwd, ".pi", "mcp.json"));
			expect(projCfg.servers.srv?.enabled).toBe(false);

			const delRes = deleteMcpServer({ agentDir, cwd, name: "srv", scope: "global" });
			expect(delRes.ok).toBe(true);
			const afterDel = listAllMcpServers({ agentDir, cwd });
			expect(afterDel.servers.find((s) => s.scope === "global" && s.name === "srv")).toBeUndefined();
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
