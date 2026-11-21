import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginLedgerStore } from "../../server/plugin-ledger.js";
import { RemoteSshService } from "../../server/remote-ssh-service.js";
import { inspectVersionedJson } from "../../server/versioned-store.js";

describe("inspectVersionedJson 三态", () => {
	it("文件不存在与空内容都算 missing（可以按默认值建库）", () => {
		expect(inspectVersionedJson(undefined, "v", 1).status).toBe("missing");
		expect(inspectVersionedJson("   ", "v", 1).status).toBe("missing");
	});

	it("版本号一致才算 ok", () => {
		const inspected = inspectVersionedJson<{ v: number; records: [] }>('{"v":1,"records":[]}', "v", 1);
		expect(inspected.status).toBe("ok");
	});

	it("版本号不认识、坏 JSON、顶层是数组都算 unsupported", () => {
		expect(inspectVersionedJson('{"v":2}', "v", 1).status).toBe("unsupported");
		expect(inspectVersionedJson('{"v":', "v", 1).status).toBe("unsupported");
		expect(inspectVersionedJson("[]", "v", 1).status).toBe("unsupported");
	});
});

describe("#982 认不出的存储文件一律拒绝覆盖", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-versioned-store-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const backups = (name: string, folder = dir): string[] =>
		readdirSync(folder).filter((entry) => entry.startsWith(`${name}.unsupported-`));

	it("global-hosts.json 是更高版本：不覆盖、原样保留并备份", async () => {
		const file = join(dir, "global-hosts.json");
		const original = JSON.stringify({ version: 2, profiles: { work: { name: "work" } } });
		writeFileSync(file, original, "utf8");
		const service = new RemoteSshService(dir);

		expect(await service.listProfiles()).toEqual([]);
		await service.saveProfile("work", { host: "example.com", username: "root", auth: { type: "agent" } });

		expect(readFileSync(file, "utf8")).toBe(original);
		expect(backups("global-hosts.json")).toHaveLength(1);
		expect(readFileSync(join(dir, backups("global-hosts.json")[0]!), "utf8")).toBe(original);
	});

	it("插件账本文件是更高版本：不覆盖、原样保留并备份", () => {
		const file = join(dir, "plugin-inbox", "demo.json");
		mkdirSync(dirname(file), { recursive: true });
		const original = JSON.stringify({ v: 2, records: [{ key: "m1", state: "claimed", direction: "in" }] });
		writeFileSync(file, original, "utf8");

		const store = new PluginLedgerStore({ dataDir: dir, pluginId: "demo", flushDelayMs: 0 });
		store.put(store.newRecord({ key: "m2", direction: "in" }));
		store.flush();

		expect(readFileSync(file, "utf8")).toBe(original);
		expect(backups("demo.json", dirname(file))).toHaveLength(1);
	});

	it("正常版本照旧写盘（守卫生效但不误伤）", () => {
		const file = join(dir, "plugin-inbox", "demo.json");
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ v: 1, records: [] }), "utf8");

		const store = new PluginLedgerStore({ dataDir: dir, pluginId: "demo", flushDelayMs: 0 });
		store.put(store.newRecord({ key: "m2", direction: "in" }));
		store.flush();

		const written = JSON.parse(readFileSync(file, "utf8")) as { v: number; records: Array<{ key: string }> };
		expect(written.v).toBe(1);
		expect(written.records.map((r) => r.key)).toEqual(["m2"]);
		expect(backups("demo.json", dirname(file))).toHaveLength(0);
	});
});
