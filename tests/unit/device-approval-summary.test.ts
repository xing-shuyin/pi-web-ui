import { describe, expect, it } from "vitest";
import { approvalOperationSummary } from "../../server/device-center/approval-summary.js";

describe("public approval operation summaries", () => {
	it("describes write size without disclosing content or destination", () => {
		const summary = approvalOperationSummary("write", { path: "/private/token.txt", content: "秘密🙂" });
		expect(summary).toContain("write a file");
		expect(summary).toContain("10 bytes");
		expect(summary).not.toContain("秘密");
		expect(summary).not.toContain("token.txt");
	});
	it("exposes replacement count without old and new text", () => {
		const summary = approvalOperationSummary("edit", {
			edits: [{ oldText: "token=secret", newText: "password=other" }],
		});
		expect(summary).toContain("Replacement count: 1");
		expect(summary).not.toContain("secret");
		expect(summary).not.toContain("password");
	});
	it("does not infer shell safety from command text or expose embedded credentials", () => {
		const summary = approvalOperationSummary("bash", {
			command: "curl -H 'Authorization: Bearer secret' https://private.invalid",
		});
		expect(summary).toContain("May affect files, processes or network");
		expect(summary).not.toMatch(/secret|private\.invalid|curl/);
	});
	it("uses a fixed conservative summary for unknown tools and malformed input", () => {
		const summary = approvalOperationSummary("custom-secret-name", null);
		expect(summary).toContain("not classified");
		expect(summary).not.toContain("custom-secret-name");
	});
});
