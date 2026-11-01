import { Buffer } from "node:buffer";

/** Public facts only: never include parameter values, paths, command text or rule reasons. */
export function approvalOperationSummary(toolName: string, params: unknown): string {
	const input =
		params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
	const lines: string[] = [];
	switch (toolName) {
		case "write":
			lines.push("操作：写入文件 / Operation: write a file");
			if (typeof input.content === "string")
				lines.push(`正文大小 / Content size: ${Buffer.byteLength(input.content, "utf8")} bytes`);
			break;
		case "edit":
		case "edit_soft":
			lines.push("操作：修改文件 / Operation: edit a file");
			if (Array.isArray(input.edits)) lines.push(`替换项数量 / Replacement count: ${input.edits.length}`);
			break;
		case "read":
			lines.push("操作：读取文件或目录 / Operation: read a file or directory");
			break;
		case "bash":
			lines.push("操作：执行 Shell 命令 / Operation: execute a shell command");
			lines.push("可能产生文件、进程或网络副作用 / May affect files, processes or network");
			break;
		default:
			lines.push("操作：调用工具 / Operation: invoke a tool");
			lines.push("副作用未分类 / Side effects are not classified");
	}
	lines.push(
		"参数与命中原因仅在执行设备显示，请检查原生请求后批准。 / Review the native request on the execution device before approving; parameters and rule reasons stay there.",
	);
	return lines.join("\n");
}
