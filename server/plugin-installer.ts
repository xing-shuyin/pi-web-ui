/**
 * plugin-installer — 插件的后台安装作业（安装 / 更新 / 卸载）。
 *
 * 设置面板里的插件操作原本开一个**可见终端 tab** 跑 CLI：过程看得见，但每次操作
 * 都切主视图 + 关掉设置弹窗 —— 连装几个插件就是「装一个、重开设置、再导航回市场」
 * （issue #152）。这里把同一件事搬到服务端后台：
 *
 *   - 真正执行者仍是 CLI（`pi-web-ui install|uninstall`，bin/pi-web-ui.mjs）——
 *     单一实现，界面与终端行为永不漂移（`--build` 之类新选项自动同步）；
 *   - 输出按行回传（`plugin_job` 的 log 段），结束时回 `done`（成功与否 + 输出尾部），
 *     前端就地显示，弹窗不关；
 *   - 完成后由调用方（index.ts）重扫插件 + 重推市场列表；
 *   - **同一时刻只跑一个作业**：安装要动 `<dataDir>/plugins/<id>`，两个作业写同一
 *     目录必出半装状态，所以第二个请求直接被拒（提示等它结束）；
 *   - 看门狗：超时杀掉整棵进程树，绝不留一个卡死的 install 占着锁。
 *
 * 它不决定「谁能装」：managed 实例与 tabs 闸门在 index.ts 的 dispatch 上做（见
 * managed.ts 的「服务端拒绝，客户端只是隐藏」）；这里只兜一层，防止别的调用路径绕过。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pick, type ServerLang } from "./i18n.js";
import { isValidSource } from "./plugin-catalog.js";
import {
	inspectLocalInstallSpec,
	manifestCandidateUrls,
	readLocalManifest,
	suggestPluginId,
	type InstallInspect,
} from "./plugin-install-spec.js";
import { killPidTree } from "./process-utils.js";
import type { ServerMessage } from "./protocol.js";

/** 插件 id 字符集（与 server/plugins.ts、plugin-catalog.ts 一致，防路径穿越）。 */
const ID_RE = /^[A-Za-z0-9_-]+$/;

/** 单个作业的墙钟上限（clone + 依赖安装 + 编译都可能很慢，给足 15 分钟）。 */
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
/** 回传给前端的输出尾部上限（失败时展开排障用，别把整个 build 日志塞进消息）。 */
const MAX_OUTPUT_CHARS = 8000;
/** 单行上限：某些工具会吐超长单行（进度条），截断后再回传。 */
const MAX_LINE_CHARS = 2000;

export interface PluginJobSpec {
	/** 客户端生成的作业 id（每次进度消息原样带回）。 */
	jobId: string;
	action: "install" | "update" | "uninstall";
	/** 插件 id：install/update 的落盘目录名，uninstall 的目标。 */
	id: string;
	/** install/update：远程安装源 owner/repo[/subdir][#ref]。 */
	source?: string;
	/** install/update：先做隔离构建（等价 CLI `--build`）。 */
	build?: boolean;
	/** install/update：即使只有源码也不构建（等价 CLI `--no-build`，与 build 互斥）。 */
	noBuild?: boolean;
}

/** 纯函数：把作业规格翻成 CLI argv（含安全校验），便于单测。
 *  返回 `{ args }` 或 `{ error }`（文案按 lang 本地化）。 */
export function buildPluginJobArgs(
	spec: PluginJobSpec,
	dataDir: string,
	lang?: () => ServerLang,
): { args: string[] } | { error: string } {
	const l = lang?.() ?? "en";
	const id = String(spec?.id ?? "").trim();
	if (!ID_RE.test(id))
		return {
			error: pick(
				l,
				`非法插件 id "${id}"（仅限字母数字-_）`,
				`Invalid plugin id "${id}" (letters/digits/-/_ only)`,
				"plugininstaller.id.invalid",
				{ id },
			),
		};
	if (spec.action === "uninstall") return { args: ["uninstall", id, "--data-dir", dataDir] };
	const source = String(spec?.source ?? "").trim();
	if (!isValidSource(source))
		return {
			error: pick(
				l,
				"安装源需为 owner/repo 或 owner/repo/子目录（本地路径请用命令行安装）",
				"Install source must be owner/repo or owner/repo/subdir (local paths are CLI-only)",
				"plugininstaller.source.invalid",
			),
		};
	const args = ["install", source, "--name", id, "--data-dir", dataDir];
	if (spec.action === "update") args.push("--force");
	if (spec.build && spec.noBuild)
		return {
			error: pick(
				l,
				"--build 与 --no-build 不能同时用",
				"--build and --no-build are mutually exclusive",
				"plugininstaller.build.conflict",
			),
		};
	if (spec.build) args.push("--build");
	else if (spec.noBuild) args.push("--no-build");
	return { args };
}

/** 安装前的 spec 检查（DSH P0-3 引导式安装）。
 *
 * 三层：① 形状分类（parseInstallSpec）+ 本地已装判定（inspectLocalInstallSpec）；
 * ② 本地路径源：直接读它的 manifest.json；
 * ③ 远端 GitHub 源：一次 raw.githubusercontent 探测（超时 6s，失败不阻断）——
 *    拿到 manifest 就归到 not-found / not-a-package / not-a-bundle 之一，
 *    拿不到（网络/代理问题）回 network 但**不阻塞安装**（problem 只作提示）。
 *
 * 通一不联网：测试时传 fetchImpl 替身；生产走全局 fetch。
 */
export async function inspectInstallSpec(
	rawSpec: string,
	deps: {
		pluginsDir: string;
		explicitId?: string;
		force?: boolean;
		timeoutMs?: number;
		fetchImpl?: typeof fetch;
	},
): Promise<InstallInspect> {
	const local = inspectLocalInstallSpec(rawSpec, deps);
	// 形状就不对 / 本地路径不存在 / 已装（且没 force）：本地已经能给出结论，不再联网。
	if (local.problem || local.spec.kind === "npm" || local.spec.kind === "url") {
		// npm/url 不在本检查的覆盖范围（CLI/注册表自己会报）——原样返回，让 CLI 说话。
		return local;
	}
	if (local.spec.kind === "path") {
		const manifest = readLocalManifest(local.spec.normalized);
		if (!manifest)
			return {
				...local,
				problem: "not-a-package",
				detail: `No manifest.json found in ${local.spec.normalized} — this is not a pi-web-ui plugin.`,
			};
		return { ...local, manifest, suggestedId: suggestPluginId(local.spec, deps.explicitId ?? manifest.id) };
	}
	// github 简写：远端探测 best-effort（失败只补一条提示，不挡安装）。
	for (const url of manifestCandidateUrls(local.spec)) {
		try {
			const res = await (deps.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(deps.timeoutMs ?? 6000) });
			if (res.status === 404) continue;
			if (!res.ok) return { ...local, problem: "network", detail: `Remote probe failed: HTTP ${res.status}` };
			const manifest = pickManifest(local, await res.json());
			if (!manifest)
				return {
					...local,
					problem: "not-a-bundle",
					detail: "The remote manifest.json is not a valid plugin manifest (missing id/name).",
				};
			return { ...local, manifest, suggestedId: suggestPluginId(local.spec, deps.explicitId ?? manifest.id) };
		} catch {
			return { ...local, problem: "network", detail: "Could not reach the remote repository to verify the plugin." };
		}
	}
	// 连 manifest 都没探到 —— 仓库/子目录/分支不存在，或根本不是插件包。
	return {
		...local,
		problem: "not-found",
		detail: `No manifest.json at the remote source — check the repo/subdirectory and the #ref.`,
	};
}

function pickManifest(local: InstallInspect, raw: unknown): NonNullable<InstallInspect["manifest"]> | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.id !== "string" && typeof o.name !== "string") return null;
	void local;
	return {
		...(typeof o.id === "string" ? { id: o.id } : {}),
		...(typeof o.name === "string" ? { name: o.name } : {}),
		...(typeof o.version === "string" ? { version: o.version } : {}),
		...(typeof o.description === "string" ? { description: o.description } : {}),
		...(Array.isArray(o.permissions)
			? { permissions: o.permissions.filter((x): x is string => typeof x === "string").slice(0, 32) }
			: {}),
	};
}

export interface PluginJobHooks {
	/** 推一条进度给**发起者**（index.ts 包装成只发该 socket）。 */
	emit(msg: ServerMessage): void;
	/** 作业结束（成功或失败）后调用：重扫插件 + 重推列表等。 */
	done(ok: boolean, info: { error?: string; output: string }): void | Promise<void>;
	/** 面向用户的文案语言。 */
	lang?: () => ServerLang;
}

export interface PluginInstallerDeps {
	/** 数据目录（插件落盘在 <dataDir>/plugins/<id>）。 */
	dataDir: string;
	/** 包根目录（CLI 位于 <pkgRoot>/bin/pi-web-ui.mjs）。 */
	pkgRoot: string;
	/** PI_WEB_MANAGED：托管实例拒绝一切安装/卸载。 */
	managed: boolean;
	/** 看门狗超时（测试可调小）。 */
	timeoutMs?: number;
}

export class PluginInstaller {
	private child: ChildProcess | null = null;
	private currentJobId: string | null = null;

	constructor(private readonly deps: PluginInstallerDeps) {}

	/** 正在跑的作业 id（null = 空闲）。 */
	get busyJobId(): string | null {
		return this.currentJobId;
	}

	/** 启动一个作业；返回 `{ ok: true }` 或 `{ error }`（拒绝原因，已本地化）。 */
	start(spec: PluginJobSpec, hooks: PluginJobHooks): { ok: boolean; error?: string } {
		const l = hooks.lang?.() ?? "en";
		if (this.deps.managed)
			return {
				ok: false,
				error: pick(
					l,
					"本实例由部署方托管（PI_WEB_MANAGED=1）：插件安装/更新由部署流程负责，界面不提供入口。",
					"This instance is managed (PI_WEB_MANAGED=1): plugin installs are handled by whoever deploys it.",
					"plugininstaller.managed",
				),
			};
		const built = buildPluginJobArgs(spec, this.deps.dataDir, hooks.lang);
		if ("error" in built) return { ok: false, error: built.error };
		if (this.child)
			return {
				ok: false,
				error: pick(
					l,
					"已有一个插件作业在运行，等它结束（或取消）后再试。",
					"Another plugin job is already running — wait for it (or cancel it) and try again.",
					"plugininstaller.busy",
				),
			};
		const binPath = join(this.deps.pkgRoot, "bin", "pi-web-ui.mjs");
		if (!existsSync(binPath))
			return {
				ok: false,
				error: pick(
					l,
					`找不到 pi-web-ui 命令行入口（${binPath}），无法执行插件操作。`,
					`pi-web-ui CLI not found at ${binPath} — cannot run the plugin operation.`,
					"plugininstaller.cli.missing",
					{ path: binPath },
				),
			};

		const { jobId, action, id: pluginId } = spec;
		const emit = (msg: ServerMessage) => {
			try {
				hooks.emit(msg);
			} catch {
				/* socket 已死：作业继续跑，只是没人看进度 */
			}
		};
		const child = spawn(process.execPath, [binPath, ...built.args], {
			windowsHide: true,
			// POSIX 下自成进程组：取消/看门狗要杀的是整棵树，killPidTree 用 -pid
			// 干活需要这一点（与 plugin-project.ts 同一写法）。缺了它，Linux/macOS
			// 上 kill(-pid) 指向不存在的组而静默失败，作业杀不掉、锁一直占着
			// （CI 的 busy 单测在 Linux 上 5 秒超时，Windows 走 taskkill 不受影响）。
			detached: process.platform !== "win32",
			env: {
				...process.env,
				...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
				PI_WEB_DATA_DIR: this.deps.dataDir,
				NO_COLOR: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.child = child;
		this.currentJobId = jobId;

		let tail = "";
		let pending = "";
		let finished = false;
		let cancelled = false;
		let timedOut = false;

		const pushLine = (raw: string) => {
			const line = raw.replace(/\r$/, "");
			if (!line.trim()) return;
			tail = (tail + line + "\n").slice(-MAX_OUTPUT_CHARS);
			emit({ type: "plugin_job", jobId, action, pluginId, phase: "log", line: line.slice(0, MAX_LINE_CHARS) });
		};
		const onChunk = (chunk: Buffer | string) => {
			pending += chunk.toString();
			let idx: number;
			while ((idx = pending.indexOf("\n")) >= 0) {
				pushLine(pending.slice(0, idx));
				pending = pending.slice(idx + 1);
			}
			while (pending.length > MAX_LINE_CHARS) {
				pushLine(pending.slice(0, MAX_LINE_CHARS));
				pending = pending.slice(MAX_LINE_CHARS);
			}
		};

		const timer = setTimeout(
			() => {
				timedOut = true;
				this.killTree(child);
			},
			Math.max(1000, Number(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
		);

		const finish = (ok: boolean, error?: string) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			if (pending.trim()) pushLine(pending);
			pending = "";
			this.child = null;
			this.currentJobId = null;
			const out = tail;
			emit({
				type: "plugin_job",
				jobId,
				action,
				pluginId,
				phase: "done",
				ok,
				...(error ? { error } : {}),
				output: out,
			});
			void Promise.resolve(hooks.done(ok, { error, output: out })).catch(() => {
				/* 后处理（重扫/重推）失败不该影响已经结束的作业本身 */
			});
		};

		child.stdout?.on("data", onChunk);
		child.stderr?.on("data", onChunk);
		child.on("error", (err) => finish(false, err.message));
		child.on("close", (code) => {
			if (cancelled) return finish(false, pick(l, "作业已取消", "Job cancelled", "plugininstaller.cancelled"));
			if (timedOut)
				return finish(
					false,
					pick(
						l,
						`作业超时（${Math.round(Math.max(1000, Number(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)) / 60000)} 分钟）已终止`,
						`Job timed out after ${Math.round(Math.max(1000, Number(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)) / 60000)} min and was killed`,
						"plugininstaller.timeout",
					),
				);
			finish(code === 0, code === 0 ? undefined : `exit code ${code}`);
		});

		emit({ type: "plugin_job", jobId, action, pluginId, phase: "start" });
		// cancel 需要拿到 cancelled 标志：挂在实例上由 cancel() 设置。
		this.cancelFlags.set(jobId, () => {
			cancelled = true;
		});
		return { ok: true };
	}

	/** cancel 时置位的标志（jobId → setter），作业结束后清理。 */
	private cancelFlags = new Map<string, () => void>();

	/**
	 * 同步跑一个作业并等它结束（目录同步的自动安装用，见 plugin-catalog-sync.ts）。
	 *
	 * 与 start() 同一条路径、同一把锁：只是把「结束后 resolve」包成 Promise。若已有
	 * 别的作业在跑，会直接返回拒绝原因（不排队）——安装器不是队列，调用方自己决定重试。
	 */
	run(
		spec: PluginJobSpec,
		opts?: { onLine?: (line: string) => void; lang?: () => ServerLang },
	): Promise<{ ok: boolean; error?: string; output: string }> {
		return new Promise((resolve) => {
			const started = this.start(spec, {
				lang: opts?.lang,
				emit: (msg) => {
					if (msg.type === "plugin_job" && msg.phase === "log" && msg.line) opts?.onLine?.(msg.line);
				},
				done: (ok, info) => resolve({ ok, ...(info.error ? { error: info.error } : {}), output: info.output }),
			});
			if (!started.ok) resolve({ ok: false, error: started.error, output: "" });
		});
	}

	/** 取消指定作业（杀掉整棵进程树）。返回是否命中。 */
	cancel(jobId: string): boolean {
		if (!this.currentJobId || this.currentJobId !== jobId || !this.child) return false;
		this.cancelFlags.get(jobId)?.();
		this.killTree(this.child);
		return true;
	}

	/** 杀进程树：Windows 走 taskkill /T，POSIX 走进程组（见 process-utils）。 */
	private killTree(child: ChildProcess): void {
		const pid = child.pid;
		if (!pid) return;
		try {
			killPidTree(pid);
		} catch {
			try {
				child.kill("SIGKILL");
			} catch {
				/* 已经退出了 */
			}
		}
	}

	/** 关机：杀掉在跑的作业（不留孤儿 install 进程）。 */
	dispose(): void {
		const child = this.child;
		if (child) {
			this.cancelFlags.forEach((f) => f());
			this.killTree(child);
		}
		this.child = null;
		this.currentJobId = null;
	}
}

/** 插件安装确认门参数依赖（便于单测与解耦）。 */
export interface PluginInstallConfirmationDeps {
	permGrants?: {
		has: (pluginId: string, family: "net", scope?: { host?: string }) => boolean;
		grant: (pluginId: string, family: "net", opts?: { hosts?: string[]; reason?: string; remember?: boolean }) => void;
	};
	permissionRequester?: (
		pluginId: string,
		req: { family: "net"; hosts?: string[]; reason?: string },
	) => Promise<{ ok: boolean; remember?: boolean }>;
	onGrantsChanged?: () => void;
}

/**
 * 插件安装的用户确认门（P0）：plugin_catalog_sync 的 install:true 与 plugin_job
 * 的 install/update 在真正动安装器之前必须拿到用户确认。
 *
 * 用户若选择「记住并允许」，授权存入 plugin-permissions.json（后续同类操作自动放行，
 * 设置面板「能力授权」页可审计与撤销）。拒绝 / 超时 / 未接弹窗设施（无头 DSH）一律 fail-closed。
 */
export async function confirmPluginInstall(
	items: Array<{ id: string; source: string }>,
	deps: PluginInstallConfirmationDeps,
): Promise<boolean> {
	if (deps.permGrants?.has("plugin-installer", "net", { host: "github.com" })) {
		return true;
	}
	const ask = deps.permissionRequester;
	if (!ask) return false;
	const list = items.map((x) => `${x.id} ← ${x.source}`).join("\n");
	const ans = await ask("plugin-installer", {
		family: "net",
		hosts: ["github.com"],
		reason: `安装确认：将安装/更新以下插件（id ← source）：\n${list}\n拒绝或 120 秒未确认则不安装。`,
	});
	if (ans.ok && ans.remember && deps.permGrants) {
		deps.permGrants.grant("plugin-installer", "net", {
			hosts: ["github.com"],
			reason: "插件安装/更新确认",
			remember: true,
		});
		deps.onGrantsChanged?.();
	}
	return ans.ok === true;
}
