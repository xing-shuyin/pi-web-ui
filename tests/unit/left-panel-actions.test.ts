// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { isPinnedRowVisible, LeftPanel } from "../../web/src/components/LeftPanel.js";
import { joinProjectPath, isValidProjectName, parentOf, MACHINE_ROOT } from "../../web/src/components/ProjectPicker.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { conversationOrder } from "../../web/src/conversation-order.js";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";
import { getContextMenu, closeContextMenu } from "../../web/src/context-menu-state.js";

vi.mock("../../web/src/components/DeviceGroupSection.js", () => ({
	DeviceGroupSection: () => createElement("div", { className: "lp-section dg-side-section" }),
}));

let root: Root | null = null;

function stubZhStorage() {
	const store = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
	} as unknown as Storage);
	localStorage.setItem("pi-web-ui:lang", "zh");
}

function mountLeftPanel(overrides: Record<string, unknown> = {}, initialStorage?: Record<string, string>) {
	stubZhStorage();
	if (initialStorage) {
		for (const [k, v] of Object.entries(initialStorage)) {
			localStorage.setItem(k, v);
		}
	}
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
		sessions: [
			{
				path: "session-1.jsonl",
				name: "Test Session",
				firstMessage: "Hello",
				modified: Date.now(),
				messageCount: 1,
			},
		],
		projects: [{ path: "/test", lastUsed: Date.now() }],
		activeConversationId: "",
		panelSend,
		pathCompletions: [
			{ name: "sub1", path: "/test/sub1", type: "dir" as const },
			{ name: "sub2", path: "/test/sub2", type: "dir" as const },
			{ name: "file.txt", path: "/test/file.txt", type: "file" as const },
		],
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

afterEach(() => {
	vi.unstubAllGlobals();
	resetAppGlobals();
	closeContextMenu();
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	conversationOrder.clear();
});

describe("LeftPanel 标题栏操作与项目管理", () => {
	it("projects=[] 时仍渲染“最近项目”标题栏和项目管理按钮，且不渲染项目滚动区", () => {
		setAppGlobals({ cwd: "", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ projects: [], sessions: [] });

		const projectsSection = container.querySelector(".panel-projects");
		expect(projectsSection).toBeTruthy();
		expect(projectsSection?.textContent).toContain("最近项目");

		const projectActionBtn = container.querySelector(".lp-project-action");
		expect(projectActionBtn).toBeTruthy();

		expect(container.querySelector(".projects-scroll")).toBeNull();
	});

	it("项目行渲染新对话加号按钮，点击后发送 new_chat", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container, sent } = mountLeftPanel();

		const newChatBtn = container.querySelector<HTMLButtonElement>(".lp-project-new-chat-btn");
		expect(newChatBtn).toBeTruthy();
		expect(newChatBtn?.title).toBeTruthy();

		sent.length = 0;
		act(() => newChatBtn!.click());
		expect(sent).toEqual([{ type: "new_chat" }]);
	});

	it("标题行容器与折叠按钮不产生嵌套 button（无 button button）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ projects: [] });

		const nestedButtons = container.querySelectorAll("button button");
		expect(nestedButtons.length).toBe(0);
	});

	it("点击项目管理按钮打开项目管理面板，点击遮罩或按 Escape 键可关闭", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ projects: [] });

		const projectActionBtn = container.querySelector<HTMLButtonElement>(".lp-project-action");
		expect(projectActionBtn).toBeTruthy();

		act(() => projectActionBtn!.click());
		const manageItem = container.querySelector<HTMLButtonElement>(".lp-manage-projects-btn");
		expect(manageItem).toBeTruthy();
		act(() => manageItem!.click());
		const dialog = document.querySelector("[role=dialog]");
		expect(dialog).toBeTruthy();

		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(document.querySelector("[role=dialog]")).toBeNull();

		act(() => projectActionBtn!.click());
		const manageItem2 = container.querySelector<HTMLButtonElement>(".lp-manage-projects-btn");
		act(() => manageItem2!.click());
		expect(document.querySelector("[role=dialog]")).toBeTruthy();
		const backdrop = document.querySelector(".status-cwd-backdrop, .project-picker-backdrop");
		expect(backdrop).toBeTruthy();
		act(() => (backdrop as HTMLElement).click());
		expect(document.querySelector("[role=dialog]")).toBeNull();
	});

	it("项目管理面板：非法项目名称（空或含分隔符）不能发送创建消息，合法名称发送 make_dir(setAsCwd: true)", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container, sent } = mountLeftPanel({ projects: [] });

		const projectActionBtn = container.querySelector<HTMLButtonElement>(".lp-project-action");
		act(() => projectActionBtn!.click());
		const manageItem = container.querySelector<HTMLButtonElement>(".lp-manage-projects-btn");
		act(() => manageItem!.click());

		expect(document.querySelector(".project-picker")?.parentElement).toBe(document.body);

		const newBtn = document.querySelector<HTMLButtonElement>(".cwd-toolbar .tool-new");
		expect(newBtn).toBeTruthy();
		act(() => newBtn!.click());

		const input = document.querySelector<HTMLInputElement>(".cwd-newrow input, .project-picker-newrow input");
		expect(input).toBeTruthy();
		const createBtn = document.querySelector<HTMLButtonElement>(
			".cwd-newrow button.primary, .project-picker-newrow button.primary",
		);
		expect(createBtn).toBeTruthy();

		sent.length = 0;
		act(() => createBtn!.click());
		expect(sent.filter((m: any) => m.type === "make_dir")).toHaveLength(0);

		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "foo/bar");
			input!.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => createBtn!.click());
		expect(sent.filter((m: any) => m.type === "make_dir")).toHaveLength(0);

		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "my-new-project");
			input!.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => createBtn!.click());
		const makeDirMsg = sent.find((m: any) => m.type === "make_dir") as any;
		expect(makeDirMsg).toBeTruthy();
		expect(makeDirMsg.setAsCwd).toBe(true);
		expect(makeDirMsg.path).toContain("my-new-project");
	});

	it("项目管理面板：选择现有目录发送 set_cwd", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container, sent } = mountLeftPanel({ projects: [] });

		const projectActionBtn = container.querySelector<HTMLButtonElement>(".lp-project-action");
		act(() => projectActionBtn!.click());
		const manageItem = container.querySelector<HTMLButtonElement>(".lp-manage-projects-btn");
		act(() => manageItem!.click());

		const chooseBtns = Array.from(
			document.querySelectorAll<HTMLButtonElement>(".cwd-toolbar .tool-pick, .cwd-toolbar .tool-choose"),
		);
		expect(chooseBtns.length).toBeGreaterThan(0);

		sent.length = 0;
		act(() => chooseBtns[0].click());
		const setCwdMsg = sent.find((m: any) => m.type === "set_cwd") as any;
		expect(setCwdMsg).toBeTruthy();
		expect(setCwdMsg.path).toBeTruthy();
	});

	it("joinProjectPath 纯函数正确处理 POSIX 和 Windows 根与路径拼接", () => {
		expect(joinProjectPath("/", "foo")).toBe("/foo");
		expect(joinProjectPath("/a", "b")).toBe("/a/b");
		expect(joinProjectPath("/a/", "b")).toBe("/a/b");
		expect(joinProjectPath("C:", "foo")).toBe("C:/foo");
		expect(joinProjectPath("C:/", "foo")).toBe("C:/foo");
		expect(joinProjectPath("C:\\dir", "sub")).toBe("C:/dir/sub");
	});

	it("isValidProjectName 校验项目名称合法性", () => {
		expect(isValidProjectName("my-project")).toBe(true);
		expect(isValidProjectName("  my-project  ")).toBe(true);
		expect(isValidProjectName("")).toBe(false);
		expect(isValidProjectName("   ")).toBe(false);
		expect(isValidProjectName(".")).toBe(false);
		expect(isValidProjectName("..")).toBe(false);
		expect(isValidProjectName("foo/bar")).toBe(false);
		expect(isValidProjectName("foo\\bar")).toBe(false);
	});

	it("parentOf 返回父路径或在根处返回 null", () => {
		expect(parentOf("/")).toBeNull();
		expect(parentOf(MACHINE_ROOT)).toBeNull();
		expect(parentOf("/a")).toBe("/");
		expect(parentOf("/a/b")).toBe("/a");
		expect(parentOf("/a/b/")).toBe("/a");
		expect(parentOf("C:")).toBe(MACHINE_ROOT);
		expect(parentOf("C:/")).toBe(MACHINE_ROOT);
		expect(parentOf("C:/Users")).toBe("C:/");
		expect(parentOf("C:/Users/test")).toBe("C:/Users");
	});
});

describe("LeftPanel 会话行内嵌区", () => {
	const pluginEntry = () => ({
		id: "plug:x:go",
		source: "plugin:x",
		slot: "leftpanel.sessions",
		label: "Go",
		kind: "action",
		order: 100,
		align: "start",
		hidden: false,
		userOverrides: [],
		arrangedBy: [],
	});

	it("插件行动作渲染在会话行尾（leftpanel.sessions 里的条目都进行内嵌区）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ uiLeftSessions: [pluginEntry()] });
		const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".lp-slot-btn"));
		expect(buttons).toHaveLength(1);
		expect(buttons[0]?.getAttribute("aria-label")).toBe("Go");
	});

	it("内嵌区为空时不留 .lp-slot-sessions 占位（会话行 DOM 与旧版一致）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ uiLeftSessions: [] });
		expect(container.querySelector(".lp-slot-sessions")).toBeNull();
		expect(container.querySelector(".lp-slot-btn")).toBeNull();
	});
});

describe("LeftPanel P1：分区标题栏 / 项目行 / 项目右键插件位", () => {
	const entry = (slot: string, id: string, label: string) => ({
		id: `plug:x:${id}`,
		source: "plugin:x",
		slot,
		label,
		kind: "action",
		order: 100,
		align: "start",
		hidden: false,
		userOverrides: [],
		arrangedBy: [],
	});
	const oneProject = [{ path: "/test/p1", lastUsed: Date.now() }];

	it("项目分区标题栏渲染本槽位的插件按钮（插在宿主按钮之后）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({
			projects: oneProject,
			uiProjectsActions: [entry("leftpanel.projects.actions", "pa", "PA")],
		});
		const pick = (sel: string) => container.querySelector(`${sel} .lp-section-actions .lp-slot-section .lp-slot-btn`);
		expect(pick(".panel-projects")?.getAttribute("aria-label")).toBe("PA");
		const projActions = container.querySelector(".panel-projects .lp-section-actions");
		expect(projActions?.firstElementChild?.classList.contains("lp-project-action")).toBe(true);
	});

	it("分区标题栏无插件条目时不留占位（标题栏 DOM 与旧版一致）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ projects: oneProject });
		expect(container.querySelector(".lp-slot-section")).toBeNull();
		expect(container.querySelector(".panel-convs")).toBeNull();
	});

	it("项目行内嵌区：点击回传 target={id: 项目路径, kind: project}", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const onUiAction = vi.fn();
		const { container } = mountLeftPanel({
			projects: oneProject,
			uiLeftProject: [entry("leftpanel.project", "pj", "PJ")],
			onUiAction,
		});
		const p1Row = container.querySelector('[data-project-path="/test/p1"]')?.closest(".lp-row");
		const btn = p1Row?.querySelector<HTMLButtonElement>(".lp-slot-project .lp-slot-btn");
		expect(btn?.getAttribute("aria-label")).toBe("PJ");
		act(() => btn!.click());
		expect(onUiAction).toHaveBeenCalledTimes(1);
		const [item, value, target] = onUiAction.mock.calls[0]!;
		expect((item as { id: string }).id).toBe("plug:x:pj");
		expect(value).toBeUndefined();
		expect(target).toEqual({ id: "/test/p1", kind: "project", label: "p1" });
	});

	it("项目行无插件条目时不渲染 .lp-slot-project 占位", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ projects: oneProject, uiLeftProject: [] });
		expect(container.querySelector(".lp-slot-project")).toBeNull();
	});

	it("右键项目行：有插件条目 → 打开 contextmenu.project（target.kind=project）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({
			projects: oneProject,
			uiContextProject: [entry("contextmenu.project", "pm", "项目菜单")],
		});
		const row = container.querySelector('[data-project-path="/test/p1"]')?.closest<HTMLElement>(".lp-row");
		act(() => {
			row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 20 }));
		});
		const menu = getContextMenu();
		expect(menu?.slot).toBe("contextmenu.project");
		expect(menu?.target).toEqual({ id: "/test/p1", kind: "project", label: "p1" });
		expect(menu?.entries.map((e) => e.label)).toEqual(["项目菜单"]);
	});

	it("项目行右键但没有任何插件条目 → 不抢浏览器右键（不开菜单）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ projects: oneProject, uiContextProject: [] });
		const row = container.querySelector<HTMLElement>(".lp-row");
		act(() => {
			row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		});
		expect(getContextMenu()).toBeNull();
	});
});

describe("LeftPanel P2：分区顺序 / 显隐 / 分隔条 / 行内槽位拆分", () => {
	const hostSection = (id: string, hidden = false) => ({
		id,
		source: "host",
		slot: "leftpanel.sections",
		label: id,
		kind: "action",
		order: 10,
		align: "start",
		hidden,
		userOverrides: [],
		arrangedBy: [],
	});
	const oneProject = [{ path: "/test/p1", lastUsed: Date.now() }];
	const runningConv = [{ id: "c1", title: "run", cwd: "/test", messageCount: 1, isStreaming: true, isSubagent: false }];
	const sectionOrder = (container: HTMLElement) =>
		Array.from(container.querySelectorAll<HTMLElement>(".lp-panel > .lp-section")).map((el) =>
			el.classList.contains("panel-projects")
				? "projects"
				: el.classList.contains("panel-convs")
					? "convs"
					: el.classList.contains("panel-sessions")
						? "sessions"
						: el.classList.contains("dg-side-section")
							? "groups"
							: "?",
		);

	it("uiSections 决定可调分区先后，群组始终紧随项目分区", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({
			projects: oneProject,
			conversations: runningConv,
			uiSections: [hostSection("host:lp-history"), hostSection("host:lp-projects"), hostSection("host:lp-running")],
		});
		expect(sectionOrder(container)).toEqual(["projects", "groups"]);
	});

	it("隐藏项目分区时群组置顶，支持折叠与单独展示", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const all = mountLeftPanel({ projects: oneProject, conversations: runningConv });
		expect(all.container.querySelector(".panel-projects")).not.toBeNull();
		all.container.remove();
		act(() => root!.unmount());
		root = null;

		const { container } = mountLeftPanel({
			projects: oneProject,
			conversations: runningConv,
			uiSections: [
				hostSection("host:lp-projects", true),
				hostSection("host:lp-running"),
				hostSection("host:lp-history"),
			],
		});
		expect(sectionOrder(container)).toEqual(["groups"]);
	});

	it("默认（无 uiSections）显示项目分区（内含对话树）与群组分区", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ projects: oneProject, conversations: runningConv });
		expect(sectionOrder(container)).toEqual(["projects", "groups"]);
	});

	it("隐藏群组分区后不再渲染「群组」tab（tab 与布局开关不再脱节）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({
			projects: oneProject,
			conversations: runningConv,
			uiSections: [
				hostSection("host:lp-projects"),
				hostSection("host:lp-groups", true),
				hostSection("host:lp-running"),
				hostSection("host:lp-history"),
			],
		});
		expect(Array.from(container.querySelectorAll(".lp-conv-tab")).length).toBe(1);
	});

	it("会话行使用自己的行内槽位；leftpanel.sessions 在会话行中渲染", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const mk = (slot: string, id: string) => ({
			id: `plug:x:${id}`,
			source: "plugin:x",
			slot,
			label: id,
			kind: "action",
			order: 100,
			align: "start",
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		});
		const { container } = mountLeftPanel({
			projects: [{ path: "/test", lastUsed: Date.now() }],
			sessions: [{ path: "session-1.jsonl", name: "S1", firstMessage: "hi", modified: Date.now(), messageCount: 1 }],
			uiLeftSessions: [mk("leftpanel.sessions", "s")],
		});
		const labels = Array.from(container.querySelectorAll<HTMLElement>(".lp-slot-sessions .lp-slot-btn")).map((b) =>
			b.getAttribute("aria-label"),
		);
		expect(labels).toContain("s");
	});
});

describe("LeftPanel P3：插件运行条目（运行分区末尾，仅展示）", () => {
	const pluginGroups = [
		{
			pluginId: "mailer",
			pluginName: "邮件同步",
			items: [
				{ id: "job-1", title: "同步收件箱", hint: "3/10", status: "running", icon: "📬", action: "mailer:open" },
				{ id: "job-2", title: "归档旧邮件", status: "error" },
			],
		},
	];

	it("只有插件条目、没有对话时插件条目正常出现并展示", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ conversations: [], uiPluginRunning: pluginGroups });
		expect(container.querySelectorAll(".lp-plugin-group")).toHaveLength(1);
		expect(container.querySelectorAll(".lp-plugin-item")).toHaveLength(2);
		expect(container.querySelector(".lp-plugin-group .panel-conv-group-title")?.textContent).toBe("插件 · 邮件同步");
	});

	it("点击带 action 的条目：把所属分组与条目交给 onPluginRunningAction；无 action 的带 is-static", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const onPluginRunningAction = vi.fn();
		const { container } = mountLeftPanel({ conversations: [], uiPluginRunning: pluginGroups, onPluginRunningAction });
		const items = container.querySelectorAll<HTMLButtonElement>(".lp-plugin-item");
		expect(items[0]!.classList.contains("is-static")).toBe(false);
		expect(items[1]!.classList.contains("is-static")).toBe(true);
		act(() => items[0]!.click());
		expect(onPluginRunningAction).toHaveBeenCalledTimes(1);
		const [group, item] = onPluginRunningAction.mock.calls[0]!;
		expect((group as { pluginId: string }).pluginId).toBe("mailer");
		expect((item as { id: string }).id).toBe("job-1");
	});

	it("状态圆点带类名（running / done / error 三种）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ conversations: [], uiPluginRunning: pluginGroups });
		expect(container.querySelector(".lp-plugin-dot.st-running")).not.toBeNull();
		expect(container.querySelector(".lp-plugin-dot.st-error")).not.toBeNull();
	});

	it("没有插件条目（不传或空数组）时 DOM 里不出现插件分组", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const a = mountLeftPanel({ conversations: [] });
		expect(a.container.querySelector(".panel-convs")).toBeNull();
		expect(a.container.querySelector(".lp-plugin-group")).toBeNull();
	});
});

describe("LeftPanel P4：插件自定义分区（kind=view）", () => {
	const hostEntry = (id: string) => ({
		id,
		source: "host",
		slot: "leftpanel.sections",
		label: id,
		kind: "action",
		order: 10,
		align: "start",
		hidden: false,
		userOverrides: [],
		arrangedBy: [],
	});
	const pluginSection = (id = "notes:fav", label = "收藏", hidden = false) => ({
		id,
		source: "plugin:notes",
		slot: "leftpanel.sections",
		label,
		kind: "view",
		order: 100,
		align: "start",
		hidden,
		userOverrides: [],
		arrangedBy: [],
	});
	const allSections = (extra: unknown[]) => [
		hostEntry("host:lp-projects"),
		hostEntry("host:lp-running"),
		hostEntry("host:lp-history"),
		...extra,
	];

	it("插件分区：标题是条目 label，正文来自 renderPluginSectionBody", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const render = vi.fn(() => createElement("div", { className: "fake-plugin-body" }, "插件正文"));
		const { container } = mountLeftPanel({
			uiSections: allSections([pluginSection()]),
			renderPluginSectionBody: render,
		});
		const sec = container.querySelector(".lp-section-plugin");
		expect(sec).not.toBeNull();
		expect(sec?.querySelector(".lp-section-title-text")?.textContent).toBe("收藏");
		expect(sec?.querySelector(".fake-plugin-body")?.textContent).toBe("插件正文");
		expect(render).toHaveBeenCalledWith(expect.objectContaining({ id: "notes:fav" }));
	});

	it("点标题折叠：正文消失，折叠态写入 localStorage（只记折叠的分区键）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({
			uiSections: allSections([pluginSection()]),
			renderPluginSectionBody: () => createElement("div", { className: "fake-plugin-body" }, "x"),
		});
		const title = container.querySelector<HTMLButtonElement>(".lp-section-plugin .lp-section-title");
		act(() => title!.click());
		expect(container.querySelector(".lp-section-plugin.collapsed")).not.toBeNull();
		expect(container.querySelector(".lp-section-plugin .fake-plugin-body")).toBeNull();
		expect(localStorage.getItem("pi-web-ui:lp-collapse-plugin-sections")).toBe(JSON.stringify(["plugin:notes:fav"]));
	});

	it("没有正文渲染器时分区仍在（正文为空，不抛错）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ uiSections: allSections([pluginSection("notes:bare", "裸分区")]) });
		const sec = container.querySelector(".lp-section-plugin");
		expect(sec?.querySelector(".lp-section-title-text")?.textContent).toBe("裸分区");
		expect(sec?.querySelector(".lp-plugin-section-body")?.childElementCount).toBe(0);
	});

	it("布局页隐藏的插件分区不渲染", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ uiSections: allSections([pluginSection("notes:fav", "收藏", true)]) });
		expect(container.querySelector(".lp-section-plugin")).toBeNull();
	});
});

describe("LeftPanel Tab 模式：一体化会话与拖动分割条 (Sash)", () => {
	const oneProject = [{ path: "/test/p1", lastUsed: Date.now() }];
	const runningConv = [{ id: "c1", title: "run", cwd: "/test", messageCount: 1, isStreaming: true, isSubagent: false }];

	it("项目与对话合并为单一树后，项目区与插件自定义分区之间可产生分割条并调整权重", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const pluginView = {
			id: "notes:fav",
			source: "plugin:notes",
			slot: "leftpanel.sections",
			label: "笔记",
			kind: "view",
			order: 100,
			align: "start",
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		};
		const { container } = mountLeftPanel({
			projects: oneProject,
			conversations: runningConv,
			uiSections: [
				{
					id: "host:lp-projects",
					source: "host",
					slot: "leftpanel.sections",
					label: "项目",
					kind: "action",
					order: 10,
					align: "start",
					hidden: false,
					userOverrides: [],
					arrangedBy: [],
				},
				pluginView,
			],
			renderPluginSectionBody: () => createElement("div", null, "笔记正文"),
		});
		expect(container.querySelector(".panel-convs")).toBeNull();
		expect(container.querySelector(".panel-sessions")).toBeNull();
		const sash = container.querySelector<HTMLElement>(".lp-sash");
		expect(sash).not.toBeNull();
	});

	it("方案 A：会话内位置锁定（Deferred MRU），切换或操作时项目物理顺序保持稳定不跳变", () => {
		setAppGlobals({ cwd: "/test/p1", ready: true, status: "open", workspaceRoots: [] });
		const p1 = { path: "/test/p1", lastUsed: 100 };
		const p2 = { path: "/test/p2", lastUsed: 90 };
		const p3 = { path: "/test/p3", lastUsed: 80 };

		const { container } = mountLeftPanel({ projects: [p1, p2, p3] });
		const getRenderedNames = () =>
			Array.from(container.querySelectorAll(".lp-project-name")).map((el) => el.textContent?.trim());
		expect(getRenderedNames()).toEqual(["p1", "p2", "p3"]);

		const p3Updated = { path: "/test/p3", lastUsed: 200 };
		act(() => {
			root!.render(
				createElement(
					LanguageProvider,
					null,
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					createElement(LeftPanel as any, {
						active: true,
						sessionFile: null,
						conversations: [],
						elsewhere: [],
						sessions: [],
						projects: [p3Updated, p1, p2],
						activeConversationId: "",
						panelSend: () => true,
					}),
				),
			);
		});

		expect(getRenderedNames()).toEqual(["p1", "p2", "p3"]);
	});
});

describe("LeftPanel 会话行删除确认与重命名按钮互斥", () => {
	it("挂有子代理的对话点击关闭进入确认态时，重命名按钮卸载，绝不遮盖确认选项组", () => {
		setAppGlobals({ cwd: "/test/p1", ready: true, status: "open", workspaceRoots: [] });
		const parentConv = {
			id: "parent-1",
			title: "父会话",
			cwd: "/test/p1",
			messageCount: 2,
			isStreaming: false,
			isSubagent: false,
		};
		const subConv = {
			id: "sub-1",
			title: "子代理1",
			cwd: "/test/p1",
			parentId: "parent-1",
			messageCount: 1,
			isStreaming: false,
			isSubagent: true,
		};
		const { container, sent } = mountLeftPanel({
			projects: [{ path: "/test/p1", lastUsed: Date.now() }],
			conversations: [parentConv, subConv],
		});

		const parentRow = container.querySelector<HTMLElement>(
			'.lp-project-tree-children .lp-row[data-session-key="parent-1"]',
		);
		expect(parentRow).not.toBeNull();

		expect(parentRow!.querySelector(".lp-rename")).not.toBeNull();
		expect(parentRow!.querySelector(".lp-del-group")).toBeNull();

		const delBtn = parentRow!.querySelector<HTMLButtonElement>(".lp-del:not(.lp-rename)");
		expect(delBtn).not.toBeNull();
		act(() => delBtn!.click());

		const delGroup = parentRow!.querySelector(".lp-del-group");
		expect(delGroup).not.toBeNull();
		expect(parentRow!.querySelector(".lp-rename")).toBeNull();

		const confirmCheckBtn = delGroup!.querySelector<HTMLButtonElement>(".lp-del.confirm");
		const forceDismissBtn = delGroup!.querySelector<HTMLButtonElement>(".lp-del-opt.danger");
		expect(confirmCheckBtn).not.toBeNull();
		expect(forceDismissBtn).not.toBeNull();
		expect(forceDismissBtn?.textContent?.trim()).toBe("强制全关");

		act(() => confirmCheckBtn!.click());
		expect(sent).toContainEqual({
			type: "dismiss_conversation",
			id: "parent-1",
			withFinishedSubagents: true,
		});
		expect(parentRow!.querySelector(".lp-del-group")).toBeNull();
		expect(parentRow!.querySelector(".lp-rename")).not.toBeNull();

		const delBtn2 = parentRow!.querySelector<HTMLButtonElement>(".lp-del:not(.lp-rename)");
		expect(delBtn2).not.toBeNull();
		act(() => delBtn2!.click());
		const forceBtn2 = parentRow!.querySelector<HTMLButtonElement>(".lp-del-group .lp-del-opt.danger");
		expect(forceBtn2).not.toBeNull();
		act(() => forceBtn2!.click());
		expect(sent).toContainEqual({
			type: "dismiss_conversation",
			id: "parent-1",
			force: true,
		});
		expect(parentRow!.querySelector(".lp-del-group")).toBeNull();
		expect(parentRow!.querySelector(".lp-rename")).not.toBeNull();
	});

	it.each([true, false])("CLI 行单击发送关闭请求（当前对话=%s），不删除历史", (active) => {
		setAppGlobals({ cwd: "/test/p1", ready: true, status: "open", workspaceRoots: [] });
		const nativeCli = {
			terminalId: "cli-terminal",
			config: { preset: "claude", executable: "claude", args: [] },
		};
		const { container, sent } = mountLeftPanel({
			projects: [{ path: "/test/p1", lastUsed: Date.now() }],
			activeConversationId: active ? "cli-1" : "",
			conversations: [
				{
					id: "cli-1",
					title: "Claude CLI",
					cwd: "/test/p1",
					messageCount: 0,
					isStreaming: false,
					isSubagent: false,
					nativeCli,
				},
			],
		});
		const row = container.querySelector<HTMLElement>('.lp-project-tree-children .lp-row[data-session-key="cli-1"]');
		const close = row?.querySelector<HTMLButtonElement>(".lp-del:not(.lp-rename)");
		expect(close).toBeTruthy();
		act(() => close!.click());
		expect(sent.filter((message: any) => message.type === "dismiss_conversation")).toEqual([
			{ type: "dismiss_conversation", id: "cli-1" },
		]);
		expect(sent.some((message: any) => message.type === "delete_session")).toBe(false);
		expect(row!.querySelector(".lp-del.confirm")).toBeNull();
	});

	it("CLI 历史删除仍需确认，首次点击不发送删除请求", () => {
		setAppGlobals({ cwd: "/test/p1", ready: true, status: "open", workspaceRoots: [] });
		const { container, sent } = mountLeftPanel({
			projects: [{ path: "/test/p1", lastUsed: Date.now() }],
			conversations: [],
			sessions: [
				{
					path: "cli-history.jsonl",
					name: "Claude CLI",
					firstMessage: "",
					modified: Date.now(),
					messageCount: 0,
					nativeCli: { preset: "claude", executable: "claude", args: [] },
				},
			],
		});
		const row = container.querySelector<HTMLElement>(".lp-project-tree-children .lp-row");
		const close = row?.querySelector<HTMLButtonElement>(".lp-del:not(.lp-rename)");
		expect(close).toBeTruthy();
		act(() => close!.click());
		expect(sent.some((message: any) => message.type === "delete_session")).toBe(false);
		const confirm = row!.querySelector<HTMLButtonElement>(".lp-del.confirm");
		expect(confirm).toBeTruthy();
		act(() => confirm!.click());
		expect(sent.filter((message: any) => message.type === "delete_session")).toEqual([
			{ type: "delete_session", path: "cli-history.jsonl" },
		]);
		expect(sent.some((message: any) => message.type === "dismiss_conversation")).toBe(false);
	});

	it("历史会话行进入删除确认态时，重命名按钮卸载", () => {
		setAppGlobals({ cwd: "/test/p1", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({
			projects: [{ path: "/test/p1", lastUsed: Date.now() }],
			conversations: [],
			sessions: [
				{
					path: "sess-1.jsonl",
					name: "历史对话",
					firstMessage: "Hi",
					modified: Date.now(),
					messageCount: 1,
				},
			],
		});

		const sessRow = container.querySelector<HTMLElement>(".lp-project-tree-children .lp-row");
		expect(sessRow).not.toBeNull();

		expect(sessRow!.querySelector(".lp-rename")).not.toBeNull();

		const delBtn = sessRow!.querySelector<HTMLButtonElement>(".lp-del:not(.lp-rename)");
		expect(delBtn).not.toBeNull();
		act(() => delBtn!.click());

		expect(sessRow!.querySelector(".lp-rename")).toBeNull();
	});

	it("未打开的项目点击折叠展开按钮时，触发 list_sessions 请求且子列表展开展示", () => {
		setAppGlobals({ cwd: "/test/current", ready: true, status: "open", workspaceRoots: [] });
		const { container, sent } = mountLeftPanel({
			projects: [
				{ path: "/test/current", lastUsed: Date.now() },
				{ path: "/test/unopened", lastUsed: Date.now() - 1000 },
			],
			conversations: [],
			sessions: [],
		});

		const projectNodes = container.querySelectorAll<HTMLElement>(".lp-project-node");
		expect(projectNodes.length).toBe(2);

		const unopenedNode = projectNodes[1]!;
		expect(unopenedNode.querySelector(".lp-project-tree-children")).toBeNull();

		const chevron = unopenedNode.querySelector<HTMLElement>(".lp-project-chevron");
		expect(chevron).not.toBeNull();
		act(() => chevron!.click());

		expect(sent).toContainEqual({
			type: "list_sessions",
			path: "/test/unopened",
			limit: 20,
		});
		expect(sent.some((m: any) => m.type === "set_cwd")).toBe(false);

		const children = unopenedNode.querySelector<HTMLElement>(".lp-project-tree-children");
		expect(children).not.toBeNull();
		const emptyTip = children!.querySelector<HTMLElement>(".lp-project-empty-tip");
		expect(emptyTip).not.toBeNull();
		expect(emptyTip!.textContent).toBeTruthy();
	});

	it("同前缀项目展开与切换时，会话列表严格按物理项目归属隔离，杜绝会话串味与覆盖", () => {
		setAppGlobals({ cwd: "E:/pi-web-ui", ready: true, status: "open", workspaceRoots: [] });
		const piWebUiSessions = [
			{ path: "C:/Users/c/.pi/agent/sessions/--e--pi-web-ui--/s1.jsonl", name: "pi-chat-1", modified: Date.now() },
			{
				path: "C:/Users/c/.pi/agent/sessions/--e--pi-web-ui--/s2.jsonl",
				name: "pi-chat-2",
				modified: Date.now() - 1000,
			},
		];
		const piWebUiSiteSessions = [
			{
				path: "C:/Users/c/.pi/agent/sessions/--e--pi-web-ui-site--/site-1.jsonl",
				name: "你好",
				modified: Date.now() - 500,
			},
		];

		const { container } = mountLeftPanel({
			projects: [
				{ path: "E:/pi-web-ui", lastUsed: Date.now() },
				{ path: "E:/pi-web-ui-site", lastUsed: Date.now() - 1000 },
			],
			conversations: [],
			sessions: piWebUiSessions,
			projectSessions: {
				"e:/pi-web-ui": piWebUiSessions,
				"e:/pi-web-ui-site": piWebUiSiteSessions,
			},
		});

		const projectNodes = container.querySelectorAll<HTMLElement>(".lp-project-node");
		expect(projectNodes.length).toBe(2);

		const piNode = projectNodes[0]!;
		const siteNode = projectNodes[1]!;

		const siteChevron = siteNode.querySelector<HTMLElement>(".lp-project-chevron");
		expect(siteChevron).not.toBeNull();
		act(() => siteChevron!.click());

		const piChildren = piNode.querySelector<HTMLElement>(".lp-project-tree-children");
		expect(piChildren).not.toBeNull();
		expect(piChildren!.textContent).toContain("pi-chat-1");
		expect(piChildren!.textContent).toContain("pi-chat-2");
		expect(piChildren!.textContent).not.toContain("你好");

		const siteChildren = siteNode.querySelector<HTMLElement>(".lp-project-tree-children");
		expect(siteChildren).not.toBeNull();
		expect(siteChildren!.textContent).toContain("你好");
		expect(siteChildren!.textContent).not.toContain("pi-chat-1");
	});

	it("切换激活项目到同前缀项目时，原项目的会话列表依然完好，绝不被新激活项目的会话覆盖", () => {
		setAppGlobals({ cwd: "E:/pi-web-ui-site", ready: true, status: "open", workspaceRoots: [] });
		const piWebUiSessions = [
			{ path: "C:/Users/c/.pi/agent/sessions/--e--pi-web-ui--/s1.jsonl", name: "pi-chat-1", modified: Date.now() },
			{
				path: "C:/Users/c/.pi/agent/sessions/--e--pi-web-ui--/s2.jsonl",
				name: "pi-chat-2",
				modified: Date.now() - 1000,
			},
		];
		const piWebUiSiteSessions = [
			{
				path: "C:/Users/c/.pi/agent/sessions/--e--pi-web-ui-site--/site-1.jsonl",
				name: "你好",
				modified: Date.now() - 500,
			},
		];

		const { container } = mountLeftPanel({
			projects: [
				{ path: "E:/pi-web-ui", lastUsed: Date.now() },
				{ path: "E:/pi-web-ui-site", lastUsed: Date.now() - 1000 },
			],
			conversations: [],
			sessions: piWebUiSiteSessions,
			projectSessions: {
				"e:/pi-web-ui": piWebUiSessions,
				"e:/pi-web-ui-site": piWebUiSiteSessions,
			},
		});

		const projectNodes = container.querySelectorAll<HTMLElement>(".lp-project-node");
		const piNode = projectNodes[0]!;
		const siteNode = projectNodes[1]!;

		const piChevron = piNode.querySelector<HTMLElement>(".lp-project-chevron");
		expect(piChevron).not.toBeNull();
		act(() => piChevron!.click());

		const piChildren = piNode.querySelector<HTMLElement>(".lp-project-tree-children");
		expect(piChildren).not.toBeNull();
		expect(piChildren!.textContent).toContain("pi-chat-1");
		expect(piChildren!.textContent).toContain("pi-chat-2");
		expect(piChildren!.textContent).not.toContain("你好");

		const siteChildren = siteNode.querySelector<HTMLElement>(".lp-project-tree-children");
		expect(siteChildren).not.toBeNull();
		expect(siteChildren!.textContent).toContain("你好");
	});
});

describe("跨项目历史行的钉住菜单", () => {
	it("已钉住的跨项目会话：菜单显示「取消钉住」，点下去发 pinned=false", () => {
		stubZhStorage();
		localStorage.setItem("pi-web-ui:lp-expanded-projects", JSON.stringify(["/project-a"]));
		setAppGlobals({ cwd: "/project-b", ready: true, status: "open", workspaceRoots: [] });
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		const sent: unknown[] = [];
		const session = {
			path: "/sessions/--C--desktop--/x.jsonl",
			name: "串台测试",
			firstMessage: "串台测试",
			modified: Date.now(),
			messageCount: 2,
			pinned: true,
			cwd: "/project-a",
		};
		act(() => {
			root!.render(
				createElement(
					LanguageProvider,
					null,
					createElement(LeftPanel as any, {
						active: false,
						sessionFile: null,
						conversations: [],
						elsewhere: [],
						// 当前项目（/project-b）的列表里没有它：这正是跨项目行拿不到 pinned 的场景。
						sessions: [],
						projectSessions: { "/project-a": [session] },
						projects: [{ path: "/project-a", lastUsed: Date.now() }],
						activeConversationId: "",
						panelSend: (msg: unknown) => {
							sent.push(msg);
							return true;
						},
						uiContextSession: [{ id: "host:conv-pin", source: "host", label: "钉住" }],
					}),
				),
			);
		});

		// 展开 /project-a：真实交互路径比直接塞 localStorage 更可靠（首帧与点击后的状态机不同）。
		const header = [...container.querySelectorAll<HTMLElement>("[data-project-path]")].find(
			(el) => el.getAttribute("data-project-path") === "/project-a",
		);
		expect(header).toBeTruthy();
		act(() => header!.click());
		const row = container.querySelector<HTMLElement>(`[data-session-key]`);
		expect(row).toBeTruthy();
		act(() => {
			row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 20 }));
		});
		const menu = getContextMenu();
		expect(menu?.target).toMatchObject({ kind: "history", id: session.path, pinned: true });
		expect(menu?.entries.map((e) => e.label)).toContain("取消钉住");

		closeContextMenu();
		container.remove();
	});
});

describe("钉住的历史行在项目收起时仍然可见", () => {
	it("isPinnedRowVisible：只有收起状态 + 历史行 + pinned 才保持可见", () => {
		const pinnedSession = { kind: "session" as const, target: { pinned: true } };
		const plainSession = { kind: "session" as const, target: {} };
		const pinnedConv = { kind: "conversation" as const, target: { pinned: true } };
		expect(isPinnedRowVisible(true, pinnedSession)).toBe(true);
		expect(isPinnedRowVisible(false, pinnedSession)).toBe(false);
		expect(isPinnedRowVisible(true, plainSession)).toBe(false);
		expect(isPinnedRowVisible(true, pinnedConv)).toBe(false);
	});
});
