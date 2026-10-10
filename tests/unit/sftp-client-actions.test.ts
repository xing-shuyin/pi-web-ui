// @vitest-environment jsdom
/**
 * sftp 插件「文件树右键菜单 → 上传」的客户端回归 —— 走真实 bundle + jsdom + 假 fetch，零端口零子进程。
 *
 * 现场问题（#601）：manifest 的 `ui["contextmenu.file"]` 声明了 `sftp:upload-file` /
 * `sftp:upload-dir`，但客户端 bundle **从来没注册过任何 host.onUiAction** —— 点下去宿主
 * 找不到接管者，只会弹一句「插件没有接管这个动作（可能版本不匹配）」。同一个坑还有底栏
 * 那个带 `sftp:open` 动作的徽标（点了同样没人接）。现在界面上只留顶栏一个入口，
 * 右键菜单这两条动作必须真的有人接，且接得**对**：
 *
 *   - 动作 = 打开面板 + 把这次上传交给面板跑（与面板按钮同一条路径，进度就地可见）；
 *   - 面板还没挂载（宿主按需加载 bundle 后立刻回调）时请求先排队，mount 完再消费；
 *   - 机器浏览给的绝对路径只有确实在工作区内才折算成相对路径，工作区外**必须拒绝**
 *     （服务端 /transfer 只认工作区内的相对路径：硬塞进去只会得到莫名的「本地不存在」，
 *     POSIX 上还会被当成远端路径）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type Handler = (itemId: string, value?: string, target?: { id: string; kind?: string; label?: string }) => void;
type Post = { path: string; body: Record<string, unknown> };

const handlers = new Map<string, Handler>();
const views: string[] = [];
const posts: Post[] = [];
const CWD = "E:/proj";

/** 宿主动作桥必须在 bundle 求值前就位（它在模块顶层注册 handler）。 */
function installBridge() {
	(globalThis.window as unknown as { __piWebUiHost?: unknown }).__piWebUiHost = {
		version: 11,
		setView: (v: string) => views.push(v),
		onUiAction: (name: string, fn: Handler) => {
			handlers.set(name, fn);
			return () => handlers.delete(name);
		},
	};
}

installBridge();
const bundle = (await import("../../plugins/sftp/client/entry.mjs")).default as {
	mount: (c: HTMLElement) => () => void;
};

/** 假 fetch：按路径分发，顺带记下所有 POST body。 */
function stubFetch() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
			const u = String(url);
			const send = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data }) });
			if (u.includes("/transfer")) {
				posts.push({ path: u, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
				return send({
					result: { done: { upload: 1, download: 0, trashRemote: 0, trashLocal: 0 }, failed: [] },
					plan: null,
				});
			}
			if (u.includes("/ignore-toggle")) {
				posts.push({ path: u, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
				return send({ ok: true, action: "added" });
			}
			if (u.includes("/remote")) return send({ dir: "/home/test", entries: [] });
			return send({
				cwd: CWD,
				configPath: ".pi/sftp.json",
				localPath: ".pi/sftp.local.json",
				trashPath: ".pi/sftp-trash",
				active: "mock",
				connection: { name: "mock", host: "127.0.0.1", port: 22, remotePath: "/home/test", ready: true },
				profiles: [{ name: "mock", ready: true }],
				settings: {},
				warnings: [],
				plaintext: [],
				dep: { status: "ready" },
				pool: [],
				job: { running: false },
				lastPlan: null,
				vscodeImportAvailable: false,
			});
		}),
	);
}

/** 让已 resolve 的 promise 链跑完（refresh → drain → transfer）。 */
const flush = async () => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

let cleanup: (() => void) | undefined;
let container: HTMLElement;

function mount() {
	container = document.createElement("div");
	document.body.appendChild(container);
	cleanup = bundle.mount(container);
	return container;
}

afterEach(() => {
	cleanup?.();
	cleanup = undefined;
	views.length = 0;
	posts.length = 0;
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

const fire = (action: string, target: { id: string; kind?: string; label?: string }) =>
	handlers.get(action)?.(action, undefined, target);

describe("sftp 右键菜单上传与下载动作", () => {
	it("全部六条上传、下载及忽略动作都真的被客户端接管", () => {
		expect([...handlers.keys()].sort()).toEqual([
			"sftp:download-dir",
			"sftp:download-file",
			"sftp:ignore-item",
			"sftp:unignore-item",
			"sftp:upload-dir",
			"sftp:upload-file",
		]);
	});

	it("面板还没挂载：先打开面板并排队，mount 完立刻跑", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		fire("sftp:upload-file", { id: "src/new.txt", kind: "file", label: "new.txt" });
		// 回调先到：面板已切、请求还在排队，一个字节都还没传
		expect(views).toEqual(["plugin:sftp"]);
		expect(posts).toHaveLength(0);

		const el = mount();
		await flush();
		expect(posts).toHaveLength(1);
		expect(posts[0]?.body).toMatchObject({ direction: "up", path: "src/new.txt" });
		// 进度就写在面板里（与面板自己的按钮同一条路径）
		expect(el.textContent ?? "").toContain("new.txt");
		expect(el.textContent ?? "").toContain("已上传 1 个文件");
	});

	it("面板已挂载：直接跑，且上传目录同样是 scope=tree 的口径（服务端按 stat 判）", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		mount();
		await flush();
		fire("sftp:upload-dir", { id: "web/dist", kind: "dir", label: "dist" });
		await flush();
		expect(posts).toHaveLength(1);
		expect(posts[0]?.body).toMatchObject({ direction: "up", path: "web/dist" });
	});

	it("机器浏览的绝对路径：在工作区内折算成相对路径", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		mount();
		await flush();
		fire("sftp:upload-file", { id: "E:/proj/src/a.ts", kind: "file", label: "a.ts" });
		await flush();
		expect(posts).toHaveLength(1);
		expect(posts[0]?.body).toMatchObject({ path: "src/a.ts" });
	});

	it("工作区外的绝对路径：拒绝并给明确原因，绝不硬塞给服务端", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		const el = mount();
		await flush();
		fire("sftp:upload-file", { id: "E:/other/secret.txt", kind: "file", label: "secret.txt" });
		await flush();
		expect(posts).toHaveLength(0);
		expect(el.textContent ?? "").toContain("只能同步工作区内的文件");
	});

	it("POSIX 绝对路径（Linux 上会被服务端当成远端路径）同样被拦下", async () => {
		document.documentElement.lang = "en";
		stubFetch();
		const el = mount();
		await flush();
		fire("sftp:upload-dir", { id: "/etc", kind: "dir", label: "etc" });
		await flush();
		expect(posts).toHaveLength(0);
		expect(el.textContent ?? "").toContain("Only files inside the workspace");
	});

	it("右键文件列表空白处（代表当前目录，id: ''）：上传与下载整目录", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		mount();
		await flush();

		// 空白处上传当前目录
		fire("sftp:upload-dir", { id: "", kind: "list", label: "根目录" });
		await flush();
		expect(posts).toHaveLength(1);
		expect(posts[0]?.body).toMatchObject({ direction: "up", path: "" });

		// 空白处从远端下载同步当前目录
		fire("sftp:download-dir", { id: "", kind: "list", label: "根目录" });
		await flush();
		expect(posts).toHaveLength(2);
		expect(posts[1]?.body).toMatchObject({ direction: "down", path: "" });
	});

	it("右键文件/目录添加到忽略与从忽略移除", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		mount();
		await flush();

		fire("sftp:ignore-item", { id: "dist", kind: "dir", label: "dist" });
		await flush();
		expect(posts).toHaveLength(1);
		expect(posts[0]?.path).toContain("/ignore-toggle");
		expect(posts[0]?.body).toMatchObject({ path: "dist", mode: "add" });

		fire("sftp:unignore-item", { id: "dist", kind: "dir", label: "dist" });
		await flush();
		expect(posts).toHaveLength(2);
		expect(posts[1]?.path).toContain("/ignore-toggle");
		expect(posts[1]?.body).toMatchObject({ path: "dist", mode: "remove" });
	});
});
