import { describe, expect, it } from "vitest";
import {
	collectTranscriptFacts,
	EVIDENCE_LIMITS,
	formatEvidenceSummary,
	normalizeEvidenceInput,
	verifyEvidence,
} from "../../server/subagent-evidence.js";

function toolCall(name: string, args: unknown, id = "call-1") {
	return {
		role: "assistant",
		content: [{ type: "toolCall", toolCallId: id, name, args }],
	};
}

describe("normalizeEvidenceInput", () => {
	it("缺省证据不算非法，但空对象也不算证据", () => {
		expect(normalizeEvidenceInput(undefined)).toEqual({ ok: true, value: {} });
		expect(normalizeEvidenceInput({})).toEqual({ ok: false, error: "empty" });
		expect(normalizeEvidenceInput({ none: true })).toEqual({
			ok: true,
			value: { files: [], commands: [], none: true },
		});
	});

	it("拒绝非对象；真形状错误要点名出错字段", () => {
		expect(normalizeEvidenceInput("done")).toEqual({ ok: false, error: "not_object" });
		expect(normalizeEvidenceInput({ commands: [1, null] })).toEqual({
			ok: false,
			error: "invalid_fields",
			fields: ["commands"],
		});
		expect(normalizeEvidenceInput({ files: ["a.ts", 2], commands: ["ls"] })).toMatchObject({
			error: "invalid_fields",
			fields: ["files"],
		});
	});

	// #938：网关强制把可选字段都填满的模型（OpenAI 系）传 `{blocked:"",commands:[],files:[],none:true}`，
	// 旧实现把“传了空数组”判成 invalid_fields，导致它越按推荐格式填越被拒。
	it("空数组、空字符串、false 一律当未填写", () => {
		expect(normalizeEvidenceInput({ blocked: "", commands: [], files: [], none: true })).toEqual({
			ok: true,
			value: { files: [], commands: [], none: true, blocked: undefined },
		});
		expect(normalizeEvidenceInput({ files: ["a.ts"], commands: [] })).toEqual({
			ok: true,
			value: { files: ["a.ts"], commands: [], none: false, blocked: undefined },
		});
		expect(normalizeEvidenceInput({ blocked: "   " })).toEqual({ ok: false, error: "empty" });
	});

	it("四项都空才算 empty", () => {
		expect(normalizeEvidenceInput({})).toEqual({ ok: false, error: "empty" });
		expect(normalizeEvidenceInput({ files: [], commands: [], none: false })).toEqual({ ok: false, error: "empty" });
	});

	it("归一化路径与命令、去重并限量", () => {
		const many = Array.from({ length: EVIDENCE_LIMITS.files + 10 }, (_, i) => `src/f${i}.ts`);
		const parsed = normalizeEvidenceInput({
			files: ["./src\\a.ts", "src/a.ts", ...many],
			commands: ["  npm   test ", "npm test"],
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.files?.[0]).toBe("src/a.ts");
		expect(parsed.value.files).toHaveLength(EVIDENCE_LIMITS.files);
		expect(parsed.value.commands).toEqual(["npm test"]);
	});
});

describe("collectTranscriptFacts", () => {
	it("从工具调用与 bashExecution 里抽文件与命令", () => {
		const facts = collectTranscriptFacts([
			toolCall("edit", { path: "src/a.ts" }, "c1"),
			toolCall("write", { file_path: "./src/b.ts" }, "c2"),
			toolCall("bash", { command: "npm test" }, "c3"),
			{ role: "bashExecution", command: "git status", exitCode: 0 },
			{ role: "bashExecution", command: "npm run lint", exitCode: 2 },
		]);
		expect(facts.editedFiles.sort()).toEqual(["src/a.ts", "src/b.ts"]);
		expect(facts.commands).toEqual([
			{ command: "npm test", failed: false },
			{ command: "git status", failed: false },
			{ command: "npm run lint", failed: true },
		]);
	});

	it("工具结果报错时把对应命令标成失败", () => {
		const facts = collectTranscriptFacts([
			toolCall("bash", { command: "npm test" }, "c9"),
			{ role: "toolResult", toolCallId: "c9", isError: true },
		]);
		expect(facts.commands).toEqual([{ command: "npm test", failed: true }]);
	});

	it("参数是 JSON 字符串也能解析", () => {
		const facts = collectTranscriptFacts([
			{
				role: "assistant",
				content: [{ type: "toolCall", toolCallId: "c4", name: "edit", args: '{"path":"src/c.ts"}' }],
			},
		]);
		expect(facts.editedFiles).toEqual(["src/c.ts"]);
	});
});

describe("verifyEvidence", () => {
	const facts = collectTranscriptFacts([
		toolCall("edit", { path: "src/a.ts" }, "c1"),
		toolCall("bash", { command: "npm test" }, "c2"),
	]);

	it("证据与转录一致时判 pass", () => {
		const evidence = verifyEvidence({ files: ["src/a.ts"], commands: ["npm test"] }, facts);
		expect(evidence.verdict).toBe("pass");
		expect(evidence.issues).toEqual([]);
		expect(evidence.warnings).toEqual([]);
		expect(evidence.matchedFiles).toBe(1);
		expect(evidence.matchedCommands).toBe(1);
	});

	it("声称跑过的命令没跑过 → 硬矛盾（驳回）", () => {
		const evidence = verifyEvidence({ commands: ["npm run build"] }, facts);
		expect(evidence.verdict).toBe("unverified");
		expect(evidence.issues.join("\n")).toContain("never run");
	});

	it("声称没改文件但转录有编辑 → 硬矛盾（驳回）", () => {
		const evidence = verifyEvidence({ none: true }, facts);
		expect(evidence.verdict).toBe("unverified");
		expect(evidence.issues.join("\n")).toContain("declared no file changes");
	});

	it("声称改过的文件没在写入调用里出现 → 只记疑点，降级 partial", () => {
		const evidence = verifyEvidence({ files: ["src/other.ts"] }, facts);
		expect(evidence.verdict).toBe("partial");
		expect(evidence.issues).toEqual([]);
		expect(evidence.warnings.join("\n")).toContain("not seen in this run's edits");
	});

	it("命令在转录里失败 → 硬矛盾", () => {
		const failedFacts = collectTranscriptFacts([
			toolCall("bash", { command: "npm test" }, "c3"),
			{ role: "toolResult", toolCallId: "c3", isError: true },
		]);
		const evidence = verifyEvidence({ commands: ["npm test"] }, failedFacts);
		expect(evidence.issues.join("\n")).toContain("failed in this session");
	});

	it("无证据 → unverified；自述受阻 → blocked", () => {
		expect(verifyEvidence({}, facts).verdict).toBe("unverified");
		const blocked = verifyEvidence({ blocked: "blocked by missing credentials" }, facts);
		expect(blocked.verdict).toBe("blocked");
		expect(blocked.blocked).toContain("credentials");
	});

	it("摘要带裁决与计数", () => {
		const evidence = verifyEvidence({ files: ["src/a.ts"], commands: ["npm test"] }, facts);
		expect(formatEvidenceSummary(evidence, "zh")).toContain("证据已核对");
		expect(formatEvidenceSummary(evidence, "en")).toContain("evidence verified");
	});
});
