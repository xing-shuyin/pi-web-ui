import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";
import { copyTree, listTreeFiles, pruneTreeFiles, SKIP_VCS_AND_DEPS } from "./fs-copy.js";

/**
 * 把「一份插件代码目录」从包内（或任何来源）物化到数据目录，并留下一份可校验的回执。
 *
 * 三条不变量（issue #856 的根因全在这三条上）：
 * 1. **验收后才算成功**：副本里必须有 manifest.json 且文件数 > 0，否则返回失败，不落盘、不写回执。
 * 2. **存在 ≠ 已准备**：完整性由回执（`.pi-materialized.json`）+「来源文件一个不缺」裁定。
 *    目录在但没回执 / 缺文件 = 半残，下次调用就地补齐，而不是永久报 manifest 缺失。
 * 3. **新装原子**：走 staging + rename，失败不会留下被当成「已装好」的空目录。
 *
 * 代码目录是纯缓存：用户状态（设置/机密/定时任务）住在 `plugin-data/<id>/`（见 `plugin-paths.ts`），
 * 所以「覆盖」只可能覆盖代码，绝不会碰到用户数据 —— 这是敢自动修复的前提。
 */

export const MATERIALIZE_RECEIPT = ".pi-materialized.json";

export interface MaterializeReceipt {
	version: 1;
	id: string;
	/**
	 * **已落地**那份 manifest 的 version（不是来源的）：就地补齐时目标可能仍是旧版本，
	 * 升级判定必须看「盘上真实是什么」，否则一次修复就会把升级永久挡住。
	 */
	installedVersion: string;
	/** 物化出来的文件清单（相对路径，posix 分隔，已排除 skip 项） */
	files: string[];
	at: string;
}

export type MaterializeStatus = "created" | "upgraded" | "repaired" | "present" | "source-invalid" | "failed";

export interface MaterializeOutcome {
	status: MaterializeStatus;
	id: string;
	files: number;
	error?: string;
}

export interface MaterializeOptions {
	id: string;
	/** 来源目录（包内 `plugins/<id>`、解包目录等） */
	sourceDir: string;
	/** 目标代码目录（`pluginCodeDir(dataDir, id)`） */
	targetDir: string;
	/**
	 * 覆盖式升级：目标已有 manifest 时**整份覆盖**（调用方应先备份）。
	 * 关闭时只做「确保完整」：缺什么补什么，绝不覆盖已有文件。
	 */
	upgrade?: boolean;
	/** 覆盖前回调（备份用）。抛错视为放弃覆盖，状态按未覆盖返回。 */
	beforeOverwrite?: () => void;
	skip?: readonly string[];
}

function readSourceVersion(sourceDir: string, id: string): string | null {
	try {
		const raw = JSON.parse(readFileSync(join(sourceDir, "manifest.json"), "utf8")) as {
			id?: unknown;
			version?: unknown;
		};
		if (raw?.id !== undefined && raw.id !== id) return null;
		return typeof raw.version === "string" ? raw.version.trim() : "";
	} catch {
		return null;
	}
}

export function readMaterializeReceipt(targetDir: string): MaterializeReceipt | null {
	try {
		const raw = JSON.parse(readFileSync(join(targetDir, MATERIALIZE_RECEIPT), "utf8")) as Partial<MaterializeReceipt>;
		if (raw?.version !== 1 || typeof raw.id !== "string" || !Array.isArray(raw.files)) return null;
		return {
			version: 1,
			id: raw.id,
			installedVersion: typeof raw.installedVersion === "string" ? raw.installedVersion : "",
			files: raw.files.filter((f): f is string => typeof f === "string"),
			at: typeof raw.at === "string" ? raw.at : "",
		};
	} catch {
		return null;
	}
}

function readInstalledVersion(targetDir: string, fallback: string): string {
	try {
		const raw = JSON.parse(readFileSync(join(targetDir, "manifest.json"), "utf8")) as { version?: unknown };
		return typeof raw.version === "string" ? raw.version.trim() : fallback;
	} catch {
		return fallback;
	}
}

function writeReceipt(targetDir: string, receipt: MaterializeReceipt): void {
	writeJsonAtomicSync(join(targetDir, MATERIALIZE_RECEIPT), receipt, 0);
}

/** 回执在、id 对得上、manifest 在、登记的文件一个不少 → 这份物化结果完整 */
export function isMaterialized(targetDir: string, id: string): boolean {
	const receipt = readMaterializeReceipt(targetDir);
	if (!receipt || receipt.id !== id || receipt.files.length === 0) return false;
	if (!existsSync(join(targetDir, "manifest.json"))) return false;
	return receipt.files.every((rel) => existsSync(join(targetDir, rel)));
}

/** 来源有、目标缺的文件（用来识别「没回执的老副本」是不是半残） */
function missingFromTarget(sourceDir: string, targetDir: string, skip: readonly string[]): string[] {
	const have = new Set(listTreeFiles(targetDir, { skip }));
	return listTreeFiles(sourceDir, { skip }).filter((rel) => !have.has(rel));
}

function replaceDir(staging: string, targetDir: string): void {
	try {
		renameSync(staging, targetDir);
	} catch (err) {
		// Windows 上 rename 覆盖已存在目录会 EPERM/ENOTEMPTY：先删再换
		if (!existsSync(targetDir)) throw err;
		rmSync(targetDir, { recursive: true, force: true });
		renameSync(staging, targetDir);
	}
}

/**
 * 物化一份插件代码目录。
 *
 * - `created`：目标不存在 → staging 复制 + 验收 + rename 原子落盘
 * - `present`：完整（回执全在，或来源文件一个不缺）且不要求升级 → 什么都不做
 * - `upgraded`：`upgrade` 且目标已有 manifest → 先 `beforeOverwrite()`，再整份覆盖 + 清理旧登记文件
 * - `repaired`：半残（无回执 / 缺文件 / 没有 manifest）→ **只补缺**，绝不覆盖已有文件
 */
export function materializePlugin(opts: MaterializeOptions): MaterializeOutcome {
	const { id, sourceDir, targetDir } = opts;
	const skip = opts.skip ?? SKIP_VCS_AND_DEPS;
	const sourceVersion = readSourceVersion(sourceDir, id);
	if (sourceVersion === null) return { status: "source-invalid", id, files: 0 };

	const exists = existsSync(targetDir);
	const hasTargetManifest = exists && existsSync(join(targetDir, "manifest.json"));
	const previous = readMaterializeReceipt(targetDir);
	const complete =
		hasTargetManifest && (isMaterialized(targetDir, id) || missingFromTarget(sourceDir, targetDir, skip).length === 0);
	const stamp = new Date().toISOString();

	try {
		if (!exists) {
			mkdirSync(dirname(targetDir), { recursive: true });
			const staging = mkdtempSync(join(dirname(targetDir), ".materialize-"));
			let count = 0;
			try {
				copyTree(sourceDir, staging, { skip });
				const files = listTreeFiles(staging, { skip });
				count = files.length;
				if (!existsSync(join(staging, "manifest.json")) || files.length === 0) {
					throw new Error(`copy produced no payload (${files.length} files) — source ${sourceDir}`);
				}
				writeReceipt(staging, { version: 1, id, installedVersion: sourceVersion, files, at: stamp });
				replaceDir(staging, targetDir);
			} finally {
				rmSync(staging, { recursive: true, force: true });
			}
			return { status: "created", id, files: count };
		}

		if (opts.upgrade && hasTargetManifest) {
			opts.beforeOverwrite?.();
			copyTree(sourceDir, targetDir, { skip });
			if (!existsSync(join(targetDir, "manifest.json"))) {
				throw new Error(`copy left no manifest.json in ${targetDir}`);
			}
			const files = listTreeFiles(targetDir, { skip });
			writeReceipt(targetDir, { version: 1, id, installedVersion: sourceVersion, files, at: stamp });
			pruneStale(targetDir, previous, files, id);
			return { status: "upgraded", id, files: files.length };
		}

		if (complete) return { status: "present", id, files: previous?.files.length ?? 0 };

		copyTree(sourceDir, targetDir, { skip, missingOnly: true });
		if (!existsSync(join(targetDir, "manifest.json"))) {
			throw new Error(`copy left no manifest.json in ${targetDir}`);
		}
		const files = listTreeFiles(targetDir, { skip });
		writeReceipt(targetDir, {
			version: 1,
			id,
			installedVersion: readInstalledVersion(targetDir, sourceVersion),
			files,
			at: stamp,
		});
		pruneStale(targetDir, previous, files, id);
		return { status: "repaired", id, files: files.length };
	} catch (err) {
		return { status: "failed", id, files: 0, error: err instanceof Error ? err.message : String(err) };
	}
}

/** 只清理「上一份回执登记过、这一份没有」的文件，绝不碰 node_modules / 插件自建的缓存 */
function pruneStale(
	targetDir: string,
	previous: MaterializeReceipt | null,
	files: readonly string[],
	id: string,
): void {
	if (!previous || previous.id !== id) return;
	const current = new Set(files);
	pruneTreeFiles(
		targetDir,
		previous.files.filter((rel) => !current.has(rel)),
	);
}
