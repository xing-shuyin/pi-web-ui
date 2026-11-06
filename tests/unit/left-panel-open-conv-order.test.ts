/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../../web/src/i18n.js";
import { LeftPanel } from "../../web/src/components/LeftPanel.js";
import { setAppGlobals } from "../../web/src/app-globals.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web/src/styles.css"), "utf8");

let root: Root | null = null;
afterEach(() => {
	if (root) {
		act(() => root!.unmount());
		root = null;
	}
	document.body.innerHTML = "";
});

function stubZhStorage() {
	const store = new Map<string, string>();
	Object.defineProperty(window, "localStorage", {
		value: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => store.set(k, String(v)),
			removeItem: (k: string) => void store.delete(k),
			clear: () => store.clear(),
		} as unknown as Storage,
		writable: true,
	});
	localStorage.setItem("pi-web-ui:lang", "zh");
}

function mountLeftPanel(overrides: Record<string, unknown> = {}) {
	stubZhStorage();
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const sent: unknown[] = [];
	const panelSend = (msg: unknown) => {
		sent.push(msg);
		return true;
	};
	const props = {
		active: true,
		sessionFile: null,
		conversations: [],
		elsewhere: [],
		sessions: [],
		projects: [{ path: "/test", lastUsed: Date.now() }],
		activeConversationId: "",
		panelSend,
		...overrides,
	};
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				createElement(LeftPanel as any, props),
			),
		);
	});
	return { container, sent };
}

describe("左栏会话位置与纯背景高亮守卫", () => {
	it("项目头激活态采用蓝色系背景且无边框线/无内阴影边框", () => {
		const match = CSS.match(/\.lp-project-head-row\.active[\s\S]*?\{([^}]*)\}/);
		expect(match).toBeTruthy();
		const body = match![1];
		expect(body).toContain("var(--blue");
		expect(body).toMatch(/border:\s*none/);
		expect(body).toMatch(/box-shadow:\s*none/);
	});

	it("项目头操作按钮绝对定位，hover 时不引起行内按钮宽度缩进或边框抖动", () => {
		const match = CSS.match(/\.lp-project-actions\s*\{([^}]*)\}/);
		expect(match).toBeTruthy();
		const body = match![1];
		expect(body).toContain("position: absolute");
		expect(body).toContain("right: 6px");
	});

	it("临时对话具备专用的临时胶囊标识样式且无刺眼实体边框", () => {
		expect(CSS).toMatch(/\.ephemeral-badge\s*\{[^}]*display:\s*inline-flex/);
		expect(CSS).toMatch(/\.ephemeral-badge\s*\{[^}]*var\(--amber/);
	});

	it("会话运行态杜绝使用背景色高亮与边框线，仅通过右侧转圈指示器体现", () => {
		const runningMatch = CSS.match(/\.lp-tree-session-item\.is-running\s*\{([^}]*)\}/);
		expect(runningMatch).toBeTruthy();
		expect(runningMatch![1]).toMatch(/background:\s*transparent/);
		expect(runningMatch![1]).toMatch(/box-shadow:\s*none/);

		const unreadMatch = CSS.match(/\.lp-tree-session-item\.is-unread\s*\{([^}]*)\}/);
		expect(unreadMatch).toBeTruthy();
		expect(unreadMatch![1]).toMatch(/box-shadow:\s*none/);
	});

	it("仅仅打开历史会话查看时，不进入顶部活动列表，保留在历史列表中并展示时间戳", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const historyTime = Date.now() - 3600000;
		const sessions = [
			{ path: "/test/session-new.jsonl", sessionId: "s-new", name: "最新会话", modified: Date.now() },
			{ path: "/test/session-old.jsonl", sessionId: "s-old", name: "历史会话", modified: historyTime },
		];
		// 用户仅仅打开了 s-old 进行查看（后端已加载入内存 convs，但没有开始聊：非 streaming、非 question）
		const conversations = [
			{
				id: "c-old",
				sessionId: "s-old",
				sessionFile: "/test/session-old.jsonl",
				cwd: "/test",
				title: "历史会话",
				messageCount: 5,
				isStreaming: false,
				isSubagent: false,
			},
		];

		const { container } = mountLeftPanel({
			sessions,
			conversations,
			activeConversationId: "c-old",
			sessionFile: "/test/session-old.jsonl",
		});

		// 检查渲染出来的会话列表
		const sessionRows = container.querySelectorAll(".lp-project-tree-children .lp-row");
		expect(sessionRows.length).toBe(2);

		// 第一行应依然是最新会话（最新时间），第二行应是历史会话，打开操作没有颠倒其原本相对位置
		const titles = Array.from(sessionRows).map((r) => r.querySelector(".conv-title-text")?.textContent?.trim());
		expect(titles[0]).toBe("最新会话");
		expect(titles[1]).toBe("历史会话");

		// 历史会话行右侧应依然显示其时间戳，没有因为打开而消失
		const timeEl = sessionRows[1].querySelector(".conv-time");
		expect(timeEl).toBeTruthy();
		expect(timeEl?.textContent?.trim()).toBeTruthy();
	});

	it("只有在会话开始运行/交互（如流式输出）时，才将其提升到顶部活动列表", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const sessions = [
			{ path: "/test/session-new.jsonl", sessionId: "s-new", name: "最新会话", modified: Date.now() },
			{ path: "/test/session-old.jsonl", sessionId: "s-old", name: "历史会话", modified: Date.now() - 3600000 },
		];
		// 历史会话发起了提问，开始对话（isStreaming = true）
		const conversations = [
			{
				id: "c-old",
				sessionId: "s-old",
				sessionFile: "/test/session-old.jsonl",
				cwd: "/test",
				title: "历史会话",
				messageCount: 6,
				isStreaming: true,
				isSubagent: false,
			},
		];

		const { container } = mountLeftPanel({
			sessions,
			conversations,
			activeConversationId: "c-old",
			sessionFile: "/test/session-old.jsonl",
		});

		const sessionRows = container.querySelectorAll(".lp-project-tree-children .lp-row");
		expect(sessionRows.length).toBe(2);

		// 开始对话后，历史会话被提到最顶部
		const titles = Array.from(sessionRows).map((r) => r.querySelector(".conv-title-text")?.textContent?.trim());
		expect(titles[0]).toBe("历史会话");
		expect(titles[1]).toBe("最新会话");

		// 并且第一行正在运行，带有流式 spinner 指示器
		expect(sessionRows[0].querySelector(".status-spinner-right")).toBeTruthy();
	});

	it("临时对话应当带有明确的临时徽标（.ephemeral-badge）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const conversations = [
			{
				id: "c-ephemeral",
				cwd: "/test",
				title: "临时测试对话",
				messageCount: 1,
				isStreaming: false,
				isSubagent: false,
				isEphemeral: true,
			},
		];

		const { container } = mountLeftPanel({
			conversations,
			activeConversationId: "c-ephemeral",
		});

		const badge = container.querySelector(".ephemeral-badge");
		expect(badge).toBeTruthy();
		expect(badge?.textContent).toContain("临时");
	});

	it("项目内层按钮为纯透明背景，杜绝双层背景叠加", () => {
		const match = CSS.match(/\.lp-project-head-row \.lp-project-header-item[\s\S]*?\{([^}]*)\}/);
		expect(match).toBeTruthy();
		expect(match![1]).toMatch(/background:\s*transparent/);
	});

	it("历史会话折叠区带有现代 CSS Grid 平滑过渡动画样式", () => {
		const match = CSS.match(/\.lp-history-collapsible\s*\{([^}]*)\}/);
		expect(match).toBeTruthy();
		expect(match![1]).toContain("grid-template-rows: 1fr");
		expect(match![1]).toContain("transition:");

		const chevronMatch = CSS.match(/\.lp-project-header-item \.lp-project-chevron\s*\{([^}]*)\}/);
		expect(chevronMatch).toBeTruthy();
		expect(chevronMatch![1]).toMatch(/transition:\s*transform\s+0\.22s\s+cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\)/);
	});

	it("打开新项目时不会自动折叠已展开的其他项目", () => {
		setAppGlobals({ cwd: "/proj1", ready: true, status: "open", workspaceRoots: [] });
		const projects = [
			{ path: "/proj1", lastUsed: Date.now() },
			{ path: "/proj2", lastUsed: Date.now() - 1000 },
		];
		const projectSessions = {
			"/proj1": [{ path: "/proj1/s1.jsonl", name: "S1", modified: Date.now() }],
			"/proj2": [{ path: "/proj2/s2.jsonl", name: "S2", modified: Date.now() }],
		};

		const { container } = mountLeftPanel({
			projects,
			projectSessions,
		});

		// 两个项目初始时，/proj1 作为当前项目已展开
		const nodes = container.querySelectorAll(".lp-project-node");
		expect(nodes.length).toBe(2);

		// 点击 /proj2 的 chevron 展开 /proj2
		const proj2Chevron = nodes[1].querySelector<HTMLElement>(".lp-project-chevron");
		expect(proj2Chevron).toBeTruthy();
		act(() => proj2Chevron!.click());

		// 检查两个项目的头部：proj1 仍保持展开（is-expanded），proj2 也展开（is-expanded）
		const head1 = nodes[0].querySelector(".lp-project-head-row");
		const head2 = nodes[1].querySelector(".lp-project-head-row");
		expect(head1?.classList.contains("is-expanded")).toBe(true);
		expect(head2?.classList.contains("is-expanded")).toBe(true);
	});
});
