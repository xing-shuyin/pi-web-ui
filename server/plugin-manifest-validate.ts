/**
 * manifest 本体校验：schema 失败即拒（DSH 对照 P1-6）。
 *
 * 与 `parseUiItem` / `parseSettingsSchema` 的"宽容丢弃"正交：
 * 那些是字段级容错（坏条目跳过、文本截断），这里是**结构级否决**
 * （坏 manifest 不该变成运行时 `undefined` 再在远处 nổ）。
 *
 * 语义对齐既有契约：
 * - 旧插件（无 `permissions` 且 `apiVersion<2`）走宽容通道：只拦
 *   JSON 坏 / 非对象 / apiVersion 非法这类"连启动都不该启动"的；
 *   未知能力族、v2 必填缺失等只在严格模式下才算 error。
 * - `errors` 非空 → 拒绝激活（scan 置 error + activate 首行回卷）；
 *   `warnings` 永不阻断，只进 `diagnostics` 供设置面板查看。
 */

export interface ManifestIssue {
	/** 精确路径（如 `permissions[2]` / `ui.topbar[0].id` / `apiVersion`）。 */
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

/** 与 `plugin-sdk/index.d.ts#PluginPermissionFamily` + 运行时 `requestPermission` 同口径。 */
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

/** 能力串是否已知：完整串或冒号前族名命中其一即算（如 "ui:read" 归 ui 族）。 */
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

	// id：缺省回落目录名（向后兼容，只警告）；写了就必须合法且与目录一致。
	const idRaw = o.id;
	if (idRaw === undefined) {
		// 旧插件大量不写 id，不警告（避免全仓黄灯），仅回落。
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

	// apiVersion：缺省 1（旧插件常态，不警告）；写了必须是 1..2 整数。
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

	// permissions：非数组即错；条目逐个校验。
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
				// 未知族：拼写错了就永远授权失败，与静默丢弃同源 —— 直接拒。
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
	// v2 必须声明 permissions（与 §2.5 严格模式同口径）。只对宿主认识的版本强制：
	// apiVersion > 2 交给版本门出“请升级”（见 activate/scan），这里不抢它的错误信息。
	if (apiVersion === 2 && permissions.length === 0 && perms === undefined) {
		errors.push({
			path: "permissions",
			message: "apiVersion 2 的插件必须声明 permissions",
			messageEn: 'apiVersion 2 plugins must declare "permissions"',
		});
	}

	// engines：只收字符串映射；坏形状即错（否则约束被静默吞掉）。
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

	// requires（P2-8 硬依赖）：坏形状即错（依赖判定错不得，静默吞掉等于回到 peerPlugins 的老路）。
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

	// view / preload：坏类型只警告（不影响安全语义，回落缺省）。
	for (const key of ["view", "preload"] as const) {
		if (o[key] !== undefined && typeof o[key] !== "boolean") {
			warnings.push({
				path: key,
				message: `${key} 必须是布尔值，已回落缺省`,
				messageEn: `"${key}" must be a boolean, fell back to default`,
			});
		}
	}

	// 文本字段：坏类型只警告（回落缺省，不阻断）。
	for (const key of ["name", "version", "description", "icon"] as const) {
		if (o[key] !== undefined && typeof o[key] !== "string") {
			warnings.push({
				path: key,
				message: `${key} 必须是字符串，已忽略`,
				messageEn: `"${key}" must be a string, ignored`,
			});
		}
	}

	// 数组型声明：坏形状只警告（解析层已按"过滤+截断"处理）。
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

	// ui：有声明却无 ui 能力（严格模式）= 整份不会生效 —— 算 error 而不是等解析层那条英文诊断。
	// 同样只对宿主认识的版本（apiVersion<=2）强制，未来版本交给版本门。
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

/** 诊断行渲染（scan/activate 共用）：`path: 中文（en）`。 */
export function formatManifestIssue(i: ManifestIssue): string {
	return `${i.path}: ${i.message} (${i.messageEn})`;
}
