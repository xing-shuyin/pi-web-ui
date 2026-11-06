import { describe, expect, it } from "vitest";
import { applyHashlinePatch } from "../../server/hashline-engine.js";

const BASE = "line1\nline2\nline3\nline4\nline5\n";

function run(patch: string): { report: ReturnType<typeof applyHashlinePatch>; written: string } {
	let written = "";
	const report = applyHashlinePatch(patch, {
		cwd: "/w",
		readFile: () => BASE,
		writeFile: (_p, content) => {
			written = content;
		},
	});
	return { report, written };
}

describe("hashline insert 锚点重叠校验（audit fix #5）", () => {
	it("insert_before 锚点行落在 put_range 内 → 明确报错", () => {
		const { report } = run("[a.txt]\nPUT <2:\n+inserted\nPUT 2.=3:\n+replaced2\n+replaced3\n");
		expect(report.ok).toBe(false);
		expect(report.summary).toContain("重叠");
	});

	it("insert_after 锚点行与 cut_range 重叠 → 明确报错", () => {
		const { report } = run("[a.txt]\nPUT >4:\n+inserted\nCUT 4.=4\n");
		expect(report.ok).toBe(false);
		expect(report.summary).toContain("重叠");
	});

	it("两个 insert 锚在同一行 → 明确报错（执行顺序歧义）", () => {
		const { report } = run("[a.txt]\nPUT <2:\n+one\nPUT >2:\n+two\n");
		expect(report.ok).toBe(false);
		expect(report.summary).toContain("重叠");
	});

	it("insert 锚点行与 replace 不重叠 → 正常应用，行号语义正确", () => {
		const { report, written } = run("[a.txt]\nPUT <2:\n+inserted\nPUT 3.=3:\n+replaced3\n");
		expect(report.ok).toBe(true);
		expect(written).toBe("line1\ninserted\nline2\nreplaced3\nline4\nline5\n");
	});

	it("两个 insert 锚不同行 → 都生效，互不串位", () => {
		const { report, written } = run("[a.txt]\nPUT <2:\n+one\nPUT >3:\n+two\n");
		expect(report.ok).toBe(true);
		expect(written).toBe("line1\none\nline2\nline3\ntwo\nline4\nline5\n");
	});

	it("尾部 $ 锚与最后一行的 replace 重叠 → 报错", () => {
		const { report } = run("[a.txt]\nPUT >$:\n+tail-ins\nPUT 5.=5:\n+replaced5\n");
		expect(report.ok).toBe(false);
		expect(report.summary).toContain("重叠");
	});
});
