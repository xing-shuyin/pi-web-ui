import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Session } from "electron";

/**
 * `declarativeNetRequest` 的静态规则执行层。
 *
 * Electron 44 有 `chrome.declarativeNetRequest` 命名空间，规则**存得进、读得出，就是不拦**
 * （`updateDynamicRules` 成功后请求照常放行）。MV3 广告拦截器把规则放在 manifest 的
 * `declarative_net_request.rule_resources` 里，所以这里由主进程读这些 JSON，翻译成
 * `session.webRequest.onBeforeRequest` 的判定——这是 Electron 里唯一真正能拦请求的通道。
 *
 * 支持范围（刻意保守，只做能确定语义的部分）：
 * - 静态规则集（manifest 声明且未 `enabled: false` 的）；
 * - 动作 `block` / `allow`（`redirect` / `modifyHeaders` / `allowAllRequests` 等跳过）；
 * - 条件 `urlFilter` / `regexFilter` / `resourceTypes` / `excludedResourceTypes` /
 *   `domains` / `excludedDomains` / `requestDomains` / `excludedRequestDomains` /
 *   `initiatorDomains` / `excludedInitiatorDomains` / `isUrlFilterCaseSensitive`；
 * - 优先级：高者胜；同优先级 `allow` 胜 `block`（与 Chrome 一致）。
 *
 * 不做的：动态/会话规则（存在扩展的 LevelDB 里，主进程拿不到）、`$` 选项语法之外的扩展语义、
 * RE2 的线性保证（用体积/回引限制 + 字面量预筛降低 ReDoS 风险）。
 */

/** Chrome 的上限：静态规则集单个 30k，正则规则另有更低配额；这里按更严格的一档收。 */
const MAX_RULES_PER_EXTENSION = 30_000;
const MAX_RULES_TOTAL = 100_000;
const MAX_REGEX_LENGTH = 512;
const MIN_TOKEN_LENGTH = 3;

export interface RuleRequest {
	url: string;
	/** Electron webRequest 的 resourceType（mainFrame / subFrame / image …）。 */
	type: string;
	/** 发起方 URL（Electron 给的是 referrer）；拿不到时不匹配任何 domains 条件。 */
	initiator?: string;
}

export interface NetworkRule {
	id: number;
	priority: number;
	allow: boolean;
	/** 命中的 URL 是否在这条扩展的 host 权限范围内（Chrome 的 host 权限门禁）。 */
	allowUrl: (url: string) => boolean;
	/** 字面量预筛：规则里最长的纯字面片段（小写），不含它就不可能命中。 */
	token?: string;
	test: (url: string, request: RuleRequest) => boolean;
}

const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Electron webRequest 的 resourceType → Chrome 的 ResourceType。 */
export function resourceTypeOf(raw: string): string {
	switch (raw) {
		case "mainFrame":
			return "main_frame";
		case "subFrame":
			return "sub_frame";
		case "stylesheet":
			return "stylesheet";
		case "script":
			return "script";
		case "image":
			return "image";
		case "font":
			return "font";
		case "object":
			return "object";
		case "xhr":
			return "xmlhttprequest";
		case "ping":
			return "ping";
		case "cspReport":
			return "csp_report";
		case "media":
			return "media";
		case "webSocket":
			return "websocket";
		default:
			return "other";
	}
}

export function hostFromUrl(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/** Chrome 的 `domains` 语义：域名自身或其子域；不支持通配符。 */
export function domainMatches(host: string, domain: string): boolean {
	const target = host.toLowerCase();
	const pattern = domain.toLowerCase().replace(/^\./, "");
	if (!pattern) return false;
	return target === pattern || target.endsWith(`.${pattern}`);
}

/** Chrome match pattern（host 权限）→ 判定函数。只关心 scheme + host，路径按 `/*` 处理。 */
export function hostPermissionMatcher(patterns: string[]): (url: string) => boolean {
	const parsed = patterns.map((pattern) => {
		const raw = pattern.trim();
		if (!raw) return null;
		if (raw === "<all_urls>") return { all: true, scheme: "", host: "" };
		const match = /^(\*|https?|wss?|file|ftp):\/\/([^/]*)(\/.*)?$/i.exec(raw);
		if (!match) return null;
		return { all: false, scheme: match[1].toLowerCase(), host: match[2].toLowerCase() };
	});
	const usable = parsed.filter((item): item is { all: boolean; scheme: string; host: string } => item !== null);
	if (!usable.length) return () => false;
	return (url: string) => {
		let target: URL;
		try {
			target = new URL(url);
		} catch {
			return false;
		}
		const scheme = target.protocol.replace(/:$/, "").toLowerCase();
		const host = target.hostname.toLowerCase();
		return usable.some((rule) => {
			if (rule.all) return ["http", "https", "ws", "wss", "ftp", "file"].includes(scheme);
			if (rule.scheme === "*") {
				if (!["http", "https", "ws", "wss"].includes(scheme)) return false;
			} else if (rule.scheme !== scheme) {
				return false;
			}
			if (rule.host === "*") return true;
			if (rule.host.startsWith("*.")) return host === rule.host.slice(2) || host.endsWith(rule.host.slice(1));
			return host === rule.host;
		});
	};
}

const REGEX_SPECIAL = new Set(["\\", "^", "$", ".", "|", "?", "*", "+", "(", ")", "[", "]", "{", "}", "/"]);

/** 从 `urlFilter` 里取最长字面片段，作为廉价预筛（没有就返回 undefined）。 */
export function literalToken(filter: string): string | undefined {
	let best = "";
	let current = "";
	for (const char of filter) {
		if (/[a-zA-Z0-9]/.test(char) || (current && ".-_%".includes(char))) {
			current += char;
			if (current.length > best.length) best = current;
		} else {
			current = "";
		}
	}
	return best.length >= MIN_TOKEN_LENGTH ? best.toLowerCase() : undefined;
}

/**
 * Chrome `urlFilter` → RegExp。支持 `*` / `^` / 首尾 `|` / `||domain` 锚点；
 * 其余字符按字面量处理（不做正则转义猜测）。
 */
export function urlFilterToRegExp(filter: string, caseSensitive = false): RegExp | null {
	if (!filter) return null;
	let source = "";
	let index = 0;
	if (filter.startsWith("||")) {
		// 域名锚点：协议后紧跟该域名，或它的任意子域
		source += "^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#]*\\.)?";
		index = 2;
	} else if (filter.startsWith("|")) {
		source += "^";
		index = 1;
	}
	let end = filter.length;
	let anchoredEnd = false;
	if (filter.endsWith("|") && end > index) {
		end -= 1;
		anchoredEnd = true;
	}
	for (; index < end; index += 1) {
		const char = filter[index];
		if (char === "*") {
			source += ".*";
			continue;
		}
		if (char === "^") {
			source += "(?:[^a-zA-Z0-9_\\-.%]|$)";
			continue;
		}
		source += REGEX_SPECIAL.has(char) ? `\\${char}` : char;
	}
	if (anchoredEnd) source += "$";
	try {
		return new RegExp(source, caseSensitive ? "" : "i");
	} catch {
		return null;
	}
}

/** 正则规则的安全阀：拒绝回引/后行断言这类无法保证线性、易被放大成 ReDoS 的写法。 */
export function safeRegex(pattern: string, caseSensitive = false): RegExp | null {
	if (!pattern || pattern.length > MAX_REGEX_LENGTH) return null;
	if (/\\[1-9]|\(\?</.test(pattern)) return null;
	try {
		return new RegExp(pattern, caseSensitive ? "" : "i");
	} catch {
		return null;
	}
}

export interface CompileContext {
	allowUrl: (url: string) => boolean;
	/** 规则来源（扩展名 + 规则集），只用于日志。 */
	source: string;
	startId?: number;
}

/** 把一份 ruleset JSON 编成可执行规则；不支持的规则直接丢弃。 */
export function compileRuleset(raw: unknown, context: CompileContext): NetworkRule[] {
	const rules: NetworkRule[] = [];
	if (!Array.isArray(raw)) return rules;
	let id = context.startId ?? 0;
	for (const entry of raw) {
		if (rules.length >= MAX_RULES_PER_EXTENSION) break;
		const rule = object(entry);
		const condition = object(rule.condition);
		const action = object(rule.action);
		const actionType = typeof action.type === "string" ? action.type : "";
		if (actionType !== "block" && actionType !== "allow") continue;
		const urlFilter = typeof condition.urlFilter === "string" ? condition.urlFilter : "";
		const regexFilter = typeof condition.regexFilter === "string" ? condition.regexFilter : "";
		if (!urlFilter && !regexFilter) continue;
		const caseSensitive = condition.isUrlFilterCaseSensitive === true;
		const matcher = urlFilter ? urlFilterToRegExp(urlFilter, caseSensitive) : safeRegex(regexFilter, caseSensitive);
		if (!matcher) continue;
		const included = new Set(strings(condition.resourceTypes));
		const excluded = new Set(strings(condition.excludedResourceTypes));
		const domains = strings(condition.domains);
		const excludedDomains = strings(condition.excludedDomains);
		const requestDomains = strings(condition.requestDomains);
		const excludedRequestDomains = strings(condition.excludedRequestDomains);
		const initiatorDomains = strings(condition.initiatorDomains);
		const excludedInitiatorDomains = strings(condition.excludedInitiatorDomains);
		const priority = typeof rule.priority === "number" && Number.isFinite(rule.priority) ? rule.priority : 1;
		const token = urlFilter ? literalToken(urlFilter) : undefined;
		rules.push({
			id: id++,
			priority,
			allow: actionType === "allow",
			allowUrl: context.allowUrl,
			...(token ? { token } : {}),
			test: (url, request) => {
				if (!context.allowUrl(url)) return false;
				const type = resourceTypeOf(request.type);
				if (included.size && !included.has(type)) return false;
				if (excluded.size && excluded.has(type)) return false;
				const requestHost = hostFromUrl(url);
				if (requestDomains.length && !requestDomains.some((domain) => domainMatches(requestHost, domain))) return false;
				if (excludedRequestDomains.some((domain) => domainMatches(requestHost, domain))) return false;
				const initiatorHost = request.initiator ? hostFromUrl(request.initiator) : "";
				if (domains.length && !(initiatorHost && domains.some((domain) => domainMatches(initiatorHost, domain))))
					return false;
				if (initiatorHost && excludedDomains.some((domain) => domainMatches(initiatorHost, domain))) return false;
				if (
					initiatorDomains.length &&
					!(initiatorHost && initiatorDomains.some((domain) => domainMatches(initiatorHost, domain)))
				)
					return false;
				if (initiatorHost && excludedInitiatorDomains.some((domain) => domainMatches(initiatorHost, domain)))
					return false;
				return matcher.test(url);
			},
		});
	}
	return rules;
}

/**
 * 执行层：一个 session 只能注册一个 `onBeforeRequest`，所以引擎是单例式对象，
 * 规则由宿主在扩展加载/停用/移除后刷新。
 */
export class DeclarativeNetworkRules {
	private rules: NetworkRule[] = [];
	private started = false;

	constructor(private readonly session: Session) {}
	get size(): number {
		return this.rules.length;
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
			callback({ cancel: this.isBlocked(details) });
		});
	}

	setRules(rules: NetworkRule[]): void {
		this.rules = rules.slice(0, MAX_RULES_TOTAL);
	}

	isBlocked(details: { url: string; resourceType?: string; referrer?: string; initiatorOrigin?: string }): boolean {
		if (!this.rules.length) return false;
		const url = details.url;
		// 内置页面（shell/newtab/office/… 都是 file:）与扩展页不参与拦截：规则写错也不该让浏览器自己打不开
		if (url.startsWith("file:") || url.startsWith("chrome-extension:") || url.startsWith("devtools:")) return false;
		const target = url.split("#")[0];
		const lower = target.toLowerCase();
		const initiator = details.initiatorOrigin || details.referrer;
		const request: RuleRequest = {
			url: target,
			type: details.resourceType ?? "other",
			...(initiator ? { initiator } : {}),
		};
		let winner: NetworkRule | undefined;
		for (const rule of this.rules) {
			if (rule.token && !lower.includes(rule.token)) continue;
			let matched = false;
			try {
				matched = rule.test(target, request);
			} catch {
				matched = false;
			}
			if (!matched) continue;
			if (!winner || rule.priority > winner.priority) winner = rule;
			else if (rule.priority === winner.priority && rule.allow && !winner.allow) winner = rule;
		}
		return winner ? !winner.allow : false;
	}
}

interface RuleResource {
	id?: string;
	enabled?: boolean;
	path?: string;
}

/** 从已加载扩展里读静态规则集并编译。读不动的单个扩展只跳过它自己。 */
export async function collectExtensionRules(extensions: Electron.Extension[]): Promise<NetworkRule[]> {
	const all: NetworkRule[] = [];
	for (const extension of extensions) {
		if (all.length >= MAX_RULES_TOTAL) break;
		const manifest = object(extension.manifest);
		const permissions = [...strings(manifest.permissions), ...strings(manifest.host_permissions)];
		if (!permissions.includes("declarativeNetRequest") && !permissions.includes("declarativeNetRequestWithHostAccess"))
			continue;
		const hostPermissions = [...strings(manifest.host_permissions), ...strings(manifest.optional_host_permissions)];
		// MV2 的 host 权限写在 permissions 里（带 :// 或 <all_urls> 的才当 host 模式）
		for (const permission of strings(manifest.permissions)) {
			if (permission === "<all_urls>" || permission.includes("://")) hostPermissions.push(permission);
		}
		const allowUrl = hostPermissionMatcher(hostPermissions);
		const resources = manifest.declarative_net_request
			? object(manifest.declarative_net_request).rule_resources
			: undefined;
		if (!Array.isArray(resources)) continue;
		for (const entry of resources) {
			if (all.length >= MAX_RULES_TOTAL) break;
			const resource = object(entry) as RuleResource;
			if (resource.enabled === false) continue;
			if (typeof resource.path !== "string" || !resource.path) continue;
			const file = resolve(join(extension.path, resource.path));
			if (!file.startsWith(resolve(extension.path))) continue;
			let raw: unknown;
			try {
				const info = await stat(file);
				if (!info.isFile() || info.size > 32 * 1024 * 1024) continue;
				raw = JSON.parse(await readFile(file, "utf8"));
			} catch {
				continue;
			}
			all.push(...compileRuleset(raw, { allowUrl, source: `${extension.name}/${resource.id ?? resource.path}` }));
		}
	}
	return all;
}
