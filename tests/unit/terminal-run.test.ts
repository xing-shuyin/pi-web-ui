// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { deriveTerminalTitle, normalizeTerminalCommand, runInTerminal } from "../../web/src/terminal-run.js";
import { RunInTerminalButton } from "../../web/src/components/terminal-run-button.js";

let root: Root | null = null;

afterEach(() => {
	vi.useRealTimers();
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("normalizeTerminalCommand", () => {
	it("空字符串或纯空白返回空", () => {
		expect(normalizeTerminalCommand("")).toBe("");
		expect(normalizeTerminalCommand("   \n\t\n  ")).toBe("");
	});

	it("剥离常见命令行提示符 $ / > / %", () => {
		expect(normalizeTerminalCommand("$ npm install")).toBe("npm install");
		expect(normalizeTerminalCommand("  $ git status")).toBe("git status");
		expect(normalizeTerminalCommand("> cargo build --release")).toBe("cargo build --release");
		expect(normalizeTerminalCommand("% brew update")).toBe("brew update");
	});

	it("多行提示符逐行剥离", () => {
		const raw = `$ git add .
$ git commit -m "feat: init"
$ git push origin main`;
		expect(normalizeTerminalCommand(raw)).toBe(`git add .
git commit -m "feat: init"
git push origin main`);
	});

	it("保留普通 shell 变量展开与环境变量", () => {
		expect(normalizeTerminalCommand("echo $VAR")).toBe("echo $VAR");
		expect(normalizeTerminalCommand("export FOO=$BAR")).toBe("export FOO=$BAR");
		expect(normalizeTerminalCommand("$VAR=123")).toBe("$VAR=123");
	});

	it("统一换行符为 \\n 并去除首尾空行", () => {
		expect(normalizeTerminalCommand("\r\nls -la\r\npwd\r\n")).toBe("ls -la\npwd");
	});
});

describe("deriveTerminalTitle", () => {
	it("优先提取第一条非注释命令行", () => {
		const code = `# 这是一个注释
// 这也是注释
pnpm dev --port 3000`;
		expect(deriveTerminalTitle(code)).toBe("pnpm dev --port 3000");
	});

	it("全为注释时回退到第一行", () => {
		const code = `# 单纯的注释\n# 第二行`;
		expect(deriveTerminalTitle(code)).toBe("# 单纯的注释");
	});

	it("超过 28 字符时截断并加上省略号", () => {
		const longCmd = "docker run -d -p 8080:80 --name test-container nginx:alpine";
		const title = deriveTerminalTitle(longCmd);
		expect(title.length).toBeLessThanOrEqual(28);
		expect(title.endsWith("…")).toBe(true);
	});
});

describe("runInTerminal", () => {
	it("空代码返回 false 且不派发事件", () => {
		const spy = vi.spyOn(window, "dispatchEvent");
		expect(runInTerminal("   ")).toBe(false);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it("有效命令正常派发 pi-web-ui:plugin-run-command 事件", () => {
		let dispatchedDetail: unknown = null;
		const handler = (e: Event) => {
			dispatchedDetail = (e as CustomEvent).detail;
		};
		window.addEventListener("pi-web-ui:plugin-run-command", handler);

		const ok = runInTerminal("$ npm run build");
		expect(ok).toBe(true);
		expect(dispatchedDetail).toEqual({
			title: "npm run build",
			command: "npm run build",
		});

		window.removeEventListener("pi-web-ui:plugin-run-command", handler);
	});
});

describe("RunInTerminalButton 组件", () => {
	it("空文本时不渲染任何内容", () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		act(() => {
			root!.render(createElement(RunInTerminalButton, { code: "" }));
		});
		expect(container.innerHTML).toBe("");
	});

	it("点击按钮触发终端执行并短暂显示反馈", () => {
		vi.useFakeTimers();
		let dispatchedDetail: unknown = null;
		const handler = (e: Event) => {
			dispatchedDetail = (e as CustomEvent).detail;
		};
		window.addEventListener("pi-web-ui:plugin-run-command", handler);

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		act(() => {
			root!.render(createElement(RunInTerminalButton, { code: "$ git status" }));
		});

		const btn = container.querySelector("button.term-run-btn") as HTMLButtonElement;
		expect(btn).not.toBeNull();
		expect(btn.getAttribute("aria-label")).toBeTruthy();

		act(() => {
			btn.click();
		});

		expect(dispatchedDetail).toEqual({
			title: "git status",
			command: "git status",
		});

		act(() => {
			vi.advanceTimersByTime(600);
		});
		expect(btn.getAttribute("title")).toBeTruthy();

		act(() => {
			vi.advanceTimersByTime(700);
		});

		window.removeEventListener("pi-web-ui:plugin-run-command", handler);
	});
});
