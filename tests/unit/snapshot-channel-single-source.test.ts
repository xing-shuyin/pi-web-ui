import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 守卫：**出帧（全量 / 增量的判定与拼装）只有闸里那一份**——
 * `docs/agent-rules.md` 的红线「出帧只走 `snapshot-channel`；禁在 emit 处手判全量/增量」。
 *
 * 事故形态（本次补齐）：pi 引擎早把判定收进了 `server/snapshot-channel.ts`，dsh 与 universal
 * 却各自留了一套——dsh 在 `emitSnapshotNow()` 里比 `emittedMessages` 前缀、自己拼 `snapshot_delta`
 * 的 `baseRev`（读的是**会话级**基线，扇出时落后连接必然失配）；universal 干脆永远发全量
 * （`flushSnapshot(_forceFull)` 的形参都没用），流式期每 60ms 一帧整包状态。
 *
 * 这一组断言不验行为、只验**形状**。三条机器判据：
 * 1. 闸外不许拼帧——instruction 只要不出现 `type: "snapshot"` / `"snapshot_delta"`，就**不可能**自己出帧；
 * 2. 闸外不许记「上一帧发过什么」——`emitted*` 这种会话级基线是第二份判据的开端；
 * 3. 闸外不许自己装配增量的 `baseRev`。
 *
 * `forceFull` 这类形参本身不算违规：它只许**转发**给闸（`{ force }`）。凡是要「依据它分支」的地方，
 * 分支两头必然要拼两种帧之一，判据 1 就是这件事的机器判据。
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** 扫描面：老服务树 + 内核树。`web/**` 只消费帧，不算违规面。 */
const SCAN_DIRS = ["server", join("packages", "keel", "src")].map((dir) => join(ROOT, dir));

/**
 * 判据本体（闸）：只有这些文件有权回答「这一帧发不发 / 发全量还是增量」。
 * - `server/snapshot-channel.ts`：红线点名的单源（每个 sink 一份基线）。
 * - `packages/keel/src/domains/snapshots/{snapshot-plan,publisher,builders}.ts`：**内核树里同形的闸**
 *   （判据 / 闸 / 帧拼装三层，由 `packages/keel/src/app/**` 调用），不是「引擎自判」。
 *   本表只许变短：真要并进 `snapshot-channel.ts`，请删行，别加行。
 */
const GATE = new Set([
	"server/snapshot-channel.ts",
	"packages/keel/src/domains/snapshots/snapshot-plan.ts",
	"packages/keel/src/domains/snapshots/publisher.ts",
	"packages/keel/src/domains/snapshots/builders.ts",
]);

/** 引擎侧唯一的扇出叶子：只把 `SnapshotProduct` 转手给每个 sink 的闸，自己不做任何判定。 */
const FANOUT_LEAF = "server/snapshot-sinks.ts";

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (entry.name.endsWith(".ts")) out.push(path);
	}
	return out;
}

const files = SCAN_DIRS.flatMap((dir) => walk(dir))
	.map((abs) => relative(ROOT, abs).split(sep).join("/"))
	.sort();

/** 去掉注释：解释根因时提到 `snapshot_delta` 是正当的，不该算违规。 */
function codeOf(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const code = new Map(files.map((file) => [file, codeOf(readFileSync(join(ROOT, file), "utf8"))]));

function offenders(rule: RegExp): string[] {
	return files.filter((file) => !GATE.has(file) && rule.test(code.get(file) ?? ""));
}

const hint = "请改成把 SnapshotProduct 交给闸（server/snapshot-sinks.ts → SnapshotChannel / SnapshotPublisher）";

describe("出帧单源：判定与拼帧只在闸里（docs/agent-rules.md 红线）", () => {
	it("闸外不许自己拼 snapshot / snapshot_delta 帧", () => {
		const bad = offenders(/\btype:\s*"snapshot(?:_delta)?"\s*[,}]/);
		expect(bad, `这些地方在自己拼帧，${hint}：${bad.join(", ")}`).toEqual([]);
	});

	it("闸外不许自己记「上一帧发过什么」（会话级基线 = 第二份判据）", () => {
		const bad = offenders(/\bemitted(?:Messages|Ids|Rev|At|Key|Seq)\b/);
		expect(bad, `这些地方自持出帧基线，${hint}：${bad.join(", ")}`).toEqual([]);
	});

	it("闸外不许自己装配增量的 baseRev", () => {
		// 只抓「装配一个值」，放过协议里的类型声明（`baseRev: number`）与读取（`msg.baseRev`）。
		const bad = offenders(/\bbaseRev\s*:(?![ \t]*(?:number|string|boolean)\b)/);
		expect(bad, `这些地方在自己算增量的 baseRev，${hint}：${bad.join(", ")}`).toEqual([]);
	});
});

describe("引擎侧的扇出叶子只是转手", () => {
	const leaf = code.get(FANOUT_LEAF);

	it(`${FANOUT_LEAF} 存在，并且把判定真的委托给 snapshot-channel`, () => {
		expect(leaf, `${FANOUT_LEAF} 不存在：dsh / universal 就没地方复用同一份闸了`).toBeTruthy();
		expect(leaf).toContain("./snapshot-channel.js");
	});

	it("叶子里不拼帧、不判据、不留基线（只转手）", () => {
		for (const [rule, why] of [
			[/\btype:\s*"snapshot(?:_delta)?"/, "不许拼帧"],
			[/\bbaseRev\b/, "不许碰增量的 baseRev"],
			[/\bemitted\w+/, "不许自持基线"],
			[/\bsince\s*(?:===|!==)/, "不许自己比 since（那是闸里的事）"],
		] as const) {
			expect(rule.test(leaf ?? ""), `${FANOUT_LEAF} ${why}`).toBe(false);
		}
	});
});

describe("其它引擎的出帧确实走了同一份闸", () => {
	it.each(["server/dsh/dsh-agent-service.ts", "server/universal/universal-session.ts"])(
		"%s 用扇出叶子出帧（而不是自己发）",
		(file) => {
			const source = code.get(file) ?? "";
			expect(source, `${file} 没 import 扇出叶子`).toContain("snapshot-sinks.js");
			expect(source, `${file} 没用上扇出叶子`).toMatch(/new SnapshotSinkSet\(/);
		},
	);
});
