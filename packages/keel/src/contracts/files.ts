/**
 * 文件 / 目录面（宿主能力）。
 *
 * 实现就是宿主现成的 `FilesService`（`server/files-service.ts`，约 2k 行：工作区相对路径归一、
 * 上传大小上限、目录监听、窄路径校验都在里面）。内核不重写它，只按这个窄面转发；
 * 宿主侧适配器：`server/core-files-adapter.ts`。
 */
export interface FilesPort {
	listFiles(relPath?: string): Promise<void>;
	searchFiles(query: string, reqId: number, scope?: string): Promise<void>;
	readFile(relPath: string): Promise<void>;
	writeFile(relPath: string, text: string): Promise<void>;
	uploadFile(relDir: string, name: string, data: string, uploadId?: string): Promise<void>;
	/** 建目录，返回新建目录的线径（失败返回 null，错误帧由实现自己发）。 */
	makeDir(input: string): Promise<string | null>;
	createEntry(dir: string, name: string, kind: "file" | "dir"): Promise<void>;
	renameEntry(path: string, newName: string): Promise<void>;
	deleteEntry(path: string): Promise<void>;
	copyEntry(src: string, destDir: string, move?: boolean): Promise<void>;
	revealEntry(path: string): Promise<void>;
	openDefaultEntry(path: string): Promise<void>;
	completePath(input: string): Promise<void>;
	/** SCM 查询（status / history / filediff / commit）：数据与 `scm_data` 帧都归实现（宿主 `FilesService.scmQuery`）。 */
	scmQuery(
		kind: "status" | "history" | "filediff" | "commit",
		reqId: number,
		arg?: { path?: string; hash?: string },
	): Promise<void>;
}

/**
 * 工作区绑定面（宿主能力）：换工作目录 / 换额外根。
 *
 * 这是沙盒与工作树切换的前置（两者末尾都要把工作区切过去），所以单独成一个窄面：
 * 宿主实现要复用老树的「解析目标 → 校验 → 释放旧会话 → 起新会话 → 推帧」整条链。
 */
export interface WorkspacePort {
	setCwd(path: string): Promise<void>;
	setWorkspaceRoots(roots?: string[]): Promise<void>;
}
