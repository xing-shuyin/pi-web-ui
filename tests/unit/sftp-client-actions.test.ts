// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

type Handler = (itemId: string, value?: string, target?: { id: string; kind?: string; label?: string }) => void;
type Post = { path: string; body: Record<string, unknown> };

const handlers = new Map<string, Handler>();
const views: string[] = [];
const posts: Post[] = [];
const CWD = "E:/proj";

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
			if (u.includes("/profile") || u.includes("/remove") || u.includes("/active")) {
				posts.push({ path: u, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
				return send({ ok: true });
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
				secrets: ["my-existing-secret"],
			});
		}),
	);
}

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
		expect(views).toEqual(["plugin:sftp"]);
		expect(posts).toHaveLength(0);

		const el = mount();
		await flush();
		expect(posts).toHaveLength(1);
		expect(posts[0]?.body).toMatchObject({ direction: "up", path: "src/new.txt" });
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

		fire("sftp:upload-dir", { id: "", kind: "list", label: "根目录" });
		await flush();
		expect(posts).toHaveLength(1);
		expect(posts[0]?.body).toMatchObject({ direction: "up", path: "" });

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

describe("sftp 密码帮助问号与使用说明", () => {
	it("密码标签旁渲染问号按钮，带有提示与无障碍说明", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		const c = mount();
		await flush();

		const btnHelp = c.querySelector<HTMLButtonElement>(".btn-help-pass");
		expect(btnHelp).not.toBeNull();
		expect(btnHelp?.textContent?.trim()).toBe("?");
		expect(btnHelp?.title).toContain("密码与 ${secret:名} 变量使用说明");
		expect(btnHelp?.getAttribute("aria-label")).toContain("密码与变量引用说明");

		const card = c.querySelector<HTMLElement>(".pass-help-card");
		expect(card).not.toBeNull();
		expect(card?.classList.contains("hidden")).toBe(true);
	});

	it("点击问号按钮可展开和折叠说明面板，且有关闭按钮", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		const c = mount();
		await flush();

		const btnHelp = c.querySelector<HTMLButtonElement>(".btn-help-pass");
		const card = c.querySelector<HTMLElement>(".pass-help-card");
		const btnClose = c.querySelector<HTMLButtonElement>(".btn-close-help");

		btnHelp?.click();
		expect(card?.classList.contains("hidden")).toBe(false);
		expect(btnHelp?.classList.contains("active")).toBe(true);
		expect(card?.textContent).toContain("直接输入明文");
		expect(card?.textContent).toContain("${secret:名}");

		btnClose?.click();
		expect(card?.classList.contains("hidden")).toBe(true);
		expect(btnHelp?.classList.contains("active")).toBe(false);

		btnHelp?.click();
		expect(card?.classList.contains("hidden")).toBe(false);
		btnHelp?.click();
		expect(card?.classList.contains("hidden")).toBe(true);
	});

	it("写入加密机密后，引用自动填入密码输入框并高亮提示", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		const c = mount();
		await flush();

		const promptMock = vi
			.spyOn(globalThis, "prompt")
			.mockImplementationOnce(() => "prod-pw")
			.mockImplementationOnce(() => "supersecret123");

		const origFetch = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
				const u = String(url);
				if (u.includes("/secret")) {
					return {
						ok: true,
						json: async () => ({ ok: true, data: { name: "prod-pw", ref: "${secret:prod-pw}" } }),
					};
				}
				return origFetch(url, init);
			}),
		);

		const btnSecret = c.querySelector<HTMLButtonElement>(".btn-secret");
		btnSecret?.click();
		await flush();

		const passInput = c.querySelector<HTMLInputElement>(".f-pass");
		expect(passInput?.value).toBe("${secret:prod-pw}");

		const okMsg = c.querySelector<HTMLElement>(".msg.ok");
		expect(okMsg?.textContent).toContain("${secret:prod-pw}");
		promptMock.mockRestore();
	});

	it("认证方式选择加密机密时，显示机密名和值输入框并隐藏明文密码行", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		const c = mount();
		await flush();

		const authSelect = c.querySelector<HTMLSelectElement>(".f-auth");
		expect(authSelect).toBeTruthy();

		authSelect!.value = "secret";
		authSelect!.dispatchEvent(new Event("change"));

		const secretNameWrap = c.querySelector<HTMLElement>(".lbl-secret-name");
		const secretValWrap = c.querySelector<HTMLElement>(".lbl-secret-val");
		const passRow = c.querySelector<HTMLElement>(".lbl-pass");
		const keyRow = c.querySelector<HTMLElement>(".l-keypath");

		expect(secretNameWrap?.classList.contains("hidden")).toBe(false);
		expect(secretValWrap?.classList.contains("hidden")).toBe(false);
		expect(passRow?.classList.contains("hidden")).toBe(true);
		expect(keyRow?.classList.contains("hidden")).toBe(true);

		const secretSelect = c.querySelector<HTMLSelectElement>(".f-secret-select");
		expect(secretSelect).toBeTruthy();
		expect(secretSelect?.innerHTML).toContain("my-existing-secret");

		secretSelect!.value = "my-existing-secret";
		secretSelect!.dispatchEvent(new Event("change"));

		const nameInput = c.querySelector<HTMLInputElement>(".f-secret-name");
		expect(nameInput?.value).toBe("my-existing-secret");

		const statusEl = c.querySelector<HTMLElement>(".secret-name-status");
		expect(statusEl?.textContent).toContain("已有同名机密");

		const chipBtn = c.querySelector<HTMLButtonElement>(".sfx-chip-btn");
		expect(chipBtn?.getAttribute("data-sec")).toBe("my-existing-secret");
		expect(chipBtn?.classList.contains("active")).toBe(true);
	});

	it("检测是否已创建过同名机密：已有同名机密提示直接复用，新机密提示保存时创建", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		const c = mount();
		await flush();

		const authSelect = c.querySelector<HTMLSelectElement>(".f-auth")!;
		authSelect.value = "secret";
		authSelect.dispatchEvent(new Event("change"));

		const nameInput = c.querySelector<HTMLInputElement>(".f-secret-name")!;
		const valInput = c.querySelector<HTMLInputElement>(".f-secret-val")!;
		const statusEl = c.querySelector<HTMLElement>(".secret-name-status")!;

		nameInput.value = "my-existing-secret";
		nameInput.dispatchEvent(new Event("input"));

		expect(statusEl.textContent).toContain("已有同名机密");
		expect(valInput.placeholder).toContain("留空直接复用");

		nameInput.value = "brand-new-secret";
		nameInput.dispatchEvent(new Event("input"));

		expect(statusEl.textContent).toContain("新机密");
		expect(valInput.placeholder).toContain("输入密码/机密值");
	});

	it("保存已有同名机密时直接复用，无需输入机密值也无需重复调用 /secret", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		const c = mount();
		await flush();

		let secretApiCalled = false;
		let savedPatch: any = null;

		const origFetch = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
				const u = String(url);
				if (u.includes("/secret")) {
					secretApiCalled = true;
					return { ok: true, json: async () => ({ ok: true, data: { name: "my-existing-secret" } }) };
				}
				if (u.includes("/profile")) {
					savedPatch = JSON.parse(String(init?.body ?? "{}"));
					return { ok: true, json: async () => ({ ok: true, data: { name: "mock" } }) };
				}
				return origFetch(url, init);
			}),
		);

		const authSelect = c.querySelector<HTMLSelectElement>(".f-auth")!;
		authSelect.value = "secret";
		authSelect.dispatchEvent(new Event("change"));

		const nameInput = c.querySelector<HTMLInputElement>(".f-secret-name")!;
		const valInput = c.querySelector<HTMLInputElement>(".f-secret-val")!;
		nameInput.value = "my-existing-secret";
		nameInput.dispatchEvent(new Event("input"));
		valInput.value = "";

		const btnSave = c.querySelector<HTMLButtonElement>(".btn-save")!;
		btnSave.click();
		await flush();

		expect(secretApiCalled).toBe(false);
		expect(savedPatch?.patch?.password).toBe("${secret:my-existing-secret}");
	});

	it("保存新机密时，若填写了机密值则自动调用 /secret 创建并关联", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		const c = mount();
		await flush();

		let secretCallBody: any = null;
		let savedPatch: any = null;

		const origFetch = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
				const u = String(url);
				if (u.includes("/secret")) {
					secretCallBody = JSON.parse(String(init?.body ?? "{}"));
					return {
						ok: true,
						json: async () => ({
							ok: true,
							data: {
								name: secretCallBody.name,
								ref: `\${secret:${secretCallBody.name}}`,
								secrets: ["my-existing-secret", secretCallBody.name],
							},
						}),
					};
				}
				if (u.includes("/profile")) {
					savedPatch = JSON.parse(String(init?.body ?? "{}"));
					return { ok: true, json: async () => ({ ok: true, data: { name: "mock" } }) };
				}
				return origFetch(url, init);
			}),
		);

		const authSelect = c.querySelector<HTMLSelectElement>(".f-auth")!;
		authSelect.value = "secret";
		authSelect.dispatchEvent(new Event("change"));

		const nameInput = c.querySelector<HTMLInputElement>(".f-secret-name")!;
		const valInput = c.querySelector<HTMLInputElement>(".f-secret-val")!;
		nameInput.value = "auto-created-secret";
		nameInput.dispatchEvent(new Event("input"));
		valInput.value = "super-safe-password-999";

		const btnSave = c.querySelector<HTMLButtonElement>(".btn-save")!;
		btnSave.click();
		await flush();

		expect(secretCallBody).toEqual({ name: "auto-created-secret", value: "super-safe-password-999" });
		expect(savedPatch?.patch?.password).toBe("${secret:auto-created-secret}");
		expect(valInput.value).toBe("");
	});

	it("新机密但未填写机密值时，点击保存阻止提交并报错提示", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		const c = mount();
		await flush();

		const authSelect = c.querySelector<HTMLSelectElement>(".f-auth")!;
		authSelect.value = "secret";
		authSelect.dispatchEvent(new Event("change"));

		const nameInput = c.querySelector<HTMLInputElement>(".f-secret-name")!;
		const valInput = c.querySelector<HTMLInputElement>(".f-secret-val")!;
		nameInput.value = "non-existent-secret";
		nameInput.dispatchEvent(new Event("input"));
		valInput.value = "";

		const btnSave = c.querySelector<HTMLButtonElement>(".btn-save")!;
		btnSave.click();
		await flush();

		const errMsg = c.querySelector<HTMLElement>(".msg.err");
		expect(errMsg?.textContent).toContain("尚不存在，请填写机密值");
	});

	it("即使后端未下发 secrets 字段，也能从连接凭据与本地记忆中聚合已建机密并展示在下拉框中", async () => {
		document.documentElement.lang = "zh";

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				const u = String(url);
				if (u.includes("/remote"))
					return { ok: true, json: async () => ({ ok: true, data: { dir: "/", entries: [] } }) };
				return {
					ok: true,
					json: async () => ({
						ok: true,
						data: {
							cwd: CWD,
							configPath: ".pi/sftp.json",
							active: "mock",
							connection: {
								name: "mock",
								host: "127.0.0.1",
								port: 22,
								remotePath: "/home/test",
								ready: true,
								auth: { password: "secret:legacy-secret" },
							},
							profiles: [{ name: "mock", ready: true, auth: { password: "secret:legacy-secret" } }],
						},
					}),
				};
			}),
		);

		const c = mount();
		await flush();

		const authSelect = c.querySelector<HTMLSelectElement>(".f-auth")!;
		expect(authSelect.value).toBe("secret");

		const select = c.querySelector<HTMLSelectElement>(".f-secret-select");
		expect(select?.innerHTML).toContain("legacy-secret");

		const nameInput = c.querySelector<HTMLInputElement>(".f-secret-name");
		expect(nameInput?.value).toBe("legacy-secret");

		const statusEl = c.querySelector<HTMLElement>(".secret-name-status");
		expect(statusEl?.textContent).toContain("已有同名机密");
	});

	it("保存密钥认证后，残留密码引用不会覆盖明确的认证方式", async () => {
		stubFetch();
		const originalFetch = globalThis.fetch;
		let method = "password";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
				if (String(url).includes("/profile")) {
					const body = JSON.parse(String(init?.body ?? "{}"));
					method = body.patch.method;
					expect(body.patch.privateKeyPath).toBe("~/.ssh/id_ed25519");
					return { ok: true, json: async () => ({ ok: true, data: {} }) };
				}
				if (String(url).endsWith("/state")) {
					return {
						ok: true,
						json: async () => ({
							ok: true,
							data: {
								cwd: CWD,
								active: "mock",
								profiles: [{ name: "mock", ready: true }],
								connection: {
									name: "mock",
									ready: true,
									host: "example.test",
									remotePath: "/",
									auth: { method, password: "secret:old-password", privateKeyPath: "~/.ssh/id_ed25519" },
								},
								secrets: ["old-password"],
							},
						}),
					};
				}
				return originalFetch(url, init);
			}),
		);
		const c = mount();
		await flush();
		const auth = c.querySelector<HTMLSelectElement>(".f-auth")!;
		expect(auth.value).toBe("password");
		auth.value = "key";
		auth.dispatchEvent(new Event("change"));
		c.querySelector<HTMLButtonElement>(".btn-save")!.click();
		await flush();
		expect(method).toBe("key");
		expect(auth.value).toBe("key");
		expect(c.querySelector<HTMLInputElement>(".f-keypath")!.value).toBe("~/.ssh/id_ed25519");
	});

	it("支持在界面手动新建连接与删除当前连接", async () => {
		document.documentElement.lang = "zh";
		stubFetch();

		const c = mount();
		await flush();

		const profileSelect = c.querySelector<HTMLSelectElement>(".profile")!;
		const addBtn = c.querySelector<HTMLButtonElement>(".btn-add-profile")!;
		const delBtn = c.querySelector<HTMLButtonElement>(".btn-del-profile")!;
		const newRow = c.querySelector<HTMLElement>(".new-profile-row")!;
		const nameInput = c.querySelector<HTMLInputElement>(".f-new-profile-name")!;
		const confirmBtn = c.querySelector<HTMLButtonElement>(".btn-confirm-add-profile")!;

		expect(profileSelect.innerHTML).toContain("__new__");
		expect(newRow.classList.contains("hidden")).toBe(true);

		addBtn.click();
		expect(newRow.classList.contains("hidden")).toBe(false);

		nameInput.value = "prod-server";
		confirmBtn.click();
		await flush();

		const profilePost = posts.find((p) => p.path.includes("/profile"));
		expect(profilePost).toBeDefined();
		expect(profilePost?.body).toMatchObject({
			name: "prod-server",
			makeActive: true,
		});

		vi.stubGlobal(
			"confirm",
			vi.fn(() => true),
		);
		delBtn.click();
		await flush();

		const removePost = posts.find((p) => p.path.includes("/remove"));
		expect(removePost).toBeDefined();
		expect(removePost?.body).toMatchObject({
			name: "mock",
		});
	});
});
