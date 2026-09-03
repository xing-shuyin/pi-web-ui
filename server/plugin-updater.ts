/**
 * 插件更新辅助（备份/回滚 + 远端 sha 对比）——纯逻辑，供 CLI（bin/pi-web-ui.mjs）
 * 与单测共用。零网络依赖：远端 sha 经注入的 exec 获取（生产 = git ls-remote；
 * 测试 = fake exec 或本地 git 仓库路径，git ls-remote 支持本地仓库，完全离线）。
 *
 * 布局：
 *   <dataDir>/plugins/<id>/           安装本体（含 .pi-source.json + .pi-git-sha）
 *   <dataDir>/plugin-backups/<id>-<ts>/  覆盖安装前的旧版本快照（保留最近 N 份）
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";

const PLUGIN_ID_RE = /^[A-Za-z0-9_-]+$/;
/** 保留的备份份数（超出删除最旧的）。 */
export const BACKUP_KEEP = 3;

export type Exec = (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/** 默认执行器：execFile 直跑 git（不经 shell），15s 超时。 */
export const execGit: Exec = (cmd, args) =>
	new Promise((resolve) => {
		execFile(cmd, args, { timeout: 15_000, encoding: "utf8" }, (err, stdout, stderr) => {
			if (err) resolve({ ok: false, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
			else resolve({ ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});

/**
 * 覆盖安装前备份旧插件目录 → <dataDir>/plugin-backups/<id>-<ts>/。
 * 目标不存在/备份失败返回 null（调用方可继续——备份是尽力而为的保护）。
 */
export function ensureBackup(dataDir: string, id: string, opts?: { source?: string }): string | null {
	if (!PLUGIN_ID_RE.test(id)) return null;
	const target = join(dataDir, "plugins", id);
	if (!existsSync(target)) return null;
	const ts = stamp();
	const dest = join(dataDir, "plugin-backups", `${id}-${ts}`);
	try {
		mkdirSync(dirnameOf(dest)!, { recursive: true });
		cpSync(target, dest, {
			recursive: true,
			// 与安装一致：不备份 .git/node_modules（纯运行目录），config.json 等保留。
			filter: (s) => !/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(s),
		});
		writeFileSync(join(dest, ".pi-backup.json"), JSON.stringify({ id, ts, source: opts?.source }, null, 2) + "\n");
		pruneBackups(dataDir, id);
		return ts;
	} catch (err) {
		try {
			rmSync(dest, { recursive: true, force: true });
		} catch {
			/* 清理失败忽略 */
		}
		console.warn(`[plugin-updater] 备份 ${id} 失败：`, err instanceof Error ? err.message : err);
		return null;
	}
}

/** 该插件的备份目录列表（按时间从新到旧）。 */
export function listBackups(dataDir: string, id: string): string[] {
	if (!PLUGIN_ID_RE.test(id)) return [];
	const dir = join(dataDir, "plugin-backups");
	let names: string[] = [];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const re = new RegExp(`^${id.replace(/[^A-Za-z0-9_-]/g, "")}-(\\d{8}-\\d{9})$`);
	return names
		.filter((n) => re.test(n) && existsSync(join(dir, n, ".pi-backup.json")))
		.sort()
		.reverse();
}

/**
 * 回滚到最近一份备份：删当前 plugins/<id> → 拷贝备份回 → 删备份。
 * 返回最近备份 ts；无备份返回 null。
 */
export function restoreBackup(dataDir: string, id: string): string | null {
	const backups = listBackups(dataDir, id);
	if (backups.length === 0) return null;
	const src = join(dataDir, "plugin-backups", backups[0]);
	const target = join(dataDir, "plugins", id);
	try {
		if (existsSync(target)) rmSync(target, { recursive: true, force: true });
		mkdirSync(join(dataDir, "plugins"), { recursive: true });
		cpSync(src, target, { recursive: true });
		rmSync(src, { recursive: true, force: true });
		return backups[0];
	} catch (err) {
		console.warn(`[plugin-updater] 回滚 ${id} 失败：`, err instanceof Error ? err.message : err);
		return null;
	}
}

/** 保留最近 BACKUP_KEEP 份，删除更旧的。 */
export function pruneBackups(dataDir: string, id: string, keep = BACKUP_KEEP): void {
	const backups = listBackups(dataDir, id);
	for (const b of backups.slice(keep)) {
		try {
			rmSync(join(dataDir, "plugin-backups", b), { recursive: true, force: true });
		} catch {
			/* 忽略 */
		}
	}
}

/**
 * 解析一个安装源并取远端 HEAD sha（前 12 位）。
 *  - 本地 git 仓库路径 / file:// → git ls-remote <path> HEAD（离线）
 *  - GitHub owner/repo、URL → git ls-remote https://github.com/o/r.git HEAD
 *  - 无法识别 / git 不在 / 网络失败 → null（调用方标记「无法检查」）
 */
export async function resolveRemoteSha(spec: string, exec: Exec = execGit): Promise<string | null> {
	const clean = String(spec ?? "").trim();
	if (!clean) return null;
	let remote: string | null = null;
	if (existsSync(clean)) {
		remote = clean; // 本地 git 仓库路径
	} else if (/^file:\/\//i.test(clean)) {
		remote = clean.slice("file://".length);
	} else {
		// GitHub 形态（owner/repo、URL、git@）
		let s = clean.replace(/^git@([^:]+):/, "");
		const m = s.match(/^https?:\/\/(?:www\.)?github\.com\/(.+?)(?:\.git)?\/?$/i);
		if (m) [, s] = m;
		s = s.split("#")[0]; // 去掉 #分支
		const segs = s.split("/").filter(Boolean);
		if (segs.length < 2) return null;
		// 只取 owner/repo（/tree/<ref>/<subpath> 等后缀不影响远端 sha）
		const repo = segs[0] + "/" + segs[1].replace(/\.git$/, "");
		remote = `https://github.com/${repo}.git`;
	}
	if (!remote) return null;
	const res = await exec("git", ["ls-remote", remote, "HEAD"]);
	if (!res.ok) return null;
	// 行格式: <sha>\tHEAD（可能多行——取第一行）
	const sha = res.stdout.match(/^([0-9a-f]{40,64})\s+HEAD/m)?.[1] ?? null;
	return sha ? sha.slice(0, 12) : null;
}

export interface PluginUpdateInfo {
	id: string;
	name?: string;
	version?: string;
	source: string;
	/** 本地安装时记录的 sha（.pi-git-sha）。 */
	localSha: string | null;
	/** 远端 HEAD sha（null = 无法检查：非 git 源 / git 不可用 / 网络失败）。 */
	remoteSha: string | null;
	/** localSha 与 remoteSha 都存在且不同。 */
	updatable: boolean;
	error?: string;
}

/** 扫描全部已装插件，对比本地 sha 与远端 sha，报告更新状态。 */
export async function checkPluginUpdates(dataDir: string, exec: Exec = execGit): Promise<PluginUpdateInfo[]> {
	const pluginsDir = join(dataDir, "plugins");
	let names: string[] = [];
	try {
		names = readdirSync(pluginsDir).sort();
	} catch {
		return [];
	}
	const out: PluginUpdateInfo[] = [];
	for (const n of names) {
		if (!PLUGIN_ID_RE.test(n)) continue;
		const dir = join(pluginsDir, n);
		try {
			const sourceJson = readFileSync(join(dir, ".pi-source.json"), "utf8");
			const { source } = JSON.parse(sourceJson) as { source?: string };
			if (!source) continue; // 无来源记录（手工拷入）→ skip
			let localSha: string | null = null;
			try {
				localSha = readFileSync(join(dir, ".pi-git-sha"), "utf8").trim() || null;
			} catch {
				localSha = null; // 无 sha 记录 → 保守认为可更新（不知道装了哪个版本）
			}
			let remoteSha: string | null = null;
			let error: string | undefined;
			try {
				remoteSha = await resolveRemoteSha(source, exec);
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
				remoteSha = null;
			}
			if (!remoteSha && !error) error = "无法检查（非 git 源或 git 不可用）";
			let name: string | undefined;
			let version: string | undefined;
			try {
				const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
					name?: string;
					version?: string;
				};
				name = m.name;
				version = m.version;
			} catch {
				/* 坏 manifest：仍报告 */
			}
			const updatable = !!remoteSha && (!localSha || localSha !== remoteSha);
			out.push({
				id: n,
				name,
				version,
				source,
				localSha,
				remoteSha,
				updatable,
				error,
			});
		} catch {
			continue; // 坏目录跳过
		}
	}
	return out;
}

function stamp(): string {
	const d = new Date();
	const p = (x: number, n = 2) => String(x).padStart(n, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

function dirnameOf(p: string): string | null {
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i >= 0 ? p.slice(0, i) : null;
}
