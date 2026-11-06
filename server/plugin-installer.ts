import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isBuiltinModule } from "./builtin-modules.js";
import { pick, type ServerLang } from "./i18n.js";
import { isValidSource } from "./plugin-catalog.js";
import {
	inspectLocalInstallSpec,
	manifestCandidateUrls,
	parseInstallSpec,
	readLocalManifest,
	suggestPluginId,
	type InstallInspect,
} from "./plugin-install-spec.js";
import { killPidTree } from "./process-utils.js";
import type { ServerMessage } from "./protocol.js";

const ID_RE = /^[A-Za-z0-9_-]+$/;

function isBuiltinModulePath(path: string): boolean {
	let canonical = resolve(path);
	try {
		canonical = realpathSync(canonical);
	} catch {}
	return isBuiltinModule(basename(canonical).toLowerCase());
}

function builtinModuleError(lang: ServerLang): string {
	return pick(
		lang,
		"内置模块由宿主管理，不能通过插件入口安装、更新或卸载。",
		"Built-in modules are managed by the host and cannot be installed, updated or uninstalled as plugins.",
	);
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_CHARS = 8000;
const MAX_LINE_CHARS = 2000;

export interface PluginJobSpec {
	jobId: string;
	action: "install" | "update" | "uninstall";
	id: string;
	source?: string;
	build?: boolean;
	noBuild?: boolean;
}

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
	if (isBuiltinModule(id.toLowerCase()) || isBuiltinModulePath(join(dataDir, "plugins", id)))
		return { error: builtinModuleError(l) };
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
	if (isBuiltinModule(suggestPluginId(parseInstallSpec(source)).toLowerCase())) return { error: builtinModuleError(l) };
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
	const rejectBuiltin = (): InstallInspect => ({ ...local, problem: "invalid-spec", detail: builtinModuleError("en") });
	const isBuiltinId = (id?: string): boolean => !!id && isBuiltinModule(id.trim().toLowerCase());
	if (
		isBuiltinId(deps.explicitId) ||
		isBuiltinId(local.suggestedId) ||
		isBuiltinId(suggestPluginId(local.spec)) ||
		isBuiltinModulePath(join(deps.pluginsDir, local.suggestedId)) ||
		(local.spec.kind === "path" && isBuiltinModulePath(local.spec.normalized))
	)
		return rejectBuiltin();
	if (local.problem || local.spec.kind === "npm" || local.spec.kind === "url") {
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
		if (isBuiltinId(manifest.id)) return rejectBuiltin();
		return { ...local, manifest, suggestedId: suggestPluginId(local.spec, deps.explicitId ?? manifest.id) };
	}
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
			if (isBuiltinId(manifest.id)) return rejectBuiltin();
			return { ...local, manifest, suggestedId: suggestPluginId(local.spec, deps.explicitId ?? manifest.id) };
		} catch {
			return { ...local, problem: "network", detail: "Could not reach the remote repository to verify the plugin." };
		}
	}
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
	emit(msg: ServerMessage): void;
	done(ok: boolean, info: { error?: string; output: string }): void | Promise<void>;
	lang?: () => ServerLang;
}

export interface PluginInstallerDeps {
	dataDir: string;
	pkgRoot: string;
	managed: boolean;
	timeoutMs?: number;
}

export class PluginInstaller {
	private child: ChildProcess | null = null;
	private currentJobId: string | null = null;

	constructor(private readonly deps: PluginInstallerDeps) {}

	get busyJobId(): string | null {
		return this.currentJobId;
	}

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
			} catch {}
		};
		const child = spawn(process.execPath, [binPath, ...built.args], {
			windowsHide: true,
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
			void Promise.resolve(hooks.done(ok, { error, output: out })).catch(() => {});
		};

		child.stdout?.on("data", onChunk);
		child.stderr?.on("data", onChunk);
		child.on("error", (err) => finish(false, err.message));
		child.on("close", (code) => {
			if (cancelled) return finish(false, pick(l, "作业已取消", "Job cancelled", "plugininstaller.cancelled"));
			if (timedOut) {
				const min = Math.round(Math.max(1000, Number(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)) / 60000);
				return finish(
					false,
					pick(
						l,
						`作业超时（${min} 分钟）已终止`,
						`Job timed out after ${min} min and was killed`,
						"plugininstaller.timeout",
						{ min },
					),
				);
			}
			const diagnostic = (tail + pending).trim().slice(-MAX_LINE_CHARS);
			finish(code === 0, code === 0 ? undefined : `exit code ${code}${diagnostic ? `: ${diagnostic}` : ""}`);
		});

		emit({ type: "plugin_job", jobId, action, pluginId, phase: "start" });
		this.cancelFlags.set(jobId, () => {
			cancelled = true;
		});
		return { ok: true };
	}

	private cancelFlags = new Map<string, () => void>();

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

	cancel(jobId: string): boolean {
		if (!this.currentJobId || this.currentJobId !== jobId || !this.child) return false;
		this.cancelFlags.get(jobId)?.();
		this.killTree(this.child);
		return true;
	}

	private killTree(child: ChildProcess): void {
		const pid = child.pid;
		if (!pid) return;
		try {
			killPidTree(pid);
		} catch {
			try {
				child.kill("SIGKILL");
			} catch {}
		}
	}

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
