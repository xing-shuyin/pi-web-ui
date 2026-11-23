import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { CommandDef } from "./protocol.js";

/** `.pi/commands.json` 的形状（两种历史写法都认：裸数组 / `{ commands }`）。 */
export interface CommandsFile {
	commands: CommandDef[];
}

/** 命令文件的路径解析：远程工作区落会话目录，本地落 `<workspace>/.pi`（这是宿主知识，注入）。 */
export type CommandsPathResolver = (workspaceRoot: string) => string;

/** 读命令文件：文件层面的错误一律降级成 warning（命令面板不能因此空掉）。 */
export async function loadCommands(
	workspaceRoot: string,
	pathOf: CommandsPathResolver,
): Promise<{ commands: CommandDef[]; path: string; warning?: string; warningEn?: string }> {
	const path = pathOf(workspaceRoot);
	const { commands, warning, warningEn } = await readCommandsFile(path);
	return { commands, path, warning, warningEn };
}

function pickCommands(list: unknown[]): CommandDef[] {
	return list
		.filter(
			(c): c is CommandDef =>
				typeof c === "object" &&
				c !== null &&
				typeof (c as CommandDef).name === "string" &&
				typeof (c as CommandDef).command === "string",
		)
		.map((c) => ({ name: c.name, command: c.command, cwd: c.cwd }));
}

async function readCommandsFile(
	path: string,
): Promise<{ commands: CommandDef[]; warning?: string; warningEn?: string }> {
	if (!existsSync(path)) return { commands: [] };
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		return {
			commands: [],
			warning: `读取命令文件失败：${(err as Error).message}`,
			warningEn: `Failed to read commands file: ${(err as Error).message}`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			commands: [],
			warning: `命令文件不是有效 JSON：${path}`,
			warningEn: `Commands file is not valid JSON: ${path}`,
		};
	}
	if (Array.isArray(parsed)) return { commands: pickCommands(parsed) };
	const obj = parsed as { commands?: unknown };
	if (obj && Array.isArray(obj.commands)) return { commands: pickCommands(obj.commands) };
	return { commands: [], warning: `命令文件格式不正确：${path}`, warningEn: `Commands file has a bad format: ${path}` };
}

/** 写命令文件：失败返回 error（老实现不抛，由调用方发 notice）。 */
export async function saveCommandsFile(
	workspaceRoot: string,
	commands: CommandDef[],
	pathOf: CommandsPathResolver,
): Promise<{ path: string; error?: string; errorEn?: string }> {
	const path = pathOf(workspaceRoot);
	try {
		await mkdir(dirname(path), { recursive: true });
		const payload: CommandsFile = { commands };
		await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		return { path };
	} catch (err) {
		return {
			path,
			error: `保存命令文件失败：${(err as Error).message}`,
			errorEn: `Failed to save commands file: ${(err as Error).message}`,
		};
	}
}
