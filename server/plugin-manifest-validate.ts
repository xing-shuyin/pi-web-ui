export interface ManifestIssue {
	path: string;
	message: string;
	messageEn: string;
}

export interface ManifestValidation {
	errors: ManifestIssue[];
	warnings: ManifestIssue[];
	apiVersion: number;
	permissions: string[];
	strict: boolean;
}

const ID_RE = /^[A-Za-z0-9_-]+$/;

export const KNOWN_PERMISSION_FAMILIES: ReadonlySet<string> = new Set([
	"fs",
	"fs:read",
	"fs:write",
	"ui",
	"tools",
	"http",
	"chat",
	"net",
	"llm",
	"dom",
	"dom:anchor",
	"notify",
	"storage",
	"secrets",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
	return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

export function isKnownPermission(v: string): boolean {
	return KNOWN_PERMISSION_FAMILIES.has(v) || KNOWN_PERMISSION_FAMILIES.has(v.split(":")[0]!);
}

export function validatePluginManifest(raw: unknown, dirName: string): ManifestValidation {
	const errors: ManifestIssue[] = [];
	const warnings: ManifestIssue[] = [];
	if (!isRecord(raw)) {
		errors.push({
			path: "manifest",
			message: "manifest.json 必须是对象",
			messageEn: "manifest.json must be an object",
		});
		return { errors, warnings, apiVersion: 1, permissions: [], strict: false };
	}
	const o = raw as Record<string, unknown>;

	const idRaw = o.id;
	if (idRaw === undefined) {
	} else if (typeof idRaw !== "string" || !idRaw.trim()) {
		warnings.push({
			path: "id",
			message: "id 非字符串，已回落为目录名",
			messageEn: 'invalid "id", fell back to directory name',
		});
	} else if (!ID_RE.test(idRaw.trim())) {
		errors.push({
			path: "id",
			message: `id「${idRaw.trim().slice(0, 32)}」非法（只允许字母数字/_/-）`,
			messageEn: `invalid "id" (only [A-Za-z0-9_-] allowed)`,
		});
	} else if (idRaw.trim() !== dirName) {
		errors.push({
			path: "id",
			message: `id「${idRaw.trim()}」与目录名「${dirName}」不一致`,
			messageEn: `"id" does not match directory name "${dirName}"`,
		});
	}

	let apiVersion = 1;
	const av = o.apiVersion;
	if (av === undefined) {
		apiVersion = 1;
	} else if (typeof av !== "number" || !Number.isInteger(av) || av < 1) {
		errors.push({
			path: "apiVersion",
			message: "apiVersion 必须是 >=1 的整数",
			messageEn: '"apiVersion" must be an integer >= 1',
		});
		apiVersion = 1;
	} else {
		apiVersion = av;
	}

	let permissions: string[] = [];
	const perms = o.permissions;
	if (perms === undefined) {
		permissions = [];
	} else if (!Array.isArray(perms)) {
		errors.push({
			path: "permissions",
			message: "permissions 必须是字符串数组",
			messageEn: '"permissions" must be an array of strings',
		});
	} else {
		if (perms.length > 16) {
			warnings.push({
				path: "permissions",
				message: `permissions 超出 16 个，多余的将被忽略`,
				messageEn: '"permissions" capped at 16 entries',
			});
		}
		for (let i = 0; i < Math.min(perms.length, 16); i++) {
			const p = perms[i];
			const path = `permissions[${i}]`;
			if (typeof p !== "string" || !p.trim()) {
				errors.push({ path, message: "能力声明不能为空", messageEn: "capability must be a non-empty string" });
				continue;
			}
			const v = p.trim();
			if (!isKnownPermission(v)) {
				errors.push({
					path,
					message: `未知能力「${v.slice(0, 32)}」（可选 ${[...KNOWN_PERMISSION_FAMILIES].join("/")})`,
					messageEn: `unknown capability "${v.slice(0, 32)}"`,
				});
				continue;
			}
			permissions.push(v);
		}
	}

	const strict = permissions.length > 0 || apiVersion >= 2;
	if (apiVersion === 2 && permissions.length === 0 && perms === undefined) {
		errors.push({
			path: "permissions",
			message: "apiVersion 2 的插件必须声明 permissions",
			messageEn: 'apiVersion 2 plugins must declare "permissions"',
		});
	}

	if (o.engines !== undefined) {
		if (!isRecord(o.engines)) {
			errors.push({ path: "engines", message: "engines 必须是对象", messageEn: '"engines" must be an object' });
		} else {
			for (const [k, v] of Object.entries(o.engines).slice(0, 8)) {
				if (typeof v !== "string") {
					errors.push({
						path: `engines.${k}`,
						message: "engines 约束值必须是字符串",
						messageEn: '"engines" constraint values must be strings',
					});
				}
			}
		}
	}

	if (o.requires !== undefined) {
		if (!isRecord(o.requires)) {
			errors.push({ path: "requires", message: "requires 必须是对象", messageEn: '"requires" must be an object' });
		} else {
			const r = o.requires;
			if (
				r.hostApi !== undefined &&
				(typeof r.hostApi !== "number" || !Number.isInteger(r.hostApi) || (r.hostApi as number) < 1)
			) {
				errors.push({
					path: "requires.hostApi",
					message: "requires.hostApi 必须是 >=1 的整数",
					messageEn: '"requires.hostApi" must be an integer >= 1',
				});
			}
			if (r.families !== undefined) {
				if (!Array.isArray(r.families)) {
					errors.push({
						path: "requires.families",
						message: "requires.families 必须是字符串数组",
						messageEn: '"requires.families" must be an array of strings',
					});
				} else {
					if (r.families.length > 8) {
						warnings.push({
							path: "requires.families",
							message: "requires.families 超出 8 个，多余的将被忽略",
							messageEn: '"requires.families" capped at 8 entries',
						});
					}
					for (let i = 0; i < Math.min(r.families.length, 8); i++) {
						const f = r.families[i];
						const path = `requires.families[${i}]`;
						if (typeof f !== "string" || !f.trim()) {
							errors.push({ path, message: "能力族不能为空", messageEn: "family must be a non-empty string" });
						} else if (!isKnownPermission(f.trim())) {
							errors.push({
								path,
								message: `未知能力族「${f.trim().slice(0, 32)}」（拼写？或需要更新 pi-web-ui）`,
								messageEn: `unknown family "${f.trim().slice(0, 32)}" (typo? or needs newer pi-web-ui)`,
							});
						}
					}
				}
			}
			if (r.plugins !== undefined) {
				if (!Array.isArray(r.plugins)) {
					errors.push({
						path: "requires.plugins",
						message: "requires.plugins 必须是插件 id 数组",
						messageEn: '"requires.plugins" must be an array of plugin ids',
					});
				} else {
					if (r.plugins.length > 16) {
						warnings.push({
							path: "requires.plugins",
							message: "requires.plugins 超出 16 个，多余的将被忽略",
							messageEn: '"requires.plugins" capped at 16 entries',
						});
					}
					for (let i = 0; i < Math.min(r.plugins.length, 16); i++) {
						const dep = r.plugins[i];
						if (typeof dep !== "string" || !ID_RE.test(dep.trim())) {
							errors.push({
								path: `requires.plugins[${i}]`,
								message: "插件 id 非法（只允许字母数字/_/-）",
								messageEn: "invalid plugin id (only [A-Za-z0-9_-] allowed)",
							});
						}
					}
				}
			}
		}
	}

	for (const key of ["view", "preload"] as const) {
		if (o[key] !== undefined && typeof o[key] !== "boolean") {
			warnings.push({
				path: key,
				message: `${key} 必须是布尔值，已回落缺省`,
				messageEn: `"${key}" must be a boolean, fell back to default`,
			});
		}
	}

	for (const key of ["name", "version", "description", "icon"] as const) {
		if (o[key] !== undefined && typeof o[key] !== "string") {
			warnings.push({
				path: key,
				message: `${key} 必须是字符串，已忽略`,
				messageEn: `"${key}" must be a string, ignored`,
			});
		}
	}

	for (const key of [
		"netAllowlist",
		"peerPlugins",
		"renderers",
		"messageWidgets",
		"attachmentCards",
		"composerProviders",
	] as const) {
		if (o[key] !== undefined && !Array.isArray(o[key])) {
			warnings.push({
				path: key,
				message: `${key} 必须是数组，已忽略`,
				messageEn: `"${key}" must be an array, ignored`,
			});
		}
	}
	if (o.settings !== undefined && !Array.isArray(o.settings) && !isRecord(o.settings)) {
		warnings.push({
			path: "settings",
			message: "settings 必须是数组或对象，已忽略",
			messageEn: '"settings" must be an array or object, ignored',
		});
	}
	if (o.fileHandlers !== undefined && !Array.isArray(o.fileHandlers)) {
		warnings.push({
			path: "fileHandlers",
			message: "fileHandlers 必须是数组，已忽略",
			messageEn: '"fileHandlers" must be an array, ignored',
		});
	}

	if (o.ui !== undefined && strict && apiVersion <= 2 && !permissions.some((x) => x.split(":")[0] === "ui")) {
		errors.push({
			path: "ui",
			message: '声明了 ui 却未声明 "ui" 能力，整份 ui 不会生效',
			messageEn: 'manifest declares "ui" but lacks the "ui" capability — the whole ui section is ignored',
		});
	}
	if (o.ui !== undefined && typeof o.ui !== "object") {
		errors.push({ path: "ui", message: "ui 必须是对象", messageEn: '"ui" must be an object' });
	}

	return { errors, warnings, apiVersion, permissions, strict };
}

export function formatManifestIssue(i: ManifestIssue): string {
	return `${i.path}: ${i.message} (${i.messageEn})`;
}
