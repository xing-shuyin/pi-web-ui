/**
 * 远程工作区的 SDK 操作面（宿主能力）。
 *
 * 只有一件事照着老树走：在远程工作区里构造内置工具时，`write`/`read` 要用 SSH/SFTP 的
 * 文件操作而不是本地 fs。内核不实现 SSH（那是 `server/remote-ssh-service.ts` 的两千行），
 * 只把这个可选能力透传进去；宿主没注入就退化成纯本地工具（老树在非远程 cwd 下也是这样）。
 */
export interface RemoteSdkOperations {
	/** 覆盖 `write` 工具的文件操作（`createWriteToolDefinition(cwd, { operations })`）。 */
	write?: unknown;
	/** 覆盖 `read` 工具的文件操作。 */
	read?: unknown;
	/** 覆盖 `edit` 工具的文件操作。 */
	edit?: unknown;
}

/** 按 cwd 取远程操作；返回 `undefined`/`null` = 这不是远程工作区（用本地实现）。 */
export type RemoteSdkOperationsFactory = (cwd: string) => RemoteSdkOperations | null | undefined;
