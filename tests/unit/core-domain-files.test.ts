import { describe, expect, it, vi } from "vitest";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import type { FilesPort, WorkspacePort } from "../../packages/keel/src/contracts/files.js";
import { createFilesHandlers, type FilesHandlers } from "../../packages/keel/src/domains/files/handlers.js";

type Call = [name: string, ...args: unknown[]];

function fakeFiles(overrides: Partial<FilesPort> = {}): { port: FilesPort; calls: Call[] } {
	const calls: Call[] = [];
	const record =
		(name: string) =>
		(...args: unknown[]) => {
			calls.push([name, ...args]);
			return Promise.resolve();
		};
	const port: FilesPort = {
		listFiles: record("listFiles") as FilesPort["listFiles"],
		searchFiles: record("searchFiles") as FilesPort["searchFiles"],
		readFile: record("readFile") as FilesPort["readFile"],
		writeFile: record("writeFile") as FilesPort["writeFile"],
		uploadFile: record("uploadFile") as FilesPort["uploadFile"],
		makeDir: vi.fn(async (input: string) => {
			calls.push(["makeDir", input]);
			return input;
		}) as FilesPort["makeDir"],
		createEntry: record("createEntry") as FilesPort["createEntry"],
		renameEntry: record("renameEntry") as FilesPort["renameEntry"],
		deleteEntry: record("deleteEntry") as FilesPort["deleteEntry"],
		copyEntry: record("copyEntry") as FilesPort["copyEntry"],
		revealEntry: record("revealEntry") as FilesPort["revealEntry"],
		openDefaultEntry: record("openDefaultEntry") as FilesPort["openDefaultEntry"],
		completePath: record("completePath") as FilesPort["completePath"],
		scmQuery: record("scmQuery") as FilesPort["scmQuery"],
		...overrides,
	};
	return { port, calls };
}

function fakeWorkspace(): { port: WorkspacePort; calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		port: {
			setCwd: async (path: string) => void calls.push(["setCwd", path]),
			setWorkspaceRoots: async (roots?: string[]) => void calls.push(["setWorkspaceRoots", roots]),
		},
	};
}

const cases: [keyof FilesHandlers, (h: FilesHandlers) => unknown, Call][] = [
	["listFiles", (h) => h.listFiles("src"), ["listFiles", "src"]],
	["searchFiles", (h) => h.searchFiles("cfg", 7, "workspace"), ["searchFiles", "cfg", 7, "workspace"]],
	["readFile", (h) => h.readFile("a.md"), ["readFile", "a.md"]],
	["writeFile", (h) => h.writeFile("a.md", "hi"), ["writeFile", "a.md", "hi"]],
	["uploadFile", (h) => h.uploadFile("docs", "x.png", "b64", "u1"), ["uploadFile", "docs", "x.png", "b64", "u1"]],
	["createEntry", (h) => h.createEntry("src", "n.ts", "file"), ["createEntry", "src", "n.ts", "file"]],
	["renameEntry", (h) => h.renameEntry("src/a.ts", "b.ts"), ["renameEntry", "src/a.ts", "b.ts"]],
	["deleteEntry", (h) => h.deleteEntry("src/a.ts"), ["deleteEntry", "src/a.ts"]],
	["copyEntry", (h) => h.copyEntry("src/a.ts", "dst", true), ["copyEntry", "src/a.ts", "dst", true]],
	["revealEntry", (h) => h.revealEntry("src/a.ts"), ["revealEntry", "src/a.ts"]],
	["openDefaultEntry", (h) => h.openDefaultEntry("src/a.ts"), ["openDefaultEntry", "src/a.ts"]],
	["completePath", (h) => h.completePath("src/"), ["completePath", "src/"]],
	[
		"scmQuery",
		(h) => h.scmQuery("filediff", 12, { path: "src/a.ts" }),
		["scmQuery", "filediff", 12, { path: "src/a.ts" }],
	],
];

describe("文件 handler（B3）· 按位转发", () => {
	for (const [member, invoke, expected] of cases) {
		it(`${member} → ${expected[0]}`, async () => {
			const { port, calls } = fakeFiles();
			const { port: workspace } = fakeWorkspace();
			await invoke(createFilesHandlers({ files: () => port, workspace: () => workspace }));
			expect(calls).toEqual([expected]);
		});
	}

	it("工作区绑定走独立窄面（setCwd / setWorkspaceRoots）", async () => {
		const { port } = fakeFiles();
		const { port: workspace, calls } = fakeWorkspace();
		const handlers = createFilesHandlers({ files: () => port, workspace: () => workspace });
		await handlers.setCwd("/work/next");
		await handlers.setWorkspaceRoots(["/work/extra"]);
		expect(calls).toEqual([
			["setCwd", "/work/next"],
			["setWorkspaceRoots", ["/work/extra"]],
		]);
	});

	it("makeDir(setAsCwd=false) 只建目录，不动工作区", async () => {
		const { port, calls } = fakeFiles();
		const { port: workspace, calls: workspaceCalls } = fakeWorkspace();
		await createFilesHandlers({ files: () => port, workspace: () => workspace }).makeDir("new-dir");
		expect(calls).toEqual([["makeDir", "new-dir"]]);
		expect(workspaceCalls).toEqual([]);
	});

	it("makeDir(setAsCwd=true) 是两步：先建目录，再把工作区切到**建出来的**那个路径", async () => {
		const { port, calls } = fakeFiles({ makeDir: vi.fn(async () => "/abs/new-dir") as FilesPort["makeDir"] });
		const { port: workspace, calls: workspaceCalls } = fakeWorkspace();
		await createFilesHandlers({ files: () => port, workspace: () => workspace }).makeDir("new-dir", true);
		expect(calls).toEqual([]);
		expect(workspaceCalls).toEqual([["setCwd", "/abs/new-dir"]]);
	});

	it("makeDir 建失败（返回 null）时不拿半成品去切工作区", async () => {
		const { port } = fakeFiles({ makeDir: vi.fn(async () => null) as FilesPort["makeDir"] });
		const { port: workspace, calls: workspaceCalls } = fakeWorkspace();
		await createFilesHandlers({ files: () => port, workspace: () => workspace }).makeDir("bad", true);
		expect(workspaceCalls).toEqual([]);
	});

	it("端口缺省时每个成员都同步抛 CoreEngineNotReadyError", () => {
		const handlers = createFilesHandlers({});
		const silent: string[] = [];
		for (const [member, invoke] of cases) {
			try {
				invoke(handlers);
				silent.push(`${member}（没抛）`);
			} catch (err) {
				if (!(err instanceof CoreEngineNotReadyError)) silent.push(`${member}（抛错类型不对）`);
			}
		}
		const extras: [string, () => unknown][] = [
			["setCwd", () => handlers.setCwd("x")],
			["setWorkspaceRoots", () => handlers.setWorkspaceRoots(["x"])],
			["makeDir", () => handlers.makeDir("x")],
			["makeDir+setAsCwd", () => handlers.makeDir("x", true)],
		];
		for (const [member, invoke] of extras) {
			try {
				invoke();
				silent.push(`${member}（没抛）`);
			} catch (err) {
				if (!(err instanceof CoreEngineNotReadyError)) silent.push(`${member}（抛错类型不对）`);
			}
		}
		expect(silent).toEqual([]);
	});

	it("写盘失败不吞：端口抛错原样冒泡（删/写都是不可逆操作）", async () => {
		const { port } = fakeFiles({
			deleteEntry: (() => Promise.reject(new Error("EPERM: 删除失败"))) as FilesPort["deleteEntry"],
		});
		await expect(createFilesHandlers({ files: () => port }).deleteEntry("src/a.ts")).rejects.toThrow("删除失败");
	});
});
