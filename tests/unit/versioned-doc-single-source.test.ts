import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 守卫：「版本化文档的读−校验−写」只能有一份实现（issues #982）。
 *
 * 事故形态：五个存储各写一遍「读盘 → 版本不认识 → 当空库 → 下次保存写回」，用户数据被永久覆盖；
 * 另有两个 PR 各自给出相反的自救语义（改名继续写 / 拷贝永久拒写）。根因不是那几行写错了，而是
 * 判据没有唯一载体 —— 所以这里用源码扫描把它钉住：
 *
 * 1. 「读文件 + JSON.parse + 版本比较 + 写文件」四件事同时出现在一个文件里，就是又抄了一份；
 *    这类文件必须走上 `server/versioned-doc.ts`（四态 + handle 同时拥有读写），或者进下面的存量名单。
 * 2. 存量名单只许变短：迁完一个就删一行，别往里加。
 * 3. 会话转录的每个 `SessionManager.open` 前面都必须有版本门禁（`assertSupportedTranscriptVersion`）。
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER = join(ROOT, "server");
const OWNER = join(SERVER, "versioned-doc.ts");

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (entry.name.endsWith(".ts")) out.push(path);
	}
	return out;
}

/** 去掉注释只留代码：注释里写「版本不认识」是在解释根因，不该算违规。 */
function codeOf(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const VERSION_COMPARISON = /\.(version|v)\s*[!=]==/;
const JSON_PARSE = /JSON\.parse\(/;
const FILE_READ = /\breadFile(Sync|SyncRetry)?\s*\(/;
const FILE_WRITE = /writeJsonAtomicSync\(|writeAtomicSync\(|writeFileSync\(|\bwriteFile\(/;

/**
 * 存量名单（只许变短）。每一行都是「还没迁到 versioned-doc」的同形态存储，
 * 迁完把行删掉；新增行只有在证明它不是版本化文档时才允许（并在注释里写清楚）。
 */
const LEGACY_STORES = new Set([
	"server/claim-store.ts",
	"server/compaction-state.ts",
	"server/device-center/device-portals.ts",
	"server/device-center/hub-transaction-log.ts",
	"server/device-center/mobile-notification-forwarder.ts",
	"server/device-center/publication-journal.ts",
	"server/device-center/store.ts",
	// 已经是「解析失败 → 置 loadError → 写路径抛错」的正确范式，迁到 primitive 属于清账。
	"server/device-center/task-recovery.ts",
	"server/device-center/task-report-outbox.ts",
	"server/device-center/transfers.ts",
	"server/mcp-manager.ts",
	"server/plugin-materialize.ts",
	"server/plugin-secrets.ts",
	"server/plugin-updater.ts",
	"server/plugins.ts",
	"server/sandbox-data.ts",
]);

const serverFiles = walk(SERVER).filter((file) => file !== OWNER);

describe("版本化文档单源（issues #982）", () => {
	it("「读文件 + 版本比较 + 写文件」组合只出现在 versioned-doc.ts 或存量名单里", () => {
		const offenders: string[] = [];
		for (const file of serverFiles) {
			const source = codeOf(readFileSync(file, "utf8"));
			if (!VERSION_COMPARISON.test(source)) continue;
			if (!JSON_PARSE.test(source) || !FILE_READ.test(source) || !FILE_WRITE.test(source)) continue;
			if (source.includes("versioned-doc.js")) continue;
			const id = relative(ROOT, file).split("\\").join("/");
			if (LEGACY_STORES.has(id)) continue;
			offenders.push(id);
		}
		expect(
			offenders,
			`以下文件又抄了一份「读−校验−写」：请改用 server/versioned-doc.ts 的 openVersionedDoc\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("存量名单里的每一行都还存在（迁移后请同步删行，别让名单空转）", () => {
		const missing = [...LEGACY_STORES].filter(
			(id) => !readdirSync(join(ROOT, id.slice(0, id.lastIndexOf("/")))).includes(id.slice(id.lastIndexOf("/") + 1)),
		);
		expect(missing, `名单指向了不存在的文件：${missing.join(", ")}`).toEqual([]);
	});

	it("#982 点名的五个存储都走单源", () => {
		const mustUsePrimitive = [
			"server/plugin-ledger.ts",
			"server/remote-ssh-service.ts",
			"server/device-center/partition-log.ts",
			"server/device-center/runtime.ts",
		];
		const notMigrated = mustUsePrimitive.filter(
			(id) => !codeOf(readFileSync(join(ROOT, id), "utf8")).includes("versioned-doc.js"),
		);
		expect(notMigrated, `这些存储还没走 versioned-doc：${notMigrated.join(", ")}`).toEqual([]);
		expect(codeOf(readFileSync(join(ROOT, "server/session-open.ts"), "utf8"))).toContain(
			"assertSupportedTranscriptVersion",
		);
	});

	it("每个直接 SessionManager.open 之前都有转录版本门禁", () => {
		const source = codeOf(readFileSync(join(ROOT, "server/agent-service.ts"), "utf8"));
		const opens = source.match(/SessionManager\.open\(/g)?.length ?? 0;
		const gates = source.match(/assertSupportedTranscriptVersion\(/g)?.length ?? 0;
		expect(opens).toBeGreaterThan(0);
		// 唯一豁免点是删除路径（读 native-cli 配置后 rmSync）：删除是用户的自救出口，
		// 不能被版本门禁挡住，否则认不出的转录就再也删不掉了。
		expect(gates, "SessionManager.open 与版本门禁数量不一致：新增打开点请同时加门禁").toBeGreaterThanOrEqual(opens - 1);
	});

	it("挡住的存储必须出现在 /api/health 里（不许只有一行 console）", () => {
		const source = codeOf(readFileSync(join(ROOT, "server/index.ts"), "utf8"));
		expect(source).toContain("storageIntegritySnapshot()");
	});
});
