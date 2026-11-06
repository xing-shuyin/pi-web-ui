import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isValidSource } from "./plugin-catalog.js";

export type InstallSpecKind = "npm" | "github" | "url" | "path" | "invalid";

export interface InstallSpecParse {
	kind: InstallSpecKind;
	normalized: string;
	owner?: string;
	repo?: string;
	ref?: string;
	subpath?: string;
}

const NPM_RE = /^(?:@[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/)?[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:@[^\s/]+)?$/i;

export function parseInstallSpec(rawSpec: string): InstallSpecParse {
	const raw = String(rawSpec ?? "").trim();
	if (!raw) return { kind: "invalid", normalized: "" };
	const localCandidate = raw.replace(/^file:\/\//i, "");
	if (isAbsolute(localCandidate) || safeExists(localCandidate)) return { kind: "path", normalized: localCandidate };
	if (/^https?:\/\//i.test(raw)) {
		const gh = parseGithubUrl(raw);
		if (gh) return gh;
		return { kind: "url", normalized: raw };
	}
	const short = parseGithubShort(raw);
	if (short) return short;
	if (NPM_RE.test(raw)) return { kind: "npm", normalized: raw };
	return { kind: "invalid", normalized: raw };
}

function safeExists(p: string): boolean {
	try {
		return existsSync(p);
	} catch {
		return false;
	}
}

function parseGithubUrl(raw: string): InstallSpecParse | null {
	const m = raw.match(
		/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)(?:\/(?:tree|blob)\/([^/]+)((?:\/[^#?]+)*))?/i,
	);
	if (!m) return null;
	const [, owner, repoRaw, refRaw, rest] = m;
	const repo = String(repoRaw ?? "").replace(/\.git$/i, "");
	const subpath = String(rest ?? "")
		.replace(/^\/+/, "")
		.replace(/\/+$/, "");
	const hashRef = raw.includes("#") ? raw.slice(raw.indexOf("#") + 1).trim() : "";
	const ref = hashRef || String(refRaw ?? "");
	return {
		kind: "github",
		normalized: [owner, repo, subpath].filter(Boolean).join("/") + (ref ? `#${ref}` : ""),
		owner,
		repo,
		...(ref ? { ref } : {}),
		...(subpath ? { subpath } : {}),
	};
}

function parseGithubShort(raw: string): InstallSpecParse | null {
	if (raw.startsWith("@")) return null;
	const hash = raw.indexOf("#");
	const ref = hash >= 0 ? raw.slice(hash + 1).trim() : "";
	const body = (hash >= 0 ? raw.slice(0, hash) : raw).replace(/\/+$/, "");
	if (!isValidSource(body)) return null;
	const segs = body.split("/").filter(Boolean);
	const [owner, repo, ...rest] = segs;
	if (!owner || !repo) return null;
	let subpath = rest.join("/");
	let effectiveRef = ref;
	if (rest[0] === "tree" || rest[0] === "blob") {
		effectiveRef = rest[1] ?? ref;
		subpath = rest.slice(2).join("/");
	}
	return {
		kind: "github",
		normalized: body + (effectiveRef ? `#${effectiveRef}` : ""),
		owner,
		repo,
		...(effectiveRef ? { ref: effectiveRef } : {}),
		...(subpath ? { subpath } : {}),
	};
}

export type InstallProblem =
	"invalid-spec" | "already-installed" | "not-found" | "not-a-package" | "not-a-bundle" | "network" | "unknown";

export interface InstallInspect {
	spec: InstallSpecParse;
	problem?: InstallProblem;
	detail?: string;
	installed: boolean;
	manifest?: { id?: string; name?: string; version?: string; description?: string; permissions?: string[] };
	suggestedId: string;
}

const ID_RE = /^[A-Za-z0-9_-]+$/;

export function suggestPluginId(spec: InstallSpecParse, explicit?: string): string {
	if (explicit && ID_RE.test(explicit)) return explicit;
	const seg = spec.subpath
		? spec.subpath.split("/").filter(Boolean).pop()
		: (spec.repo ?? lastSegment(spec.normalized));
	const cleaned = String(seg ?? "")
		.replace(/[^A-Za-z0-9_-]/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned || "plugin";
}

function lastSegment(s: string): string {
	const body = s.split("#")[0]!.replace(/\/+$/, "");
	const segs = body.split("/").filter(Boolean);
	return segs[segs.length - 1] ?? "";
}

export interface LocalInspectDeps {
	pluginsDir: string;
	explicitId?: string;
	force?: boolean;
}

export function inspectLocalInstallSpec(rawSpec: string, deps: LocalInspectDeps): InstallInspect {
	const spec = parseInstallSpec(rawSpec);
	const suggestedId = suggestPluginId(spec, deps.explicitId);
	const installed = safeExists(join(deps.pluginsDir, suggestedId));
	const base: InstallInspect = { spec, installed, suggestedId };
	if (spec.kind === "invalid")
		return {
			...base,
			problem: "invalid-spec",
			detail:
				"Unrecognized source — expected owner/repo, owner/repo/subdir[#ref], a GitHub URL, or an npm package name.",
		};
	if (spec.kind === "path" && !safeExists(spec.normalized))
		return { ...base, problem: "not-found", detail: `Local path does not exist: ${spec.normalized}` };
	if (installed && !deps.force)
		return {
			...base,
			problem: "already-installed",
			detail: `A plugin named "${suggestedId}" is already installed — use Update to replace it.`,
		};
	return base;
}

export function readLocalManifest(dir: string): InstallInspect["manifest"] | null {
	try {
		const p = join(dir, "manifest.json");
		if (!statSync(p).isFile()) return null;
		const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
		return pickManifestFields(raw);
	} catch {
		return null;
	}
}

export function pickManifestFields(raw: unknown): InstallInspect["manifest"] | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.id !== "string" && typeof o.name !== "string") return null;
	const permissions = Array.isArray(o.permissions)
		? o.permissions.filter((x): x is string => typeof x === "string").slice(0, 32)
		: undefined;
	return {
		...(typeof o.id === "string" ? { id: o.id } : {}),
		...(typeof o.name === "string" ? { name: o.name } : {}),
		...(typeof o.version === "string" ? { version: o.version } : {}),
		...(typeof o.description === "string" ? { description: o.description } : {}),
		...(permissions ? { permissions } : {}),
	};
}

export function manifestCandidateUrls(spec: InstallSpecParse): string[] {
	if (spec.kind !== "github" || !spec.owner || !spec.repo) return [];
	const ref = spec.ref || "HEAD";
	const base = `https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/${ref}`;
	return spec.subpath ? [`${base}/${spec.subpath}/manifest.json`] : [`${base}/manifest.json`];
}
