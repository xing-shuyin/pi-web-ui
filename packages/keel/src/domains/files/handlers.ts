import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { FilesPort, WorkspacePort } from "../../contracts/files.js";

export interface FilesHandlersOptions {
	/** 缺省 = 未接：每个 handler 调到时同步抛 `CoreEngineNotReadyError`。 */
	files?: () => FilesPort | undefined;
	/** 工作区绑定（换 cwd / 换额外根）；缺省 = 该能力未接。 */
	workspace?: () => WorkspacePort | undefined;
}

/** 文件 / 目录 / 工作区绑定的 16 个 handler：全部转发给宿主 `FilesService` + 工作区面。 */
export interface FilesHandlers {
	listFiles(path?: string): Promise<void>;
	searchFiles(query: string, reqId: number, scope?: string): Promise<void>;
	readFile(path: string): Promise<void>;
	writeFile(path: string, text: string): Promise<void>;
	uploadFile(dirPath: string, name: string, data: string, uploadId?: string): Promise<void>;
	makeDir(path: string, setAsCwd?: boolean): Promise<void>;
	createEntry(dir: string, name: string, kind: "file" | "dir"): Promise<void>;
	renameEntry(path: string, newName: string): Promise<void>;
	deleteEntry(path: string): Promise<void>;
	copyEntry(src: string, destDir: string, move?: boolean): Promise<void>;
	revealEntry(path: string): Promise<void>;
	openDefaultEntry(path: string): Promise<void>;
	completePath(path: string): Promise<void>;
	scmQuery(
		kind: "status" | "history" | "filediff" | "commit",
		reqId: number,
		arg?: { path?: string; hash?: string },
	): Promise<void>;
	setCwd(path: string): Promise<void>;
	setWorkspaceRoots(roots?: string[]): Promise<void>;
}

/**
 * `makeDir(setAsCwd)` 是**两步**（老树同口径）：先建目录，再把工作区切过去。
 * 工作区切换本身要排队（`server/workspace-queue.ts` 在 wire 层排队，这里不重复实现队列）。
 */
export function createFilesHandlers(options: FilesHandlersOptions): FilesHandlers {
	const files = (what: string): FilesPort => {
		const port = options.files?.();
		if (!port) throw new CoreEngineNotReadyError(what);
		return port;
	};
	const workspace = (what: string): WorkspacePort => {
		const port = options.workspace?.();
		if (!port) throw new CoreEngineNotReadyError(what);
		return port;
	};

	return {
		listFiles: (path) => files("listFiles").listFiles(path),
		searchFiles: (query, reqId, scope) => files("searchFiles").searchFiles(query, reqId, scope),
		readFile: (path) => files("readFile").readFile(path),
		writeFile: (path, text) => files("writeFile").writeFile(path, text),
		uploadFile: (dirPath, name, data, uploadId) => files("uploadFile").uploadFile(dirPath, name, data, uploadId),
		createEntry: (dir, name, kind) => files("createEntry").createEntry(dir, name, kind),
		renameEntry: (path, newName) => files("renameEntry").renameEntry(path, newName),
		deleteEntry: (path) => files("deleteEntry").deleteEntry(path),
		copyEntry: (src, destDir, move) => files("copyEntry").copyEntry(src, destDir, move),
		revealEntry: (path) => files("revealEntry").revealEntry(path),
		openDefaultEntry: (path) => files("openDefaultEntry").openDefaultEntry(path),
		completePath: (path) => files("completePath").completePath(path),
		scmQuery: (kind, reqId, arg) => files("scmQuery").scmQuery(kind, reqId, arg),

		// 建目录 + （可选）把工作区切过去：异步体在端口解析之后，端口缺失的抛错仍是同步的。
		makeDir(path: string, setAsCwd?: boolean): Promise<void> {
			const port = files("makeDir");
			if (setAsCwd !== true) return port.makeDir(path).then(() => undefined);
			const target = workspace("makeDir.setAsCwd");
			return port.makeDir(path).then(async (created) => {
				// 建失败时 `makeDir` 返回 null（错误帧已由实现发出）：不拿半成品去切工作区。
				if (!created) return;
				await target.setCwd(created);
			});
		},

		setCwd: (path) => workspace("setCwd").setCwd(path),
		setWorkspaceRoots: (roots) => workspace("setWorkspaceRoots").setWorkspaceRoots(roots),
	};
}
