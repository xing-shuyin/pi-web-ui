import { existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadDurableModule } from "./durable-loader.js";

export interface DurableStorageHandle {
	storage: any;
	path?: string;
	isMemory: boolean;
}

export async function openDurableStorage(dataDir: string, cwd: string): Promise<DurableStorageHandle> {
	const durableDir = join(dataDir, "durable");
	if (!existsSync(durableDir)) {
		mkdirSync(durableDir, { recursive: true });
	}

	const slug = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
	const dbPath = join(durableDir, `session-${slug}.sqlite`);

	try {
		const sqliteModule = await loadDurableModule("storage/sqlite/node").catch(() => null);

		if (sqliteModule && typeof sqliteModule.openNodeSqliteStorage === "function") {
			const storage = await sqliteModule.openNodeSqliteStorage(dbPath);
			return { storage, path: dbPath, isMemory: false };
		}
	} catch {}

	const coreModule = await loadDurableModule().catch(() => null);

	if (coreModule && coreModule.MemoryStorage) {
		const storage = new coreModule.MemoryStorage();
		return { storage, isMemory: true };
	}

	throw new Error("Pi Durable 依赖未安装。请运行 npm i -g @earendil-works/pi-durable 启用该引擎。");
}
