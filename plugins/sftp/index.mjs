/**
 * sftp 服务端入口 —— 项目级 SFTP 同步。
 *
 * 约定：ESM 默认导出 `{ activate(host) → deactivate? }`。
 *
 * 分层（都在 lib/ 下，各自可单测）：
 *   config.mjs  `.pi/sftp.json` + `.pi/sftp.local.json` 的读写/归一化/校验
 *   refs.mjs    凭据引用 ${env:} / ${secret:} / ${file:} 解析
 *   ssh.mjs     ssh2 连接池（惰性补装依赖、指纹重连、空闲回收、远端 exec）
 *   engine.mjs  扫描 → 差异计划 → 并发流式执行（半成品+rename、垃圾桶保护）
 *   remote.mjs  远端文件 CRUD（视图与工具共用）
 *
 * 三处出口共用同一套后端，不存在「UI 能干的 AI 干不了」：
 *   1. HTTP 路由 `/plugins-api/sftp/*`（视图用）
 *   2. AI 工具：**一个 action 式 `sftp`**（status/save/secret/test/plan/sync/cancel/ls/read/write/
 *      mkdir/mv/rm/search，开设置后多一个 exec）—— 动作共用同一份配置与守卫，
 *      拆成十几个工具只会把上下文塞满
 *   3. UI 条目（底栏状态徽标 / 文件右键「上传到远端」）
 *
 * 安全边界：
 *   - 凭据值永不回给浏览器与模型（host.secrets 的值只在服务端解析）；
 *   - 本地路径一律 `safeRel` + 同步根内校验，远端来的文件名含分隔符/`..` 直接丢弃；
 *   - 删除永远先进垃圾桶，垃圾桶目录被内部护栏永久排除（不会下次又被传上去）。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import {
	ensureGitignore,
	importVscodeSftp,
	normalizeDoc,
	pickConnection,
	plaintextCredentials,
	publicConnection,
	readConfig,
	removeConnection,
	safeRel,
	setActive,
	upsertConnection,
} from "./lib/config.mjs";
import {
	applyPlan,
	isAbortError,
	onEngineNote,
	planSync,
	pruneTrash,
	sftpCall,
	statRemote,
	throwIfAborted,
} from "./lib/engine.mjs";
import * as remote from "./lib/remote.mjs";
import { createSshManager } from "./lib/ssh.mjs";

const DEFAULTS = {
	delete: "none",
	concurrency: 4,
	scanConcurrency: 8,
	autoGitignore: true,
	plaintextWarn: true,
	allowExec: false,
	batchTransfer: true,
	trashDays: 7,
};

const MAX_WRITE_BYTES = 2 * 1024 * 1024;
/** 工具回执里逐条列出的计划项上限（其余只给计数，避免把上下文塞满）。 */
const PLAN_LIST_CAP = 40;

export default {
	async activate(host) {
		const log = (msg, level = "info") => {
			try {
				host.log?.(String(msg), level);
			} catch {
				/* 日志失败不影响主流程 */
			}
		};
		const ssh = createSshManager({ host, log, secrets: host.secrets });
		// 引擎的非致命降级（快扫/批量打包用不了）只报一次，不然每次同步都刷屏
		onEngineNote((msg) => log(msg, "warn"));

		/** @type {{running:boolean, kind:string, startedAt:number, phase:string, done:number, total:number, rel:string, bytes:number, scan:{side:string, files:number, dirs:number}, error:string, cancelled:boolean, reusedPlan:boolean, result:any}} */
		let job = {
			running: false,
			kind: "",
			startedAt: 0,
			phase: "",
			done: 0,
			total: 0,
			rel: "",
			bytes: 0,
			scan: { side: "", files: 0, dirs: 0 },
			error: "",
			cancelled: false,
			reusedPlan: false,
			result: null,
		};
		/** 当前任务的取消控制器（无任务时为 null）。**在扫描开始前就装上** —— 扫描也能停。 */
		let jobCtrl = null;
		/** @type {any} */
		let lastPlan = null;
		/**
		 * 计划缓存：给「预览完直接执行」复用 —— 同一套参数下不必把两边的树再扫一遍。
		 * 5 分钟过期、参数（含连接与规则）一变即失效、执行完立刻作废：宁可重扫，不可传错。
		 */
		let planCache = null;
		const PLAN_REUSE_MS = 5 * 60 * 1000;

		function readSettings() {
			const raw = (typeof host.getSettings === "function" ? host.getSettings() : null) ?? {};
			const del = ["none", "remote-only", "both"].includes(String(raw.delete)) ? String(raw.delete) : DEFAULTS.delete;
			const conc = Number(raw.concurrency);
			const scan = Number(raw.scanConcurrency);
			const days = Number(raw.trashDays);
			return {
				delete: del,
				concurrency: Number.isFinite(conc) ? Math.min(16, Math.max(1, Math.round(conc))) : DEFAULTS.concurrency,
				scanConcurrency: Number.isFinite(scan) ? Math.min(32, Math.max(1, Math.round(scan))) : DEFAULTS.scanConcurrency,
				autoGitignore: raw.autoGitignore !== false,
				plaintextWarn: raw.plaintextWarn !== false,
				allowExec: raw.allowExec === true,
				// 批量打包传（上行 tar 流 / 下行 tar -czf -）靠远端 tar/mv，实际上也要 exec ——
				// 没开 exec 时这个开关等于不存在；`batchUpload` 是 #上一版的键名，读一下兼容旧存储
				batchTransfer: (raw.batchTransfer ?? raw.batchUpload) !== false,
				trashDays: Number.isFinite(days) ? Math.max(0, Math.min(90, Math.round(days))) : DEFAULTS.trashDays,
			};
		}

		/**
		 * 读配置：项目文件里的 defaults 优先于全局设置（项目约定的排除规则不该被机器级开关改掉），
		 * 只有文件里没写的字段才回落设置页。
		 */
		async function load(profile) {
			const cwd = host.cwd;
			const settings = readSettings();
			const snapshot = await readConfig(cwd);
			const raw = snapshot.raw ?? {};
			const defaults = { ...raw.defaults };
			if (defaults.delete === undefined) defaults.delete = settings.delete;
			if (defaults.concurrency === undefined) defaults.concurrency = settings.concurrency;
			const doc = normalizeDoc({ ...raw, defaults });
			const { name, conn } = pickConnection(doc, profile);
			if (conn) conn.__cwd = cwd;
			return { cwd, doc, raw, files: snapshot.files, existed: snapshot.existed, profile: name, conn, settings };
		}

		function requireConn(loaded) {
			if (!loaded.conn) {
				throw new Error(
					`本项目还没有 SFTP 连接（${path.join(".pi", "sftp.json")} 为空）—— 用 sftp_save 新建，或把现成的 vscode-sftp 配置导入`,
				);
			}
			const c = loaded.conn;
			if (!c.host) throw new Error(`连接「${c.name}」缺 host —— 用 sftp_save 补上`);
			if (!c.remotePath.startsWith("/")) throw new Error(`连接「${c.name}」的 remotePath 必须是绝对路径`);
			return c;
		}

		/** 计划指纹：连接、规则、方向、范围任一变化，缓存的计划就不能再用。 */
		function planKey(loaded, conn, { scope, target, direction, deletePolicy }) {
			return JSON.stringify([
				loaded.cwd,
				conn.name,
				conn.host,
				conn.port,
				conn.username,
				conn.remotePath,
				conn.ignore,
				conn.mappings,
				conn.sync,
				scope,
				target,
				direction ?? "",
				deletePolicy ?? "",
				loaded.settings.autoGitignore,
			]);
		}

		/**
		 * 计划：连上去扫双方 → 差异清单（不传任何文件）。
		 * `signal` 在扫描期间就生效（取消按钮不能只停传输）；`reuseToken` 命中缓存则直接重用上次预览。
		 */
		async function buildPlan({
			profile,
			scope = "all",
			target = "",
			direction,
			deletePolicy,
			signal,
			onScan,
			reuseToken,
		} = {}) {
			const loaded = await load(profile);
			const conn = requireConn(loaded);
			const cleanScope = ["all", "tree", "file"].includes(scope) ? scope : "all";
			const policy = deletePolicy ?? conn.sync.delete ?? loaded.settings.delete;
			const { sftp } = await ssh.getSftp(conn);
			const key = planKey(loaded, conn, { scope: cleanScope, target, direction, deletePolicy: policy });
			if (
				reuseToken &&
				planCache &&
				planCache.token === reuseToken &&
				planCache.key === key &&
				Date.now() - planCache.at < PLAN_REUSE_MS
			) {
				log(`重用上次预览的计划（${Math.round((Date.now() - planCache.at) / 1000)}s 前生成，不再重扫）`);
				return { loaded, conn, sftp, plan: planCache.plan, reused: true };
			}
			const plan = await planSync({
				conn,
				sftp,
				cwd: loaded.cwd,
				scope: cleanScope,
				target,
				direction,
				deletePolicy: policy,
				signal,
				onProgress: onScan,
				scanConcurrency: loaded.settings.scanConcurrency,
				// allowExec 打开时才注入远端 exec：快扫（一次 find）与批量打包都靠它
				execScan: loaded.settings.allowExec ? (cmd, opts) => ssh.exec(conn, cmd, opts) : undefined,
			});
			plan.settings = loaded.settings;
			plan.connection = publicConnection(conn);
			lastPlan = plan;
			planCache = {
				token: `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
				at: Date.now(),
				key,
				plan,
				cwd: loaded.cwd,
			};
			return { loaded, conn, sftp, plan, reused: false, planToken: planCache.token };
		}

		/**
		 * 执行：先出计划（除非命中 `reuseToken` 的缓存），再并发传输。dryRun 只回计划。
		 *
		 * 任务从**扫描前**就登记（`job.running = true` + 装上 AbortController）：
		 * 大树上扫描才是最长的一段，那段界面上看不到进度、也没法停，体验就是「卡死」。
		 */
		async function runSync({
			profile,
			scope,
			target,
			direction,
			deletePolicy,
			dryRun = false,
			reuseToken,
			signal: external,
		} = {}) {
			if (job.running) throw new Error("已有同步任务在运行 —— 请先点「停止」或等它结束");
			const ctrl = new AbortController();
			// 外部信号（工具看门狗 / 调用方）与面板的取消按钮都归到同一个控制器上
			const forward = () => ctrl.abort(external?.reason instanceof Error ? external.reason : new Error("已取消"));
			if (external) {
				if (external.aborted) forward();
				else external.addEventListener("abort", forward, { once: true });
			}
			job = {
				running: true,
				kind: dryRun ? "plan" : "sync",
				startedAt: Date.now(),
				phase: "scan",
				done: 0,
				total: 0,
				rel: "",
				bytes: 0,
				scan: { side: "local", files: 0, dirs: 0 },
				error: "",
				cancelled: false,
				reusedPlan: false,
				result: null,
			};
			jobCtrl = ctrl;
			try {
				const { loaded, conn, sftp, plan, reused, planToken } = await buildPlan({
					profile,
					scope,
					target,
					direction,
					deletePolicy,
					signal: ctrl.signal,
					reuseToken,
					onScan: (p) => {
						job.scan = { side: p.side, files: p.files, dirs: p.dirs };
					},
				});
				job.reusedPlan = Boolean(reused);
				if (dryRun) return { dryRun: true, plan, result: null, planToken, reused: Boolean(reused) };
				job.phase = "start";
				job.total = plan.summary.upload + plan.summary.download + plan.summary.trashRemote + plan.summary.trashLocal;
				job.rel = "";
				throwIfAborted(ctrl.signal);
				const result = await applyPlan({
					sftp,
					plan,
					concurrency: loaded.settings.concurrency,
					signal: ctrl.signal,
					exec: loaded.settings.allowExec ? (cmd, opts) => ssh.exec(conn, cmd, opts) : undefined,
					execStream: loaded.settings.allowExec ? (cmd, opts) => ssh.execStream(conn, cmd, opts) : undefined,
					batchTransfer: loaded.settings.batchTransfer,
					onProgress: (p) => {
						if (p.phase !== "bytes") job.phase = p.phase;
						if (typeof p.done === "number") job.done = p.done;
						if (typeof p.total === "number") job.total = p.total;
						if (p.rel) job.rel = p.rel;
						if (typeof p.bytes === "number") job.bytes = p.bytes;
					},
				});
				job.result = result;
				job.cancelled = result.cancelled;
				job.phase = result.cancelled ? "cancelled" : "done";
				// 计划已用掉：下次执行必须重新扫（否则改过的文件会拿旧计划去传）
				planCache = null;
				if (result.cancelled) {
					// 取消不是失败：已传完的文件留在两边，垃圾桶批次可回滚
					host.notify(
						"warning",
						`☁ 同步已停止（已完成 ${result.done.upload} 上传 / ${result.done.download} 下载，不丢文件）`,
						`☁ Sync stopped (${result.done.upload} up / ${result.done.download} down already done, nothing lost)`,
					);
					return { dryRun: false, plan, result, cancelled: true };
				}
				// 同步完顺手清老垃圾桶（保留天数由设置决定）
				if (loaded.settings.trashDays > 0) await pruneTrash(loaded.cwd, loaded.settings.trashDays).catch(() => {});
				if (result.failed.length) {
					host.notify(
						"warning",
						`☁ 同步完成，${result.failed.length} 个文件失败（详见面板）`,
						`☁ Sync finished with ${result.failed.length} failures (see panel)`,
					);
				} else {
					// 等级只能用 info/warning/error（协议里的 notice 等级词表）—— 没有 "success"，
					// 传它会渲染成一条没有背景/边框的裸 toast。
					host.notify(
						"info",
						`☁ 同步完成：上传 ${result.done.upload} / 下载 ${result.done.download} / 清理 ${result.done.trashRemote + result.done.trashLocal}${
							result.batched ? `（其中 ${result.batched} 个小文件走批量打包）` : ""
						}`,
						`☁ Sync done: ${result.done.upload} up / ${result.done.download} down / ${result.done.trashRemote + result.done.trashLocal} cleaned${
							result.batched ? ` (${result.batched} small files sent as one tar batch)` : ""
						}`,
					);
				}
				return { dryRun: false, plan, result, planToken, reused: Boolean(reused) };
			} catch (err) {
				// 取消（含扫描中途取消）走「已停止」而不是报错：这是用户主动按的，不是故障
				if (isAbortError(err, ctrl.signal)) {
					job.cancelled = true;
					job.phase = "cancelled";
					host.notify("warning", "☁ 已停止（已完成的文件保留）", "☁ Stopped (finished files are kept)");
					return { dryRun, plan: null, result: null, cancelled: true };
				}
				job.error = String(err?.message ?? err);
				job.phase = "error";
				// 失败也发通知（以前只有成功/部分失败发，断连一类直接抛错时界面上看不见）
				host.notify("error", `☁ 同步失败：${job.error}`, `☁ Sync failed: ${job.error}`);
				throw err;
			} finally {
				external?.removeEventListener?.("abort", forward);
				job.running = false;
				if (jobCtrl === ctrl) jobCtrl = null;
			}
		}

		/** 计划 → 给人/模型看的文本摘要。 */
		function planText(plan) {
			const s = plan.summary;
			const lines = [
				`同步计划 profile=${plan.profile} 方向=${plan.direction} 范围=${plan.scope}${plan.target ? `(${plan.target})` : ""} 删除策略=${plan.deletePolicy} 比较=${plan.compare}`,
				`待上传 ${s.upload} / 待下载 ${s.download} / 待清理（远端 ${s.trashRemote}，本地 ${s.trashLocal}）/ 一致 ${s.skip} / 冲突 ${s.conflict}，共 ${s.total} 条`,
			];
			if (plan.roots.length > 1) {
				for (const r of plan.roots) {
					lines.push(
						`  · 根 ${r.localRel || "."} → ${r.remoteRoot}（本地 ${r.scanned.local} / 远端 ${r.scanned.remote} 个文件）`,
					);
				}
			}
			const files = [];
			for (const r of plan.roots) {
				for (const e of r.entries) {
					if (e.action === "skip" && e.kind === "same") continue;
					files.push(
						`${e.action === "skip" ? "?" : e.action === "upload" ? "+" : e.action === "download" ? "↓" : e.action === "trash-remote" ? "✗" : "✗"} ${e.rel}（${e.reason}）`,
					);
				}
			}
			lines.push(...files.slice(0, PLAN_LIST_CAP));
			if (files.length > PLAN_LIST_CAP) lines.push(`… 另有 ${files.length - PLAN_LIST_CAP} 条，见面板`);
			if (!files.length) lines.push("（没有需要变更的文件）");
			for (const w of plan.warnings) lines.push(`⚠ ${w}`);
			return lines.join("\n");
		}

		// ── 状态快照（视图轮询 / 工具共用） ───────────────────────────────────
		async function publicState() {
			const loaded = await load();
			const settings = loaded.settings;
			const vscodeAvailable = await fsExists(path.join(loaded.cwd, ".vscode", "sftp.json"));
			return {
				cwd: loaded.cwd,
				configPath: path.join(".pi", "sftp.json"),
				localPath: path.join(".pi", "sftp.local.json"),
				trashPath: path.join(".pi", "sftp-trash"),
				existed: loaded.existed,
				active: loaded.doc.active,
				connection: publicConnection(loaded.conn),
				profiles: Object.values(loaded.doc.connections).map((c) => publicConnection(c)),
				settings,
				warnings: loaded.doc.warnings,
				plaintext: settings.plaintextWarn ? plaintextCredentials(loaded.doc) : [],
				dep: ssh.depState(),
				pool: ssh.poolState(),
				job: { ...job },
				lastPlan: lastPlan
					? {
							profile: lastPlan.profile,
							at: lastPlan.at ?? null,
							summary: lastPlan.summary,
							direction: lastPlan.direction,
							scope: lastPlan.scope,
							target: lastPlan.target,
						}
					: null,
				vscodeImportAvailable: Boolean(vscodeAvailable) && !loaded.existed,
			};
		}

		// ── HTTP 路由（视图走这些） ─────────────────────────────────────────
		const routes = [];
		const route = (method, p, fn) => {
			routes.push(
				host.route(method, p, async (req, res) => {
					try {
						const data = await fn(req);
						res.json({ ok: true, data: data ?? null });
					} catch (err) {
						const msg = String(err?.message ?? err);
						log(`${method} ${p} 失败：${msg}`, "warn");
						res.status(400).json({ ok: false, error: msg });
					}
				}),
			);
		};

		route("GET", "/state", () => publicState());

		route("POST", "/profile", async (req) => {
			const body = req.body ?? {};
			const name = String(body.name ?? "").trim();
			if (!name) throw new Error("缺 name（连接名）");
			const patch = body.patch ?? {};
			const out = await upsertConnection(host.cwd, name, patch, {
				target: body.target === "local" ? "local" : "base",
				makeActive: body.makeActive !== false,
			});
			ssh.dropAll();
			return { ...out, connection: publicConnection((await load(name)).conn) };
		});

		route("POST", "/active", async (req) => {
			const out = await setActive(host.cwd, String(req.body?.name ?? ""));
			ssh.dropAll();
			return out;
		});

		route("POST", "/remove", async (req) => {
			const out = await removeConnection(host.cwd, String(req.body?.name ?? ""));
			ssh.dropAll();
			return out;
		});

		route("POST", "/secret", async (req) => {
			const name = String(req.body?.name ?? "").trim();
			const value = req.body?.value;
			if (!name) throw new Error("缺 name");
			if (typeof value !== "string" || !value) throw new Error("缺 value");
			host.secrets.set(name, value);
			return { name, ref: `\${secret:${name}}` };
		});

		route("POST", "/test", async (req) => {
			const loaded = await load(req.body?.profile);
			const conn = requireConn(loaded);
			const probe = await ssh.probe(conn, {
				sftpCalls: {
					stat: (s, p) => sftpCall(s, "stat", p),
					writeFile: (s, p, b) => sftpCall(s, "writeFile", p, b),
					unlink: (s, p) => sftpCall(s, "unlink", p),
				},
			});
			return {
				profile: conn.name,
				host: conn.host,
				port: conn.port,
				username: conn.username,
				remotePath: conn.remotePath,
				...probe,
			};
		});

		route("POST", "/copy-pubkey", async (req) => {
			const loaded = await load(req.body?.profile);
			let conn = requireConn(loaded);
			if (req.body?.host) {
				conn = {
					...conn,
					host: String(req.body.host).trim(),
					port: req.body.port ? Number(req.body.port) : conn.port,
					username: req.body.username ? String(req.body.username).trim() : conn.username,
				};
			}
			const password = req.body?.password ? String(req.body.password) : undefined;
			const privateKeyPath = req.body?.privateKeyPath ? String(req.body.privateKeyPath) : undefined;
			const publicKey = req.body?.publicKey ? String(req.body.publicKey) : undefined;

			const out = await ssh.authorizePublicKey(conn, {
				password,
				privateKeyPath,
				publicKey,
				sftpCalls: {
					stat: (s, p) => sftpCall(s, "stat", p),
					writeFile: (s, p, b) => sftpCall(s, "writeFile", p, b),
					unlink: (s, p) => sftpCall(s, "unlink", p),
				},
			});
			return {
				profile: conn.name,
				host: conn.host,
				port: conn.port,
				username: conn.username,
				...out,
			};
		});

		function forceAbortJob() {
			job.phase = "cancelling";
			jobCtrl?.abort(new Error("已取消（用户中止）"));
			const timer = setTimeout(() => {
				if (job.running) ssh.dropAll();
			}, 300);
			if (typeof timer.unref === "function") timer.unref();
		}

		// 停正在跑的同步（包括还在扫的那一段）。UI 的「停止」按钮和 AI 工具的 action=cancel 走这里。
		route("POST", "/cancel", () => {
			if (!job.running) return { cancelled: false, job: { ...job } };
			forceAbortJob();
			return { cancelled: true, job: { ...job } };
		});

		route("POST", "/plan", async (req) => {
			const body = req.body ?? {};
			const out = await runSync({
				profile: body.profile,
				scope: body.scope,
				target: body.path ?? "",
				direction: body.direction,
				deletePolicy: body.deletePolicy,
				// 预览就是「只出计划」的同一个任务：扫描因此也有进度、也能停
				dryRun: true,
				reuseToken: body.reuse === true ? body.planToken : undefined,
			});
			if (out.cancelled || !out.plan) return { cancelled: true, plan: null, text: "已取消" };
			out.plan.at = Date.now();
			return { plan: serializePlan(out.plan), text: planText(out.plan), planToken: out.planToken, reused: out.reused };
		});

		route("POST", "/sync", async (req) => {
			const body = req.body ?? {};
			const out = await runSync({
				profile: body.profile,
				scope: body.scope,
				target: body.path ?? "",
				direction: body.direction,
				deletePolicy: body.deletePolicy,
				// 失败安全：**必须显式 `dryRun:false` 才真传**。一个缺 body 的 POST
				// （手敲 curl / 别处探活 / 代理重放）不应该把工作区传到生产服务器上。
				dryRun: body.dryRun !== false,
				// 客户端带着刚预览过的 token 回来 → 直接沿用那份计划，省一次全量扫描
				reuseToken: body.reuse === true ? body.planToken : undefined,
			});
			if (out.cancelled)
				return { cancelled: true, dryRun: out.dryRun, plan: null, result: null, text: "已取消（已完成的文件保留）" };
			return {
				dryRun: out.dryRun,
				plan: serializePlan(out.plan),
				result: out.result,
				text: planText(out.plan),
				planToken: out.planToken,
				reused: out.reused,
			};
		});

		/** 远端绝对路径 → 本地相对路径（取匹配得最长的同步根；mappings 可能嵌套）。 */
		function localRelFromRemote(conn, abs) {
			const hit = [...conn.roots]
				.sort((a, b) => b.remote.length - a.remote.length)
				.find((r) => abs === r.remote || abs.startsWith(`${r.remote.replace(/\/+$/, "")}/`));
			if (!hit) throw new Error(`「${abs}」不在任何同步根内（远端根 ${conn.remotePath}，无本地对应目录）`);
			const rest = abs.slice(hit.remote.replace(/\/+$/, "").length).replace(/^\/+/, "");
			return hit.local ? (rest ? `${hit.local}/${rest}` : hit.local) : rest;
		}

		// ── 手动上传 / 下载（面板按钮与右键菜单用） ─────────────────────────
		//
		// 与 /sync 的区别：这里针对**一个明确的对象**（一个文件 / 一棵子树 / 整根），
		// 用户点下去就是要传，所以不等计划、直接执行；但**永不动删除策略**
		// （deletePolicy 固定 none）—— 手动推一个目录不该把远端多出来的东西清掉。
		// `path` 给远端绝对路径时自动反查映射，所以面板上可以直接「传这个远端目录对应的本地目录」。
		route("POST", "/transfer", async (req) => {
			const body = req.body ?? {};
			const direction = body.direction === "down" ? "down" : "up";
			const raw = String(body.path ?? "").trim();
			const loaded = await load(body.profile);
			const conn = requireConn(loaded);
			let target = "";
			let scope = "all";

			if (direction === "up") {
				const rel = raw.startsWith("/") ? localRelFromRemote(conn, raw) : safeRel(raw);
				if (rel === null) throw new Error(`路径越出工作区：${raw}`);
				target = rel;
				if (rel) {
					const st = await fs.stat(path.join(loaded.cwd, rel)).catch(() => null);
					if (!st) throw new Error(`本地不存在：${rel}`);
					scope = st.isDirectory() ? "tree" : "file";
				}
			} else {
				const abs = remote.assertRemotePath(raw || conn.remotePath, "远端路径");
				target = localRelFromRemote(conn, abs);
				const { sftp } = await ssh.getSftp(conn);
				const st = await statRemote(sftp, abs);
				if (!st) throw new Error(`远端不存在：${abs}`);
				scope = st.isDir || !target ? "tree" : "file";
			}

			const out = await runSync({
				profile: body.profile,
				scope,
				target,
				direction,
				deletePolicy: "none",
				dryRun: false,
			});
			return {
				direction,
				scope,
				target,
				result: out.result,
				plan: serializePlan(out.plan),
				cancelled: Boolean(out.cancelled),
			};
		});

		route("POST", "/ignore-toggle", async (req) => {
			const rawPath = String(req.body?.path ?? "").trim();
			const mode = req.body?.mode ?? "add";
			const loaded = await load(req.body?.profile);
			const conn = requireConn(loaded);
			const pattern = rawPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
			if (!pattern) throw new Error("无法忽略根目录");

			const current = [...(conn.ignore ?? [])];
			const idx = current.indexOf(pattern);
			const exists = idx >= 0;

			let actionTaken = "";
			if (mode === "remove") {
				if (!exists) {
					return { ok: true, pattern, action: "none", message: `「${pattern}」不在 SFTP 忽略列表中`, ignores: current };
				}
				current.splice(idx, 1);
				actionTaken = "removed";
			} else if (mode === "add") {
				if (exists) {
					return { ok: true, pattern, action: "none", message: `「${pattern}」已在 SFTP 忽略列表中`, ignores: current };
				}
				current.push(pattern);
				actionTaken = "added";
			} else {
				if (exists) {
					current.splice(idx, 1);
					actionTaken = "removed";
				} else {
					current.push(pattern);
					actionTaken = "added";
				}
			}

			await upsertConnection(host.cwd, conn.name, { ignore: current }, { target: "base" });
			planCache = null;

			const msgZh =
				actionTaken === "added" ? `已将「${pattern}」加入 SFTP 忽略列表` : `已将「${pattern}」从 SFTP 忽略列表中移除`;
			const msgEn =
				actionTaken === "added"
					? `Added "${pattern}" to SFTP ignore list`
					: `Removed "${pattern}" from SFTP ignore list`;
			try {
				host.notify?.("info", `☁ ${msgZh}`, `☁ ${msgEn}`);
			} catch {}

			return { ok: true, pattern, action: actionTaken, message: msgZh, ignores: current };
		});

		route("GET", "/remote", async (req) => {
			const loaded = await load(req.query?.profile);
			const conn = requireConn(loaded);
			const { sftp } = await ssh.getSftp(conn);
			const dir = String(req.query?.path ?? conn.remotePath ?? "/");
			const entries = await remote.remoteList(sftp, dir);
			return { dir, remotePath: conn.remotePath, entries };
		});

		route("GET", "/remote-file", async (req) => {
			const loaded = await load(req.query?.profile);
			const conn = requireConn(loaded);
			const { sftp } = await ssh.getSftp(conn);
			const file = await remote.remoteRead(sftp, String(req.query?.path ?? ""), MAX_WRITE_BYTES);
			const binary = file.data.includes(0);
			return {
				path: file.path,
				size: file.size,
				binary,
				text: binary ? "" : file.data.toString("utf8"),
				hint: binary ? "二进制文件不在面板里编辑" : "",
			};
		});

		route("POST", "/remote-write", async (req) => {
			const body = req.body ?? {};
			const loaded = await load(body.profile);
			const conn = requireConn(loaded);
			const { sftp } = await ssh.getSftp(conn);
			const text = String(body.text ?? "");
			if (Buffer.byteLength(text, "utf8") > MAX_WRITE_BYTES) throw new Error("内容超过 2MB，请用同步功能或终端上传");
			return remote.remoteWrite(sftp, String(body.path ?? ""), text);
		});

		route("POST", "/remote-mkdir", async (req) => {
			const loaded = await load(req.body?.profile);
			const conn = requireConn(loaded);
			const { sftp } = await ssh.getSftp(conn);
			return remote.remoteMkdir(sftp, String(req.body?.path ?? ""));
		});

		route("POST", "/remote-mv", async (req) => {
			const loaded = await load(req.body?.profile);
			const conn = requireConn(loaded);
			const { sftp } = await ssh.getSftp(conn);
			return remote.remoteMove(sftp, String(req.body?.from ?? ""), String(req.body?.to ?? ""));
		});

		route("POST", "/remote-rm", async (req) => {
			const body = req.body ?? {};
			const loaded = await load(body.profile);
			const conn = requireConn(loaded);
			const { sftp } = await ssh.getSftp(conn);
			const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			const target = remote.assertRemotePath(String(body.path ?? ""));
			if (target === conn.remotePath.replace(/\/+$/, "")) throw new Error("拒绝删除同步根目录");
			return remote.remoteRemove(sftp, target, { trash: { root: conn.remotePath || "/", stamp } });
		});

		route("POST", "/import", async () => {
			const found = await importVscodeSftp(host.cwd);
			if (!found) throw new Error(`没找到 ${path.join(".vscode", "sftp.json")}`);
			for (const [k, v] of Object.entries(found.secrets)) host.secrets.set(k, v);
			await upsertConnection(host.cwd, found.name, found.connection, { makeActive: true });
			ssh.dropAll();
			return {
				name: found.name,
				importedSecrets: Object.keys(found.secrets),
				note:
					found.secrets && Object.keys(found.secrets).length
						? "明文口令已转入加密机密，配置文件里只留 ${secret:…} 引用"
						: "",
			};
		});

		route("POST", "/exec", async (req) => {
			if (!readSettings().allowExec)
				throw new Error("远端执行命令未开启（设置 → 插件 → SFTP 同步 → 允许在远端执行命令）");
			const loaded = await load(req.body?.profile);
			const conn = requireConn(loaded);
			const cmd = String(req.body?.cmd ?? "").trim();
			if (!cmd) throw new Error("缺 cmd");
			const out = await ssh.exec(conn, cmd, { timeoutMs: Number(req.body?.timeoutMs) || 120_000 });
			return out;
		});

		route("POST", "/prune-trash", async (req) => {
			const days = Number(req.body?.days);
			return pruneTrash(host.cwd, Number.isFinite(days) ? days : readSettings().trashDays);
		});

		// ── AI 工具：单个 action 式 `sftp` ──────────────────────────────────
		//
		// 为什么合成一个：这些动作共用同一份配置、同一条连接、同一套守卫，拆成 13 个工具只会
		// 把上下文塞满（每个都要一份 description + snippet），模型还容易漏看某几个。代价是
		// 描述要写全 —— 用一张动作表把「哪个 action 要哪些参数」一次说清（同仓库的 `pm2`、
		// `patch`、`mail` 也是 action 式单工具）。
		//
		// exec 动作受「允许在远端执行命令」设置控制：关着时它**不在 enum 里**（模型看不见的
		// 能力才是真关掉），设置一改就重注册工具。
		const SFTP_ACTIONS = [
			"status",
			"save",
			"secret",
			"test",
			"plan",
			"sync",
			"cancel",
			"ls",
			"read",
			"write",
			"mkdir",
			"mv",
			"rm",
			"search",
			"exec",
		];

		const PROFILE_PROP = {
			type: "string",
			description: "Connection profile name from .pi/sftp.json; omitted = the active profile",
		};
		const SSH_AUTH_PROPS = {
			username: { type: "string", description: "save: SSH username (default keeps the previous value)" },
			password: {
				type: ["string", "null"],
				description: "save: password or a ${env:VAR}/${secret:name} reference; null clears it",
			},
			privateKey: {
				type: ["string", "null"],
				description: "save: inline private key PEM or a reference; null clears it",
			},
			privateKeyPath: {
				type: "string",
				description: "save: private key file path, ~ expansion supported; wins over privateKey",
			},
			passphrase: {
				type: ["string", "null"],
				description: "save: private key passphrase or a reference; null clears it",
			},
			agent: { type: "string", description: "save: ssh-agent socket path, e.g. $SSH_AUTH_SOCK" },
		};

		/**
		 * 动作 → 实现。参数从同一个扁平对象里取，各动作只读自己关心的字段
		 * （合并工具的代价：`path` 在 plan/sync 下是本地相对路径，在文件动作下是远端绝对路径）。
		 */
		const sftpActions = {
			async status() {
				const st = await publicState();
				const lines = [];
				if (!st.existed) lines.push(`尚未创建 ${st.configPath}。`);
				lines.push(`当前 profile：${st.active || "(无)"}`);
				for (const p of st.profiles) {
					const cred =
						[p.auth.password, p.auth.privateKeyPath || p.auth.privateKey, p.auth.agent].filter(Boolean).join(" / ") ||
						"无";
					lines.push(
						`- ${p.name}${p.name === st.active ? "（当前）" : ""}：${p.username}@${p.host}:${p.port}，远端根 ${p.remotePath}，方向 ${p.sync.direction}，删除策略 ${p.sync.delete}，凭据 ${cred}`,
					);
				}
				lines.push(`依赖：${st.dep.status}${st.dep.error ? `（${st.dep.error}）` : ""}；活动连接 ${st.pool.length}`);
				if (st.plaintext.length) {
					lines.push(
						`⚠ 明文凭据：${st.plaintext.map((x) => `${x.connection}.${x.field}`).join(", ")} —— 建议改用 action=secret`,
					);
				}
				if (st.vscodeImportAvailable) {
					lines.push("检测到 .vscode/sftp.json 且项目还没配置，可在面板点「导入」迁移。");
				}
				if (job.running) {
					lines.push(
						job.phase === "scan"
							? `⚠ 正在扫描${job.scan.side === "remote" ? "远端" : "本地"}：${job.scan.files} 个文件 / ${job.scan.dirs} 个目录（action=cancel 可停）`
							: `⚠ 正在${job.kind === "plan" ? "扫描" : "同步"}：${job.done}/${job.total}${job.rel ? ` · ${job.rel}` : ""}（action=cancel 可停）`,
					);
				}
				return lines.join("\n");
			},

			async save(p) {
				const patch = {
					host: p.host,
					port: p.port,
					username: p.username,
					remotePath: p.remotePath,
					ignore: p.ignore,
					password: p.password,
					privateKey: p.privateKey,
					privateKeyPath: p.privateKeyPath,
					passphrase: p.passphrase,
					agent: p.agent,
				};
				if (p.direction !== undefined || p.deletePolicy !== undefined) {
					patch.sync = {};
					if (p.direction !== undefined) patch.sync.direction = p.direction;
					if (p.deletePolicy !== undefined) patch.sync.delete = p.deletePolicy;
				}
				const out = await upsertConnection(host.cwd, String(p.name), patch, {
					target: p.target === "local" ? "local" : "base",
					makeActive: p.activate !== false,
				});
				ssh.dropAll();
				const conn = (await load(String(p.name))).conn;
				return `已保存连接「${out.name}」（写入 ${out.target === "local" ? ".pi/sftp.local.json" : ".pi/sftp.json"}）：${conn.username}@${conn.host}:${conn.port}，远端根 ${conn.remotePath}。下一步用 action=test 验证连通性。`;
			},

			async secret(p) {
				const name = String(p.name ?? "").trim();
				if (!name) throw new Error("action=secret 需要 name（机密名）");
				if (typeof p.value !== "string" || !p.value) throw new Error("action=secret 需要 value（机密值）");
				host.secrets.set(name, p.value);
				return `已写入加密机密「${name}」。在连接里引用它：\${secret:${name}}（密码写 password，口令写 passphrase）。`;
			},

			async test(p) {
				const loaded = await load(p.profile);
				const conn = requireConn(loaded);
				const probe = await ssh.probe(conn, {
					sftpCalls: {
						stat: (s, x) => sftpCall(s, "stat", x),
						writeFile: (s, x, b) => sftpCall(s, "writeFile", x, b),
						unlink: (s, x) => sftpCall(s, "unlink", x),
					},
				});
				return [
					`连接成功：${conn.username}@${conn.host}:${conn.port}，远端根 ${conn.remotePath}${probe.remoteExists ? "存在" : "不存在（首次同步会自动创建）"}`,
					`写权限：${probe.writable ? "可写" : `不可写（${probe.writeError}）`}`,
					`凭据来源：${
						Object.entries(probe.authSources)
							.filter(([, v]) => v && v !== "plain")
							.map(([k, v]) => `${k}=${v}`)
							.join(" / ") || "明文"
					}`,
				].join("\n");
			},

			async cancel() {
				if (!job.running) return "当前没有正在跑的同步任务（没有需要停止的东西）。";
				const what = job.kind === "plan" ? "扫描" : "同步";
				forceAbortJob();
				return `已请求停止${what} —— 正在收尾：在传的文件会中断并清掉半成品，已传完的文件保留，垃圾桶批次可回滚。`;
			},

			async plan(p, ctx) {
				const out = await runSync({
					profile: p.profile,
					scope: p.scope,
					target: p.path ?? "",
					direction: p.direction,
					deletePolicy: p.deletePolicy,
					dryRun: true,
					signal: ctx?.signal,
				});
				if (out.cancelled) return "已取消（扫描中途停止）。";
				out.plan.at = Date.now();
				return planText(out.plan);
			},

			async sync(p, ctx) {
				const out = await runSync({
					profile: p.profile,
					scope: p.scope,
					target: p.path ?? "",
					direction: p.direction,
					deletePolicy: p.deletePolicy,
					dryRun: p.dryRun !== false,
					signal: ctx?.signal,
				});
				if (out.cancelled) return "已停止（扫描或传输中途取消；已传完的文件保留，垃圾桶里的可回滚）。";
				if (out.dryRun) return `（dry-run，未传输任何文件；确认后传 dryRun=false）\n${planText(out.plan)}`;
				const r = out.result;
				const failed = r.failed.slice(0, 20).map((f) => `  ✗ ${f.rel}：${f.error}`);
				return [
					`同步完成（profile=${out.plan.profile}，方向=${out.plan.direction}）：上传 ${r.done.upload}，下载 ${r.done.download}，清理远端 ${r.done.trashRemote} / 本地 ${r.done.trashLocal}，跳过 ${r.done.skip}，传输 ${(r.bytes / 1024).toFixed(1)} KB`,
					`垃圾桶批次：.pi/sftp-trash/${r.batch}（远端为 <remotePath>/.sftp-trash/${r.batch}）`,
					r.failed.length ? `失败 ${r.failed.length} 个：\n${failed.join("\n")}` : "全部成功",
				].join("\n");
			},

			async ls(p) {
				const loaded = await load(p.profile);
				const conn = requireConn(loaded);
				const { sftp } = await ssh.getSftp(conn);
				const dir = String(p.path ?? conn.remotePath ?? "/");
				const entries = await remote.remoteList(sftp, dir);
				if (!entries.length) return `${dir} 是空目录。`;
				return `${dir}（${entries.length} 项）\n${entries
					.map((e) => `${e.type === "dir" ? "d" : "-"} ${e.size.toString().padStart(9)} ${e.name}`)
					.join("\n")}`;
			},

			async read(p) {
				const loaded = await load(p.profile);
				const conn = requireConn(loaded);
				const { sftp } = await ssh.getSftp(conn);
				const file = await remote.remoteRead(sftp, String(p.path ?? ""), MAX_WRITE_BYTES);
				if (file.data.includes(0)) return `${file.path}（${file.size} 字节）看起来是二进制，不在对话里展开。`;
				return `${file.path}（${file.size} 字节）\n\`\`\`\n${file.data.toString("utf8")}\n\`\`\``;
			},

			async write(p) {
				const loaded = await load(p.profile);
				const conn = requireConn(loaded);
				const { sftp } = await ssh.getSftp(conn);
				const text = String(p.text ?? "");
				if (Buffer.byteLength(text, "utf8") > MAX_WRITE_BYTES) throw new Error("内容超过 2MB —— 请改用 action=sync");
				const out = await remote.remoteWrite(sftp, String(p.path ?? ""), text);
				return `已写入 ${out.path}（${out.bytes} 字节，父目录按需创建）。`;
			},

			async mkdir(p) {
				const loaded = await load(p.profile);
				const conn = requireConn(loaded);
				const { sftp } = await ssh.getSftp(conn);
				const out = await remote.remoteMkdir(sftp, String(p.path ?? ""));
				return `目录已就绪：${out.path}`;
			},

			async mv(p) {
				const loaded = await load(p.profile);
				const conn = requireConn(loaded);
				const { sftp } = await ssh.getSftp(conn);
				const out = await remote.remoteMove(sftp, String(p.from ?? ""), String(p.to ?? ""));
				return `已移动：${out.from} → ${out.to}`;
			},

			async rm(p) {
				const loaded = await load(p.profile);
				const conn = requireConn(loaded);
				const { sftp } = await ssh.getSftp(conn);
				const target = remote.assertRemotePath(String(p.path ?? ""));
				if (target === conn.remotePath.replace(/\/+$/, "")) throw new Error("拒绝删除同步根目录");
				const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
				const out = await remote.remoteRemove(sftp, target, { trash: { root: conn.remotePath || "/", stamp } });
				return `已移除 ${target}（${out.removed} 项），可在 ${conn.remotePath}/.sftp-trash/${stamp}/ 找回。`;
			},

			async search(p) {
				const loaded = await load(p.profile);
				const conn = requireConn(loaded);
				const { sftp } = await ssh.getSftp(conn);
				const root = String(p.path ?? conn.remotePath ?? "/");
				const needle = String(p.query ?? "").toLowerCase();
				if (!needle) throw new Error("action=search 需要 query");
				const cap = Math.min(500, Math.max(1, Number(p.maxResults) || 60));
				const depthCap = Math.min(16, Math.max(1, Number(p.maxDepth) || 6));
				const hits = [];
				async function walk(dir, depth) {
					if (depth > depthCap || hits.length >= cap) return;
					const list = await sftpCall(sftp, "readdir", dir).catch(() => []);
					for (const f of list ?? []) {
						if (hits.length >= cap) return;
						if (!f?.filename || f.filename === "." || f.filename === "..") continue;
						const full = `${dir.replace(/\/+$/, "")}/${f.filename}`;
						if (f.filename.toLowerCase().includes(needle)) hits.push(full);
						if (typeof f.attrs?.isDirectory === "function" && f.attrs.isDirectory()) await walk(full, depth + 1);
					}
				}
				await walk(root, 1);
				if (!hits.length) return `在 ${root} 下（深度 ${depthCap}）没找到含「${p.query}」的条目。`;
				return `找到 ${hits.length} 项${hits.length >= cap ? "（已达上限）" : ""}：\n${hits.join("\n")}`;
			},

			async exec(p) {
				const loaded = await load(p.profile);
				const conn = requireConn(loaded);
				const out = await ssh.exec(conn, String(p.cmd ?? ""), { timeoutMs: Number(p.timeoutMs) || 120_000 });
				return `退出码 ${out.code ?? "?"}${out.truncated ? "（输出被截断）" : ""}\n--- stdout ---\n${out.stdout || "(空)"}\n--- stderr ---\n${out.stderr || "(空)"}`;
			},
		};

		/** 组装工具定义；allowExec 决定 enum 里有没有 exec。 */
		function buildSftpTool(allowExec) {
			const actions = allowExec ? SFTP_ACTIONS : SFTP_ACTIONS.filter((a) => a !== "exec");
			return {
				name: "sftp",
				label: "SFTP 同步 / 远端文件",
				description:
					"Project-scoped SFTP over one SSH connection: inspect or edit the connection profile, verify it, diff local against remote, transfer files and manage the remote tree. " +
					"action=status lists profiles with credentials redacted; save creates or updates a profile (omitted fields keep their old value, null clears a credential, target=local writes the machine override); " +
					"secret stores a password, passphrase or key in the encrypted store and returns a ${secret:name} reference; test connects and probes the remote root; " +
					"plan reports the diff without transferring anything; sync transfers (dryRun defaults to true, pass dryRun=false to move bytes); " +
					"cancel stops the sync that is running (or its scan phase) after the current files; " +
					"ls, read, write, mkdir, mv, rm and search work on remote files; exec runs a remote shell command. " +
					// 开了 exec 才有这两条快通道（扫描一次 find、小文件一批 tar）
					"With exec access enabled, planning uses one remote find and many small files upload as one tar batch. " +
					"path means a local relative path for plan and sync, and a remote absolute path for the file actions; direction=up|down|both and scope=all|tree|file shape a transfer; " +
					"deletePolicy=none|remote-only|both decides what may be cleaned up, and removals always land in a trash folder first.",
				promptSnippet: "Moving code to or from the deployment server",
				promptGuidelines: [
					"Diff before you deploy: run action=plan, show the user the result, then repeat it as action=sync with dryRun=false",
					"Never write a raw password into a profile — store it with action=secret and pass the returned ${secret:name} reference to action=save",
					"Prefer one action=sync over looping action=write whenever more than a couple of files change",
					"Ask the user before action=rm or action=exec — both touch the live server and neither has an undo",
				],
				parameters: {
					type: "object",
					properties: {
						action: {
							type: "string",
							enum: actions,
							description: "Which SFTP action to perform.",
						},
						profile: PROFILE_PROP,
						// save：连接名；secret：机密名
						name: {
							type: "string",
							description: "save: profile name (letters, digits, dot, dash, underscore); secret: secret name",
						},
						value: { type: "string", description: "secret: the secret value itself (never echoed back)" },
						host: { type: "string", description: "save: hostname or IP of the SSH server" },
						port: { type: "number", description: "save: SSH port (default 22)" },
						remotePath: { type: "string", description: "save: remote root directory, absolute, e.g. /srv/app" },
						...SSH_AUTH_PROPS,
						ignore: {
							type: "array",
							items: { type: "string" },
							description: "save: extra exclude globs for this profile",
						},
						target: {
							type: "string",
							enum: ["base", "local"],
							description: "save: which config file to write (default base)",
						},
						activate: { type: "boolean", description: "save: make this the active profile (default true)" },
						direction: {
							type: "string",
							enum: ["up", "down", "both"],
							description: "plan/sync/save: up = upload, down = download, both = two-way",
						},
						scope: {
							type: "string",
							enum: ["all", "tree", "file"],
							description: "plan/sync: all = every sync root (default), tree = a subtree, file = a single file",
						},
						path: {
							type: "string",
							description: "plan/sync: local relative path; ls/read/write/mkdir/rm/search: remote absolute path",
						},
						deletePolicy: {
							type: "string",
							enum: ["none", "remote-only", "both"],
							description: "plan/sync/save: what may be cleaned up (removals go to a trash folder)",
						},
						dryRun: {
							type: "boolean",
							description: "sync: true (default) only reports the plan; false transfers",
						},
						from: { type: "string", description: "mv: source remote absolute path" },
						to: { type: "string", description: "mv: destination remote absolute path" },
						text: { type: "string", description: "write: full file content (UTF-8)" },
						query: { type: "string", description: "search: case-insensitive substring matched against file names" },
						maxResults: { type: "number", description: "search: result cap (default 60)" },
						maxDepth: { type: "number", description: "search: directory depth cap (default 6)" },
						cmd: { type: "string", description: "exec: shell command line, run by the remote login shell" },
						timeoutMs: { type: "number", description: "exec: timeout in ms (default 120000)" },
					},
					required: ["action"],
				},
				execute: async (_toolCallId, params, signal) => {
					const p = params && typeof params === "object" ? params : {};
					const action = String(p.action ?? "").trim();
					const fn = sftpActions[action];
					if (!fn) throw new Error(`action「${action}」不认识 —— 可用：${SFTP_ACTIONS.join(" / ")}`);
					if (action === "exec" && !readSettings().allowExec) {
						throw new Error("远端命令执行未开启：请在「设置 → 插件 → SFTP 同步」打开「允许在远端执行命令」");
					}
					return fn(p, { signal });
				},
			};
		}

		/** 当前注册（设置变化时先注销再注册，否则同名的第二次注册会被宿主拒掉）。 */
		let sftpToolOff = null;
		function syncSftpTool(allowExec) {
			const on = typeof allowExec === "boolean" ? allowExec : readSettings().allowExec;
			try {
				sftpToolOff?.();
			} catch {
				/* ignore */
			}
			sftpToolOff = host.registerAgentTool(buildSftpTool(on));
		}
		syncSftpTool();

		// ── UI：顶栏「SFTP 同步」按钮上的实时状态 ───────────────────────────
		//
		// 插件在界面上只占一个入口（顶栏那个打开面板的按钮，见 manifest.ui.topbar）。
		// 同步状态不再另占底栏一格，而是写到那个按钮自己身上：进行中把进度拼进文案
		// （`SFTP 3/10`），悬停另有详细提示；完成/失败另发通知（见 runSync）。
		// 只在文本真的变了的时候 update —— 每次 update 都会重推一遍插件清单。
		const BASE_LABEL = { zh: "SFTP 同步", en: "SFTP Sync" };
		let painted = "";
		function paintBadge() {
			try {
				const st = job;
				// 扫描阶段没有 done/total（那要等计划出来）—— 数字换成已扫到的文件数，
				// 否则大树上会长时间显示冷冰冰的 `SFTP 0/0`，看着就像卡死了。
				const scanning = st.running && (st.phase === "scan" || st.phase === "cancelling");
				const label = st.running
					? scanning
						? `SFTP 扫描 ${st.scan.files}`
						: `SFTP ${st.done}/${st.total}`
					: BASE_LABEL.zh;
				const labelEn = st.running
					? scanning
						? `SFTP scan ${st.scan.files}`
						: `SFTP ${st.done}/${st.total}`
					: BASE_LABEL.en;
				// 路径截断：hint 在服务端限 200 字符，超了会落一条运行时诊断
				const rel = st.rel ? ` · ${String(st.rel).slice(0, 80)}` : "";
				const sideZh = st.scan.side === "remote" ? "远端" : "本地";
				const hint = st.running
					? scanning
						? `正在扫描${sideZh}：已找到 ${st.scan.files} 个文件 / ${st.scan.dirs} 个目录（点击打开面板可停止）`
						: `正在同步 ${st.done}/${st.total}${rel}（点击打开面板可停止）`
					: st.cancelled
						? "上次同步已停止（点击打开面板）"
						: st.error
							? `上次同步失败：${String(st.error).slice(0, 120)}（点击打开面板）`
							: lastPlan
								? `最近计划：待传 ${lastPlan.summary.upload + lastPlan.summary.download}（点击打开面板）`
								: "打开 SFTP 同步面板（尚未配置连接）";
				const hintEn = st.running
					? scanning
						? `Scanning ${st.scan.side}: ${st.scan.files} files / ${st.scan.dirs} dirs so far (click to open the panel and stop)`
						: `Syncing ${st.done}/${st.total}${rel} (click to open the panel to stop)`
					: st.cancelled
						? "Last sync was stopped (click to open the panel)"
						: st.error
							? `Last sync failed: ${String(st.error).slice(0, 120)} (click to open the panel)`
							: lastPlan
								? `Last plan: ${lastPlan.summary.upload + lastPlan.summary.download} pending (click to open the panel)`
								: "Open the SFTP sync panel (no connection configured yet)";
				const sig = `${label}|${hint}`;
				if (sig === painted) return;
				painted = sig;
				host.ui.update("__view", { label, labelEn, hint, hintEn });
			} catch {
				/* 按钮上的状态只是装饰，失败不影响功能 */
			}
		}
		paintBadge();
		const badgeTimer = setInterval(paintBadge, 1500);
		if (typeof badgeTimer.unref === "function") badgeTimer.unref();

		const offCwd = host.onCwdChange?.((next) => {
			log(`工作区切到 ${next}，断开旧连接`);
			ssh.dropAll();
			lastPlan = null;
			planCache = null;
			job = {
				running: false,
				kind: "",
				startedAt: 0,
				phase: "",
				done: 0,
				total: 0,
				rel: "",
				bytes: 0,
				scan: { side: "", files: 0, dirs: 0 },
				error: "",
				cancelled: false,
				reusedPlan: false,
				result: null,
			};
			paintBadge();
		});

		// 设置变化：exec 动作的可见性跟着走（关掉时它从 enum 里消失，模型看不到这个能力）
		const offSettings = host.onSettingsChanged?.((values) => syncSftpTool(values?.allowExec === true));

		// 首次跑一遍：清理过期垃圾桶 + 自动补 .gitignore
		try {
			const st = readSettings();
			if (st.autoGitignore) {
				const r = await ensureGitignore(host.cwd);
				if (r.changed) log(`已把 ${path.join(".pi", "sftp.local.json")} 加进 .gitignore`);
			}
			if (st.trashDays > 0) await pruneTrash(host.cwd, st.trashDays).catch(() => {});
		} catch (err) {
			log(`初始化失败：${String(err?.message ?? err)}`, "warn");
		}
		log(`sftp 已激活（工具 sftp：${SFTP_ACTIONS.length} 个动作，exec ${readSettings().allowExec ? "开" : "关"}）`);

		return () => {
			clearInterval(badgeTimer);
			try {
				sftpToolOff?.();
			} catch {
				/* ignore */
			}
			for (const off of routes) {
				try {
					off();
				} catch {
					/* ignore */
				}
			}
			offCwd?.();
			offSettings?.();
			ssh.dropAll();
		};
	},
};

/** 计划 → 可下发前端的形状（去掉内部字段）。取消导致没有计划时返回 null（前端会显示「没计划」而不是崩）。 */
function serializePlan(plan) {
	if (!plan) return null;
	return {
		profile: plan.profile,
		direction: plan.direction,
		deletePolicy: plan.deletePolicy,
		compare: plan.compare,
		scope: plan.scope,
		target: plan.target,
		summary: plan.summary,
		warnings: plan.warnings,
		at: plan.at ?? null,
		roots: plan.roots.map((r) => ({
			index: r.index,
			localRel: r.localRel,
			remoteRoot: r.remoteRoot,
			remoteAbs: r.remoteAbs,
			base: r.base,
			remoteExists: r.remoteExists,
			scanned: r.scanned,
			entries: r.entries.map((e) => ({
				rel: e.rel,
				kind: e.kind,
				action: e.action,
				reason: e.reason,
				localSize: e.localSize,
				remoteSize: e.remoteSize,
				localMtime: e.localMtime,
				remoteMtime: e.remoteMtime,
			})),
		})),
	};
}

async function fsExists(p) {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}
