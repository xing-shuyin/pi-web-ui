import { dirname, resolve as resolveFsPath } from "node:path";
import { sessionDirOfBase } from "../adapters/sdk/session-persist.js";
import { resolveWorkspaceSessionDir } from "../remote-workspace.js";
import { piSessionsRoot } from "../session-search.js";

/** 项目历史目录解析：运行时只持有「当前 cwd / dataDir / 已学到的转录目录」三个事实。 */
export class HistoryRoots {
	private learnedRoot: string | undefined;

	constructor(
		private readonly dataDir: () => string | undefined,
		private readonly cwd: () => string,
	) {}

	noteSessionFile(file: string | undefined): void {
		if (file) this.learnedRoot = dirname(file);
	}

	root(): string | undefined {
		if (this.learnedRoot) return this.learnedRoot;
		const extra = piSessionsRoot();
		if (extra) return extra;
		try {
			const base = resolveWorkspaceSessionDir(this.dataDir(), this.cwd());
			return sessionDirOfBase(base) ?? undefined;
		} catch {
			return this.learnedRoot;
		}
	}

	rootFor(targetCwd: string): string | undefined {
		if (resolveFsPath(targetCwd) === resolveFsPath(this.cwd())) return this.root();
		try {
			const base = resolveWorkspaceSessionDir(this.dataDir(), targetCwd);
			return sessionDirOfBase(base) ?? undefined;
		} catch {
			return undefined;
		}
	}
}
