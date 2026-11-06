// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { Dialog, parseCommandPrompt } from "../../web/src/components/Dialog.js";
import { setAppSend } from "../../web/src/app-globals.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import * as composerBridge from "../../web/src/composer-bridge.js";

let root: Root | null = null;
let currentContainer: HTMLDivElement | null = null;

function setNativeValue(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
	act(() => {
		setter.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function mount(dialog: Parameters<typeof Dialog>[0]["dialog"]) {
	if (root) {
		act(() => root!.unmount());
		root = null;
	}
	if (currentContainer) {
		currentContainer.remove();
		currentContainer = null;
	}
	const container = document.createElement("div");
	document.body.appendChild(container);
	currentContainer = container;
	root = createRoot(container);
	const sent: unknown[] = [];
	setAppSend((msg) => {
		sent.push(msg);
		return true;
	});
	act(() => {
		root!.render(createElement(LanguageProvider, null, createElement(Dialog, { dialog })));
	});
	return { container, sent };
}

afterEach(() => {
	if (root) {
		act(() => root!.unmount());
		root = null;
	}
	if (currentContainer) {
		currentContainer.remove();
		currentContainer = null;
	}
	vi.restoreAllMocks();
});

describe("Command Prompt Parser (issue #747)", () => {
	it("parses multiline command with risk keywords into structured command box", () => {
		const raw = `⚠️ Dangerous command:\n\n  printf 'DISPLAY ONLY line 1'\n  printf 'DISPLAY ONLY line 2'\n\nAllow?`;
		const parsed = parseCommandPrompt(raw);
		expect(parsed.hasRisk).toBe(true);
		expect(parsed.intro).toBe("⚠️ Dangerous command:");
		expect(parsed.command).toContain("printf 'DISPLAY ONLY line 1'");
		expect(parsed.command).toContain("printf 'DISPLAY ONLY line 2'");
		expect(parsed.outro).toBe("Allow?");
	});

	it("detects dangerous destructive commands like rm -rf", () => {
		const raw = `Please confirm:\n\`\`\`bash\nrm -rf /tmp/test-dir\n\`\`\`\nProceed?`;
		const parsed = parseCommandPrompt(raw);
		expect(parsed.hasRisk).toBe(true);
		expect(parsed.command).toBe("rm -rf /tmp/test-dir");
	});

	it("parses multiline bash script with set -e and variable assignments without indentation (issue #780)", () => {
		const raw = [
			"set -e",
			'TEST_DIR="$(mktemp -d /tmp/pi-dialog-layout-test.XXXXXX)"',
			"printf 'step  1: initialize test workspace at %s\\n' \"$TEST_DIR\"",
			'touch "$TEST_DIR/alpha"',
			'rm -rf "$TEST_DIR"',
		].join("\n");
		const parsed = parseCommandPrompt(raw);
		expect(parsed.hasRisk).toBe(true);
		expect(parsed.command).toContain("set -e");
		expect(parsed.command).toContain('TEST_DIR="$(mktemp -d /tmp/pi-dialog-layout-test.XXXXXX)"');
		expect(parsed.command).toContain('rm -rf "$TEST_DIR"');
	});

	it("leaves plain non-command text intact", () => {
		const raw = "Please select the target environment to deploy.";
		const parsed = parseCommandPrompt(raw);
		expect(parsed.command).toBeNull();
		expect(parsed.intro).toBe(raw);
	});
});

describe("Dialog component: 3-tier layout, command inspector, and reject-with-feedback", () => {
	it("renders 3-tier viewport layout with command inspector box", () => {
		const longCommand = Array.from(
			{ length: 20 },
			(_, i) => `printf 'DISPLAY ONLY line ${i + 1} long-path-segment/'`,
		).join("\n");
		const fullTitle = `⚠️ Dangerous command:\n\n  ${longCommand}\n\nAllow?`;

		const { container } = mount({
			id: 1,
			kind: "select",
			title: fullTitle,
			args: [["Yes", "No"]],
		});

		const head = container.querySelector(".dialog-head");
		const scrollBody = container.querySelector(".dialog-scroll-body");
		const footer = container.querySelector(".dialog-footer");
		expect(head).not.toBeNull();
		expect(scrollBody).not.toBeNull();
		expect(footer).not.toBeNull();

		const headTitle = head?.querySelector(".dialog-title");
		expect(headTitle?.textContent).toBe("⚠️ Dangerous command:");
		expect(headTitle?.getAttribute("title")).toBe(fullTitle);

		const cmdBox = scrollBody?.querySelector(".dialog-cmd-box");
		expect(cmdBox).not.toBeNull();
		expect(cmdBox?.classList.contains("has-risk")).toBe(true);
		expect(cmdBox?.querySelector(".dialog-cmd-risk")).not.toBeNull();

		const lines = cmdBox?.querySelectorAll(".dialog-cmd-line");
		expect(lines).toHaveLength(20);

		const toggleBtn = cmdBox?.querySelector(".dialog-cmd-actions button");
		expect(toggleBtn).not.toBeNull();

		const options = footer?.querySelectorAll(".dialog-option");
		expect(options).toHaveLength(2);
		expect(options?.[0].textContent).toContain("Yes");
		expect(options?.[0].querySelector(".dialog-opt-badge")?.textContent).toBe("Y");
		expect(options?.[1].textContent).toContain("No");
		expect(options?.[1].querySelector(".dialog-opt-badge")?.textContent).toBe("N");

		expect(container.querySelector(".dialog-custom-row")).toBeNull();
	});

	it("supports Y and N single-key shortcuts", () => {
		const { container, sent } = mount({
			id: 2,
			kind: "select",
			title: "Dangerous operation",
			args: [["Yes", "No"]],
		});

		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "y" }));
		});
		expect(sent).toEqual([{ type: "dialog_response", id: 2, value: "Yes" }]);

		const { sent: sent2 } = mount({
			id: 3,
			kind: "select",
			title: "Dangerous operation",
			args: [["Yes", "No"]],
		});
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "n" }));
		});
		expect(sent2).toEqual([{ type: "dialog_response", id: 3, value: "No" }]);
	});

	it("handles reject-with-feedback: submits clean 'No' and injects feedback into composer", () => {
		const composeSpy = vi.spyOn(composerBridge, "composeToComposer").mockImplementation(() => true);
		const focusSpy = vi.spyOn(composerBridge, "focusComposer").mockImplementation(() => true);

		const { container, sent } = mount({
			id: 4,
			kind: "select",
			title: "Dangerous command",
			args: [["Yes", "No"]],
		});

		const rejectToggle = container.querySelector(".dialog-reject-toggle") as HTMLButtonElement;
		expect(rejectToggle).not.toBeNull();
		act(() => {
			rejectToggle.click();
		});

		const rejectInput = container.querySelector(".dialog-reject-input") as HTMLInputElement;
		expect(rejectInput).not.toBeNull();

		setNativeValue(rejectInput, "请改去清空 temp 目录，不要删除整库");

		const submitBtn = container.querySelector(".dialog-reject-input-row .btn") as HTMLButtonElement;
		act(() => {
			submitBtn.click();
		});

		expect(sent).toEqual([{ type: "dialog_response", id: 4, value: "No" }]);

		expect(composeSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				text: expect.stringContaining("请改去清空 temp 目录，不要删除整库"),
			}),
		);
		expect(focusSpy).toHaveBeenCalled();
	});

	it("keyboard arrow keys navigate options and Enter submits selection", () => {
		const { container, sent } = mount({
			id: 5,
			kind: "select",
			title: "Branch",
			args: [["main", "dev", "test"]],
		});

		const options = container.querySelectorAll(".dialog-option");
		expect(options[0].classList.contains("sel")).toBe(true);

		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
		});
		expect(options[1].classList.contains("sel")).toBe(true);

		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		});
		expect(sent).toEqual([{ type: "dialog_response", id: 5, value: "dev" }]);
	});

	it("dismiss button sends null response", () => {
		const { container, sent } = mount({
			id: 6,
			kind: "select",
			title: "Simple select",
			args: [["A", "B"]],
		});

		const dismissBtn = container.querySelector(".dialog-dismiss") as HTMLButtonElement;
		expect(dismissBtn).not.toBeNull();
		act(() => {
			dismissBtn.click();
		});
		expect(sent).toEqual([{ type: "dialog_response", id: 6, value: null }]);
	});

	it("confirm dialog renders 3-tier structure and handles OK / Cancel with Y/N", () => {
		const { container, sent } = mount({
			id: 7,
			kind: "confirm",
			title: "Delete file",
			args: ["Are you sure you want to delete this file?"],
		});

		const headTitle = container.querySelector(".dialog-head .dialog-title");
		expect(headTitle?.textContent).toBe("Delete file");

		const scrollBody = container.querySelector(".dialog-scroll-body");
		expect(scrollBody?.textContent).toContain("Are you sure you want to delete this file?");

		const footer = container.querySelector(".dialog-footer");
		const buttons = footer?.querySelectorAll(".dialog-actions .btn");
		expect(buttons).toHaveLength(2);

		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "y" }));
		});
		expect(sent).toEqual([{ type: "dialog_response", id: 7, value: true }]);
	});

	it("renders structured code box directly when code prop is supplied", () => {
		const script = 'rm -rf "$TARGET_DIR"\necho "cleaned"';
		const { container } = mount({
			id: 8,
			kind: "select",
			title: "Dangerous operation requested",
			args: [["Yes", "No"]],
			code: {
				content: script,
				language: "bash",
				hasRisk: true,
			},
		});

		const cmdBox = container.querySelector(".dialog-cmd-box");
		expect(cmdBox).not.toBeNull();
		expect(cmdBox?.textContent).toContain('rm -rf "$TARGET_DIR"');
		expect(cmdBox?.classList.contains("has-risk")).toBe(true);
	});
});
