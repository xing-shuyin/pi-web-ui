/**
 * 逐条用例打印「结束时刻 + 耗时」，并在收尾打印慢榜。
 *
 * 为什么需要：默认 reporter 在 `silent: true` 下不打印任何 per-file / per-test 行，
 * 全量 `npm test` 跑十几分钟却看不到「哪一条慢、慢在哪」，只能事后靠 --reporter=json 复盘。
 *
 * 开关（环境变量）：
 * - `PI_TEST_TIMING=all`（默认）逐条打印；
 * - `PI_TEST_TIMING=slow` 只打印耗时 ≥ `PI_TEST_SLOW_MS`（默认 1000ms）的用例；
 * - `PI_TEST_TIMING=off` 只保留收尾小结。
 *
 * 时间戳取自 vitest 的 `diagnostic()`（startTime + duration），比在宿主进程里 `Date.now()`
 * 打点更准：worker 里跑完的那一刹那，而不是结果回传到主进程的那一刹那。
 */

const MODE = (process.env.PI_TEST_TIMING ?? "all").toLowerCase();
const SLOW_MS = Number(process.env.PI_TEST_SLOW_MS ?? 1000);
const TOP_N = Number(process.env.PI_TEST_TIMING_TOP ?? 20);
import { HEAVY_SUITE } from "./suite-partition.mjs";

const pad2 = (n) => String(n).padStart(2, "0");

/** epoch ms -> HH:MM:SS.mmm（本地时区，日志可直接和终端时间对齐） */
function clock(epochMs) {
	const d = new Date(epochMs);
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** 耗时：<1s 用 ms（3 位有效），否则秒；右对齐成一列，肉眼扫一列就是齐的 */
function secs(ms) {
	if (ms < 1000) return `${Math.round(ms)}ms`.padStart(7);
	const s = ms / 1000;
	return `${s < 10 ? s.toFixed(2) : s.toFixed(1)}s`.padStart(7);
}

/** vitest 的 fullName 带 `relativeModuleId > ` 前缀，去掉避免和前面的文件名重复 */
function shortName(fullName, file) {
	return file && fullName.startsWith(`${file} > `) ? fullName.slice(file.length + 3) : fullName;
}

const STATE_MARK = { passed: "✓", failed: "✗", skipped: "○", pending: "·" };

export default class TestTimingReporter {
	constructor() {
		this.slowest = [];
		this.perFile = new Map();
		this.startedAt = 0;
		this.counts = { passed: 0, failed: 0, skipped: 0, pending: 0 };
	}

	onInit() {
		this.startedAt = Date.now();
	}

	onTestCaseResult(testCase) {
		const state = testCase.result().state;
		this.counts[state] = (this.counts[state] ?? 0) + 1;
		if (state === "pending") return;

		const diag = testCase.diagnostic();
		const duration = diag?.duration ?? 0;
		const startTime = diag?.startTime ?? Date.now() - duration;
		const endTime = startTime + duration;
		const file = testCase.module?.relativeModuleId ?? "";
		const name = shortName(testCase.fullName, file);

		const entry = { file, name, state, duration, endTime };
		if (state !== "skipped") this.slowest.push(entry);

		const fileRow = this.perFile.get(file) ?? { duration: 0, tests: 0 };
		fileRow.duration += duration;
		fileRow.tests += 1;
		this.perFile.set(file, fileRow);

		if (MODE === "off") return;
		if (MODE === "slow" && duration < SLOW_MS) return;
		console.log(`${clock(endTime)}  ${secs(duration)}  ${STATE_MARK[state] ?? "?"} ${file} › ${name}`);
	}

	onTestRunEnd(testModules) {
		const wallMs = Date.now() - this.startedAt;
		const files = [...this.perFile.entries()].map(([file, row]) => ({ file, ...row }));
		const testMs = files.reduce((a, f) => a + f.duration, 0);
		const parallelism = wallMs > 0 ? testMs / wallMs : 0;
		const ranHeavy = files.some((f) => HEAVY_SUITE.includes(f.file));

		const lines = [];
		lines.push("");
		lines.push("── 用例耗时小结 " + "─".repeat(48));
		lines.push(
			`用例 ${this.counts.passed + this.counts.failed + this.counts.skipped}（✓${this.counts.passed} ✗${this.counts.failed} ○${this.counts.skipped}）` +
				` · 文件 ${files.length} · 墙钟 ${secs(wallMs).trim()} · 用例累计 ${(testMs / 1000).toFixed(1)}s` +
				` · 并行系数 ${parallelism.toFixed(2)}×`,
		);

		const filesByDuration = [...files].sort((a, b) => b.duration - a.duration);
		if (filesByDuration.length) {
			const topFiles = filesByDuration.slice(0, Math.min(10, TOP_N));
			const topFileMs = topFiles.reduce((a, f) => a + f.duration, 0);
			lines.push(
				`最慢 ${topFiles.length} 个文件合计 ${(topFileMs / 1000).toFixed(0)}s` +
					`（占用例累计 ${testMs ? ((100 * topFileMs) / testMs).toFixed(0) : 0}%）`,
			);
			for (const f of topFiles) lines.push(`  ${secs(f.duration)}  ${String(f.tests).padStart(4)} 条  ${f.file}`);
		}

		this.slowest.sort((a, b) => b.duration - a.duration);
		if (this.slowest.length) {
			lines.push(`最慢 ${Math.min(TOP_N, this.slowest.length)} 条用例`);
			for (const t of this.slowest.slice(0, TOP_N)) {
				lines.push(
					`  ${secs(t.duration)}  结束 ${clock(t.endTime)}  ${STATE_MARK[t.state] ?? "?"} ${t.file} › ${t.name}`,
				);
			}
		}
		lines.push("─".repeat(60));
		if (!ranHeavy)
			lines.push(`本次未含 ${HEAVY_SUITE.length} 个重型集成文件（真 git / 真子进程）——全量：npm run test:all`);
		console.log(lines.join("\n"));
	}
}
