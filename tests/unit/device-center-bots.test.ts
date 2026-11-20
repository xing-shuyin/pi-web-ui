import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalBotRegistry, LOCAL_BOT_SCOPE, type LocalBotInput } from "../../server/device-center/bots.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "device-bots-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const dataDir = join(dir, "data");
	const cwd = join(dir, "project");
	await mkdir(cwd);
	const registry = await createLocalBotRegistry(dataDir);
	const input: LocalBotInput = {
		name: "Bot",
		description: "Description",
		systemPrompt: "Instructions",
		cwd,
		model: { provider: "test", modelId: "test-model" },
		tools: ["read"],
		skills: ["skill"],
		mcpServers: ["server"],
		enabled: true,
	};
	const directory = join(dataDir, "device-bots");
	const filename = `${createHash("sha256").update(LOCAL_BOT_SCOPE).digest("hex")}.json`;
	return { dir, dataDir, directory, filename, cwd, registry, input, file: join(directory, filename) };
}

describe("local Bot registry", () => {
	it("isolates accounts and hubs in hashed scope files, including the machine default", async () => {
		const f = await fixture();
		const unpaired = await f.registry.upsert(f.input);
		const scopes = ["hub-a/account-a", "hub-a/account-b", "hub-b/account-a", "../../outside"];
		const ids = new Map<string, string>();
		for (const scope of scopes) {
			await f.registry.setScope(scope);
			expect(f.registry.list()).toEqual([]);
			expect(f.registry.get(unpaired.id)).toBeUndefined();
			await expect(f.registry.acquire(unpaired.id)).rejects.toMatchObject({ code: "BOT_UNAVAILABLE" });
			const bot = await f.registry.upsert({ ...f.input, name: scope });
			ids.set(scope, bot.id);
			const file = join(f.directory, `${createHash("sha256").update(scope).digest("hex")}.json`);
			expect(JSON.parse(await readFile(file, "utf8"))).toEqual([bot]);
		}
		for (const scope of scopes) {
			await f.registry.setScope(scope);
			expect(f.registry.list().map((bot) => bot.id)).toEqual([ids.get(scope)]);
		}
		await f.registry.setScope(LOCAL_BOT_SCOPE);
		expect(f.registry.list()).toEqual([unpaired]);
		expect((await createLocalBotRegistry(f.dataDir)).list()).toEqual([unpaired]);
	});

	it("adopts the newest legacy scope file so Bot identity stops following Hub pairing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "device-bots-migrate-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const dataDir = join(dir, "data");
		const cwd = join(dir, "project");
		await mkdir(cwd, { recursive: true });
		const directory = join(dataDir, "device-bots");
		await mkdir(directory, { recursive: true });
		const legacy = join(directory, `${createHash("sha256").update('["https://old-hub","dev-1"]').digest("hex")}.json`);
		const bot = {
			id: "legacy-bot",
			name: "Kept",
			description: "",
			systemPrompt: "Help",
			cwd,
			tools: ["read"],
			skills: [],
			mcpServers: [],
			enabled: true,
			revision: 3,
		};
		await writeFile(legacy, JSON.stringify([bot]));
		const registry = await createLocalBotRegistry(dataDir);
		// 旧的分配对 scope 文件被搬进机器级 scope，旧文件保留（可回滚）。
		expect(registry.list().map((entry) => entry.id)).toEqual(["legacy-bot"]);
		const local = join(directory, `${createHash("sha256").update(LOCAL_BOT_SCOPE).digest("hex")}.json`);
		expect(JSON.parse(await readFile(local, "utf8"))).toEqual([bot]);
		expect(JSON.parse(await readFile(legacy, "utf8"))).toEqual([bot]);
		// 幂等：再开一次不会覆盖机器级 scope 的后续修改。
		await registry.upsert({ ...bot, revision: 3, name: "Renamed" });
		expect((await createLocalBotRegistry(dataDir)).list()[0].name).toBe("Renamed");
	});

	it("never promotes a broken legacy scope file to the machine scope", async () => {
		const dir = await mkdtemp(join(tmpdir(), "device-bots-broken-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const dataDir = join(dir, "data");
		const directory = join(dataDir, "device-bots");
		await mkdir(directory, { recursive: true });
		// 最新的旧文件是坏的：迁移必须跳过它，而不是把坏内容写成唯一单源（那会让启动直接崩）。
		const broken = join(directory, `${createHash("sha256").update("newest").digest("hex")}.json`);
		await writeFile(broken, '{"broken": not-json');
		await expect(createLocalBotRegistry(dataDir)).resolves.toBeTruthy();
		expect((await createLocalBotRegistry(dataDir)).list()).toEqual([]);
		const local = join(directory, `${createHash("sha256").update(LOCAL_BOT_SCOPE).digest("hex")}.json`);
		await expect(readFile(local, "utf8")).rejects.toThrow();
	});

	it("rejects scope changes while leases are held and preserves the current scope on invalid or corrupt loads", async () => {
		const f = await fixture();
		const bot = await f.registry.upsert(f.input);
		const first = await f.registry.acquire(bot.id);
		const second = await f.registry.acquire(bot.id);
		await f.registry.setScope(LOCAL_BOT_SCOPE);
		await expect(f.registry.setScope("other")).rejects.toMatchObject({ code: "BOT_BUSY" });
		first.release();
		first.release();
		await expect(f.registry.setScope("other")).rejects.toMatchObject({ code: "BOT_BUSY" });
		second.release();
		for (const scope of ["", "x".repeat(4097)]) {
			await expect(f.registry.setScope(scope)).rejects.toMatchObject({ code: "BOT_SCOPE_INVALID" });
		}
		await writeFile(join(f.directory, `${createHash("sha256").update("corrupt").digest("hex")}.json`), "invalid JSON");
		await expect(f.registry.setScope("corrupt")).rejects.toThrow();
		expect(f.registry.list()).toEqual([bot]);
		const updated = await f.registry.upsert({ ...bot, name: "Still unpaired" });
		expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual([updated]);
		await f.registry.setScope("other");
		expect(f.registry.list()).toEqual([]);
	});
	it("persists complete configurations and monotonic revisions, with detached public values", async () => {
		const f = await fixture();
		const first = await f.registry.upsert(f.input);
		expect(first).toEqual({ ...f.input, id: expect.any(String), revision: 1 });
		f.input.tools.push("write");
		first.model!.modelId = "mutated";
		f.registry.get(first.id)!.tools.push("edit");
		f.registry.list()[0].skills.length = 0;
		expect(f.registry.get(first.id)).toMatchObject({
			tools: ["read"],
			skills: ["skill"],
			model: { modelId: "test-model" },
		});
		const second = await f.registry.upsert({ ...f.registry.get(first.id)!, name: "Renamed" });
		expect(second.revision).toBe(2);
		const reopened = await createLocalBotRegistry(f.dataDir);
		expect(reopened.list()).toEqual([second]);
		expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual([second]);
		expect(await readdir(f.directory)).toEqual([f.filename]);
		await f.registry.remove(second.id, second.revision);
		expect(f.registry.list()).toEqual([]);
		expect((await createLocalBotRegistry(f.dataDir)).list()).toEqual([]);
	});

	it.each(["name", "description", "systemPrompt", "cwd", "model", "tools", "skills", "mcpServers", "enabled"] as const)(
		"rejects changes to %s and deletion while any lease is held",
		async (field) => {
			const f = await fixture();
			const bot = await f.registry.upsert(f.input);
			const one = await f.registry.acquire(bot.id);
			const two = await f.registry.acquire(bot.id);
			expect(one).toMatchObject({ bot, root: bot.cwd, revision: `${bot.id}:1` });
			one.bot.tools.push("write");
			expect(f.registry.get(bot.id)!.tools).toEqual(["read"]);
			const values = {
				name: "New",
				description: "New",
				systemPrompt: "New",
				cwd: f.dir,
				model: { provider: "new", modelId: "new" },
				tools: ["write"],
				skills: [],
				mcpServers: [],
				enabled: false,
			};
			await expect(f.registry.upsert({ ...bot, [field]: values[field] })).rejects.toMatchObject({ code: "BOT_BUSY" });
			await expect(f.registry.remove(bot.id, bot.revision)).rejects.toMatchObject({ code: "BOT_BUSY" });
			one.release();
			one.release();
			await expect(f.registry.remove(bot.id, bot.revision)).rejects.toMatchObject({ code: "BOT_BUSY" });
			expect(f.registry.get(bot.id)).toEqual(bot);
			expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual([bot]);
			two.release();
			await f.registry.remove(bot.id, bot.revision);
		},
	);

	it("serializes competing revisions and lease admission; stale and missing revisions cannot mutate", async () => {
		const f = await fixture();
		const bot = await f.registry.upsert(f.input);
		const [updated, stale] = await Promise.allSettled([
			f.registry.upsert({ ...bot, name: "Winner" }),
			f.registry.upsert({ ...bot, name: "Stale" }),
		]);
		expect(updated.status).toBe("fulfilled");
		expect(stale).toMatchObject({ status: "rejected", reason: { code: "BOT_REVISION_CONFLICT" } });
		await expect(f.registry.remove(bot.id, bot.revision)).rejects.toMatchObject({ code: "BOT_REVISION_CONFLICT" });
		await expect(f.registry.upsert({ ...bot, revision: undefined })).rejects.toMatchObject({
			code: "BOT_REVISION_CONFLICT",
		});
		await expect(f.registry.remove("unknown", 1)).rejects.toMatchObject({ code: "BOT_NOT_FOUND" });
		const current = f.registry.get(bot.id)!;
		const leasePromise = f.registry.acquire(bot.id);
		const mutation = expect(f.registry.upsert({ ...current, enabled: false })).rejects.toMatchObject({
			code: "BOT_BUSY",
		});
		const lease = await leasePromise;
		await mutation;
		lease.release();
	});

	it("refuses missing and disabled Bots, and uses the new revision after re-enabling", async () => {
		const f = await fixture();
		const bot = await f.registry.upsert({ ...f.input, enabled: false });
		await expect(f.registry.acquire(bot.id)).rejects.toMatchObject({ code: "BOT_UNAVAILABLE" });
		await expect(f.registry.acquire("missing")).rejects.toMatchObject({ code: "BOT_UNAVAILABLE" });
		const enabled = await f.registry.upsert({ ...bot, enabled: true });
		const lease = await f.registry.acquire(bot.id);
		expect(lease.revision).toBe(`${bot.id}:${enabled.revision}`);
		lease.release();
	});

	it("rejects unsafe paths and revalidates paths before taking a lease", async () => {
		const f = await fixture();
		const plain = join(f.dir, "file");
		await writeFile(plain, "not a directory");
		const link = join(f.dir, "link");
		await symlink(f.cwd, link, process.platform === "win32" ? "junction" : "dir");
		for (const cwd of [
			"",
			"relative",
			homedir(),
			parse(f.cwd).root,
			f.dir,
			plain,
			join(f.dir, "missing"),
			link,
			join(link, "child"),
		]) {
			await expect(f.registry.upsert({ ...f.input, cwd })).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });
		}
		expect(f.registry.list()).toEqual([]);
		const bot = await f.registry.upsert(f.input);
		await rename(f.cwd, join(f.dir, "original"));
		await symlink(join(f.dir, "original"), f.cwd, process.platform === "win32" ? "junction" : "dir");
		await expect(f.registry.acquire(bot.id)).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });
		await f.registry.remove(bot.id, bot.revision);
	});

	it.each(["write", "rename"])(
		"keeps memory and the last committed file intact on actual %s failure",
		async (failure) => {
			const f = await fixture();
			const bot = await f.registry.upsert(f.input);
			const saved = await readFile(f.file, "utf8");
			const backup = join(f.dir, "saved-data");
			if (failure === "write") {
				await rename(f.dataDir, backup);
				await writeFile(f.dataDir, "blocks temporary file creation");
			} else {
				await rename(f.file, backup);
				await mkdir(f.file);
				await writeFile(join(f.file, "blocker"), "prevents replacement");
			}
			for (const operation of [
				() => f.registry.upsert({ ...bot, name: "Unsaved" }),
				() => f.registry.remove(bot.id, bot.revision),
				() => f.registry.upsert({ ...f.input, name: "Unsaved new Bot" }),
			]) {
				await expect(operation()).rejects.toMatchObject({ code: "BOT_SAVE_FAILED" });
				expect(f.registry.list()).toEqual([bot]);
			}
			if (failure === "write") {
				expect(await readFile(join(backup, "device-bots", f.filename), "utf8")).toBe(saved);
				await rm(f.dataDir);
				await rename(backup, f.dataDir);
			} else {
				expect(await readFile(backup, "utf8")).toBe(saved);
				expect(await readdir(f.directory)).toEqual([f.filename]);
				await rm(f.file, { recursive: true });
				await rename(backup, f.file);
			}
			expect((await createLocalBotRegistry(f.dataDir)).list()).toEqual([bot]);
			const updated = await f.registry.upsert({ ...bot, name: "Recovered" });
			expect(updated.revision).toBe(2);
		},
	);

	it.each(["not JSON", "{}", '[{"id":"invalid"}]'])("fails closed on corrupt persisted state: %s", async (contents) => {
		const f = await fixture();
		await writeFile(f.file, contents);
		await expect(createLocalBotRegistry(f.dataDir)).rejects.toThrow();
		expect(await readFile(f.file, "utf8")).toBe(contents);
	});

	it("rejects duplicate persisted identities and malformed configuration without committing", async () => {
		const f = await fixture();
		const bot = await f.registry.upsert(f.input);
		for (const patch of [
			{ name: " " },
			{ model: { provider: "", modelId: "model" } },
			{ tools: ["read", "read"] },
			{ skills: [""] },
			{ mcpServers: [42] },
			{ enabled: "true" },
		]) {
			await expect(f.registry.upsert({ ...bot, ...patch } as LocalBotInput)).rejects.toMatchObject({
				code: "BOT_INVALID",
			});
			expect(f.registry.list()).toEqual([bot]);
		}
		await writeFile(f.file, JSON.stringify([bot, bot]));
		await expect(createLocalBotRegistry(f.dataDir)).rejects.toThrow("Duplicate Bot ID");
	});

	it("模型起草的 Bot 带高权限工具时，必须带上人工确认清单", async () => {
		const f = await fixture();
		const modelIdentity = { authoredBy: "model" as const, authoredAt: Date.now(), modelRevision: 1 };
		await expect(
			f.registry.upsert({ ...f.input, tools: ["read", "bash"], identity: modelIdentity }),
		).rejects.toMatchObject({ code: "BOT_NEEDS_APPROVAL" });
		expect(f.registry.list()).toHaveLength(0);
		const approved = await f.registry.upsert({
			...f.input,
			tools: ["read", "bash"],
			identity: modelIdentity,
			approvedTools: ["bash"],
		});
		expect(approved.tools).toEqual(["read", "bash"]);
		// 人工编辑（authoredBy=human）不受此限；approval 清单不落库。
		const human = await f.registry.upsert({
			...approved,
			identity: { authoredBy: "human", authoredAt: Date.now(), modelRevision: 1 },
		});
		expect(human.tools).toEqual(["read", "bash"]);
		expect(JSON.parse(await readFile(f.file, "utf8"))[0]).not.toHaveProperty("approvedTools");
	});

	it("busy 反映了执行租约（私聊发送前的忙检查靠它）", async () => {
		const f = await fixture();
		const bot = await f.registry.upsert(f.input);
		expect(f.registry.busy(bot.id)).toBe(false);
		const lease = await f.registry.acquire(bot.id);
		try {
			expect(f.registry.busy(bot.id)).toBe(true);
		} finally {
			lease.release();
		}
		expect(f.registry.busy(bot.id)).toBe(false);
	});

	it("SSH 智能体：直连设备工作区保存本地、执行走 SSH 代理", async () => {
		const f = await fixture();
		const bot = await f.registry.upsert({ ...f.input, cwd: "ssh://dev@192.168.1.10:22/home/dev/project/" });
		expect(bot.cwd).toBe("ssh://dev@192.168.1.10:22/home/dev/project");
		expect(f.registry.list()).toEqual([bot]);
		const lease = await f.registry.acquire(bot.id);
		try {
			expect(lease.root).toBe("ssh://dev@192.168.1.10:22/home/dev/project");
		} finally {
			lease.release();
		}
		await expect(f.registry.upsert({ ...bot, cwd: "ssh://bad-uri" })).rejects.toMatchObject({
			code: "WORKSPACE_INVALID",
		});
	});
});
