import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

export class DeviceWorkspaceError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
	) {
		super(message);
	}
}
function invalid(message: string): never {
	throw new DeviceWorkspaceError(400, "WORKSPACE_INVALID", message);
}
function contains(root: string, target: string): boolean {
	const rel = relative(root, target);
	return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export async function validateDeviceProject(input: string, dataDir: string): Promise<string> {
	if (typeof input !== "string" || !input || !isAbsolute(input)) invalid("Select an absolute project directory");
	try {
		const selected = resolve(input);
		for (let current = selected; ; current = dirname(current)) {
			const stat = await lstat(current);
			if (stat.isSymbolicLink() || !stat.isDirectory())
				invalid("Project path must contain directories without symbolic links");
			if (dirname(current) === current) break;
		}
		const [root, home, dataRoot] = await Promise.all([realpath(selected), realpath(homedir()), realpath(dataDir)]);
		if (root === parse(root).root || relative(home, root) === "") invalid("Home and volume roots cannot be projects");
		if (contains(root, dataRoot)) invalid("Device data directory must be outside the project");
		return root;
	} catch (error) {
		if (error instanceof DeviceWorkspaceError) throw error;
		invalid("Project directory is unavailable");
	}
}
