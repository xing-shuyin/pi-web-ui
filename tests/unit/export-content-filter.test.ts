// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyExportContentFilter } from "../../web/src/message-image.js";

function sampleCard(): HTMLElement {
	const root = document.createElement("div");
	root.innerHTML =
		'<div class="thinking"><div class="thinking-body">think</div></div>' +
		'<div class="toolcall"><div class="toolcall-body">tool</div></div>' +
		'<div class="msg-text">hello</div>';
	return root;
}

describe("applyExportContentFilter", () => {
	it("默认去掉思考和工具，只留正文", () => {
		const root = sampleCard();
		applyExportContentFilter(root, {});
		expect(root.querySelector(".thinking")).toBeNull();
		expect(root.querySelector(".toolcall")).toBeNull();
		expect(root.querySelector(".msg-text")?.textContent).toBe("hello");
	});

	it("打开开关则保留对应块", () => {
		const both = sampleCard();
		applyExportContentFilter(both, { includeThinking: true, includeTools: true });
		expect(both.querySelector(".thinking")).not.toBeNull();
		expect(both.querySelector(".toolcall")).not.toBeNull();

		const thinkOnly = sampleCard();
		applyExportContentFilter(thinkOnly, { includeThinking: true });
		expect(thinkOnly.querySelector(".thinking")).not.toBeNull();
		expect(thinkOnly.querySelector(".toolcall")).toBeNull();
	});
});
