import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pick, type ServerLang } from "./i18n.js";
import { normalizeSyncPayload, writeCustomCatalog, writeCommunityCatalog } from "./plugin-catalog.js";
import { workspacePath } from "./files-service.js";
import type { PluginInstaller } from "./plugin-installer.js";
import type { UiPluginCatalogEntry } from "./protocol.js";

export interface CatalogSyncOptions {
	install?: boolean;
	replace?: boolean;
	target?: "community" | "custom";
}

export interface CatalogSyncDeps {
	customCatalogPath: string;
	communityCatalogPath?: string;
	pluginsDir: string;
	installer: PluginInstaller;
	afterWrite: () => Promise<void>;
	lang?: () => ServerLang;
	fetchTimeoutMs?: number;
	maxBytes?: number;
	workspaceRoot?: string;
	confirmInstall?: (items: Array<{ id: string; source: string }>) => Promise<boolean>;
}

export interface CatalogSyncResult {
	ok: boolean;
	error?: string;
	entries?: UiPluginCatalogEntry[];
	installed?: { id: string; ok: boolean; error?: string }[];
	installRefused?: boolean;
}

function localDocFailed(l: ServerLang): { error: string } {
	return {
		error: pick(
			l,
			"目录文档无效或不可读（仅支持 http(s) URL 或工作区内的 JSON 文件）",
			"Invalid or unreadable catalog document (http(s) URL or an in-workspace JSON file only)",
			"plugincatalog.sync.doc.invalid",
		),
	};
}

async function readDocument(
	source: string,
	deps: CatalogSyncDeps,
	lang: () => ServerLang,
): Promise<{ text: string } | { error: string }> {
	const l = lang();
	const maxBytes = Math.max(1024, Number(deps.maxBytes ?? 1024 * 1024));
	if (/^https?:\/\//i.test(source)) {
		let res: Response;
		try {
			res = await fetch(source, {
				redirect: "follow",
				signal: AbortSignal.timeout(Math.max(1000, Number(deps.fetchTimeoutMs ?? 30_000))),
			});
		} catch (err) {
			return {
				error: pick(
					l,
					`拉取目录失败：${(err as Error)?.message ?? err}`,
					`Failed to fetch the catalog: ${(err as Error)?.message ?? err}`,
					"plugincatalog.sync.fetch.failed",
					{ reason: String((err as Error)?.message ?? err) },
				),
			};
		}
		if (!res.ok)
			return {
				error: pick(
					l,
					`拉取目录失败：HTTP ${res.status}`,
					`Failed to fetch the catalog: HTTP ${res.status}`,
					"plugincatalog.sync.http",
					{ status: String(res.status) },
				),
			};
		const text = await res.text();
		if (text.length > maxBytes)
			return {
				error: pick(
					l,
					`目录文档过大（> ${Math.round(maxBytes / 1024)} KB）`,
					`Catalog document too large (> ${Math.round(maxBytes / 1024)} KB)`,
					"plugincatalog.sync.too.large",
					{ kb: String(Math.round(maxBytes / 1024)) },
				),
			};
		return { text };
	}
	const wp = deps.workspaceRoot ? workspacePath(deps.workspaceRoot, source.trim()) : null;
	if (!wp) return localDocFailed(l);
	let text: string;
	try {
		text = readFileSync(wp.abs, "utf8");
	} catch {
		return localDocFailed(l);
	}
	if (text.length > maxBytes) return localDocFailed(l);
	return { text };
}

export async function syncPluginCatalog(
	source: string,
	opts: CatalogSyncOptions,
	deps: CatalogSyncDeps,
): Promise<CatalogSyncResult> {
	const lang = deps.lang ?? (() => "en" as ServerLang);
	const l = lang();
	const src = String(source ?? "").trim();
	if (!src)
		return {
			ok: false,
			error: pick(l, "缺少目录来源", "Missing catalog source", "plugincatalog.sync.source.missing"),
		};
	const doc = await readDocument(src, deps, lang);
	if ("error" in doc) return { ok: false, error: doc.error };
	const isLocalSource = !/^https?:\/\//i.test(src);
	let raw: unknown;
	try {
		raw = JSON.parse(doc.text);
	} catch (err) {
		if (isLocalSource) return { ok: false, error: localDocFailed(lang()).error };
		return {
			ok: false,
			error: pick(
				l,
				`目录 JSON 解析失败：${(err as Error)?.message ?? err}`,
				`Catalog JSON is not valid JSON: ${(err as Error)?.message ?? err}`,
				"plugincatalog.sync.parse.failed",
				{ reason: String((err as Error)?.message ?? err) },
			),
		};
	}
	const payload = normalizeSyncPayload(raw, lang);
	if ("error" in payload) return { ok: false, error: payload.error };
	const isCommunity =
		opts.target === "community" ||
		(Boolean(deps.communityCatalogPath) &&
			(source.includes("pi-web-ui-plugins/catalog.json") || source.endsWith("/community-catalog.json")));
	if (isCommunity && deps.communityCatalogPath) {
		writeCommunityCatalog(deps.communityCatalogPath, payload.entries);
	} else {
		writeCustomCatalog(deps.customCatalogPath, payload.entries, opts.replace === true);
	}
	await deps.afterWrite();

	let installed: { id: string; ok: boolean; error?: string }[] | undefined;
	if (opts.install === true && payload.entries.length) {
		const items = payload.entries.map((e) => ({ id: e.id, source: e.source }));
		const confirmed = deps.confirmInstall ? await deps.confirmInstall(items) : false;
		if (!confirmed) return { ok: true, installRefused: true, installed: [] };
		installed = [];
		for (const e of payload.entries) {
			const action = existsSync(join(deps.pluginsDir, e.id)) ? "update" : "install";
			const res = await deps.installer.run(
				{ jobId: `catalog-sync:${e.id}`, action, id: e.id, source: e.source },
				{ lang },
			);
			installed.push({ id: e.id, ok: res.ok, ...(res.error ? { error: res.error } : {}) });
		}
		await deps.afterWrite();
	}
	return { ok: true, installed };
}
