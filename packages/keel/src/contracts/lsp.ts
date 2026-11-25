/**
 * LSP 能力面（宿主能力）：**执行体不搬进内核**。
 *
 * 语言客户端与语言服务器子进程全在宿主叶子 `server/lsp-tool.ts`（1522 行的连接池 / JSON-RPC /
 * 拉起 `tsserver`、`pyright` 等一律留在宿主；内核里 `node:child_process` 的 import 必须保持 0 个）。
 * 内核只做两件事，都从这一支端口取：
 * - `liveDiagnostics`：`patch` 成功后的实时诊断（老 `getLiveLspDiagnostics`）；
 * - `tool`：`lsp` 工具**定义**本身（老 `makeLspTool`），因为建它就要拉起子进程，所以形状归宿主，
 *   内核只把它挂进会话的工具表、交给同一套模式门控与审批。
 *
 * 缺省 = 能力未接：`patch` 不附带诊断、`lsp` 工具不注册。老口径本来就是「尽力而为」——
 * 没装语言服务器时诊断返回 null，绝不能因此让补丁失败（这一支抛错也只能被吃掉）。
 */
export interface LspPort {
	/** 老 `getLiveLspDiagnostics`：尽力而为，没有语言服务器就返回 null（绝不让补丁失败）。 */
	liveDiagnostics?(absPath: string, cwd: string): Promise<string | null>;
	/** 老 `makeLspTool`：工具定义归宿主（要拉起语言服务器子进程），内核只挂载 + 走门控/审批。 */
	tool?(options: { cwd: string; lang(): string }): unknown;
}
