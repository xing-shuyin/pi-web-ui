import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ClientSession } from "../../server/agent-service.js";
import { AgentService } from "../../server/agent-service-daemon.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const SOURCES = {
	ClientSession: { file: `${ROOT}server/agent-service.ts`, className: "ClientSession" },
	AgentService: { file: `${ROOT}server/agent-service-daemon.ts`, className: "AgentService" },
} as const;

type SourceKey = keyof typeof SOURCES;

function maskNonCode(text: string): string {
	const out = text.split("");
	let i = 0;
	const blank = (from: number, to: number) => {
		for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
	};
	while (i < text.length) {
		const ch = text[i];
		const next = text[i + 1];
		if (ch === "/" && next === "/") {
			const end = text.indexOf("\n", i);
			const stop = end === -1 ? text.length : end;
			blank(i, stop);
			i = stop;
			continue;
		}
		if (ch === "/" && next === "*") {
			const end = text.indexOf("*/", i + 2);
			const stop = end === -1 ? text.length : end + 2;
			blank(i, stop);
			i = stop;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			const quote = ch;
			let k = i + 1;
			while (k < text.length) {
				if (text[k] === "\\") {
					k += 2;
					continue;
				}
				if (text[k] === quote) {
					k++;
					break;
				}
				k++;
			}
			blank(i + 1, k - 1);
			i = k;
			continue;
		}
		i++;
	}
	return out.join("");
}

function matchBracket(mask: string, from: number): number {
	const open = mask[from];
	const close = open === "{" ? "}" : open === "(" ? ")" : "]";
	let depth = 0;
	for (let i = from; i < mask.length; i++) {
		const ch = mask[i];
		if (ch === open) depth++;
		else if (ch === close) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function classBodySpan(source: string, className: string): { start: number; end: number } | undefined {
	const mask = maskNonCode(source);
	const at = mask.search(new RegExp(`\\bclass\\s+${className}\\b`));
	if (at === -1) return undefined;
	const open = mask.indexOf("{", at);
	if (open === -1) return undefined;
	const close = matchBracket(mask, open);
	if (close === -1) return undefined;
	return { start: open + 1, end: close };
}

export function defaultFromInitializer(rhs: string): unknown {
	const text = rhs.trim();
	if (/^new\s+Map\b/.test(text)) return new Map();
	if (/^new\s+WeakMap\b/.test(text)) return new WeakMap();
	if (/^new\s+Set\b/.test(text)) return new Set();
	if (/^new\s+WeakSet\b/.test(text)) return new WeakSet();
	if (/^new\s+Array\b/.test(text)) return [];
	if (text === "[]") return [];
	if (text === "{}") return {};
	if (/^(""|''|``)$/.test(text)) return "";
	if (/^\d+$/.test(text)) return 0;
	if (text === "true") return true;
	if (text === "false") return false;
	if (text === "null") return null;
	if (/^(\(|async\s*\(|function\b|async\s+function\b)/.test(text)) return () => undefined;
	return undefined;
}

const cache = new Map<SourceKey, Record<string, unknown>>();

export function instanceFieldDefaults(key: SourceKey): Record<string, unknown> {
	const cached = cache.get(key);
	if (cached) return cloneDefaults(cached);
	const { file, className } = SOURCES[key];
	const source = readFileSync(file, "utf8");
	const span = classBodySpan(source, className);
	if (!span) throw new Error(`fake-session: 源码里找不到 class ${className}（${file}）`);
	const body = source.slice(span.start, span.end);
	const mask = maskNonCode(body);
	const out: Record<string, unknown> = {};

	const decl =
		/^\t(?!\t)((?:private|protected|public|readonly|override|declare|#)\s+)*([A-Za-z_$][\w$]*)\s*[?!]?\s*(?::[^=;\n]+?)?\s*=(?!=)\s*/gm;
	for (let m = decl.exec(mask); m; m = decl.exec(mask)) {
		const name = m[2];
		if (name === "constructor" || name === "static") continue;
		const rhsStart = m.index + m[0].length;
		let depth = 0;
		let end = rhsStart;
		for (; end < mask.length; end++) {
			const ch = mask[end];
			if (ch === "(" || ch === "[" || ch === "{") depth++;
			else if (ch === ")" || ch === "]" || ch === "}") depth--;
			else if (ch === ";" && depth <= 0) break;
		}
		if (!(name in out)) out[name] = defaultFromInitializer(body.slice(rhsStart, end));
	}

	const ctor = /^\t(?:(?:private|protected|public|override)\s+)*constructor\s*\(/m.exec(mask);
	if (ctor) {
		const bodyOpen = mask.indexOf("{", ctor.index);
		const bodyClose = bodyOpen === -1 ? -1 : matchBracket(mask, bodyOpen);
		if (bodyOpen !== -1 && bodyClose > bodyOpen) {
			const ctorMask = mask.slice(bodyOpen, bodyClose);
			const ctorSrc = body.slice(bodyOpen, bodyClose);
			const assign = /(?<![=!<>])this\.([A-Za-z_$][\w$]*)\s*=(?![=>])\s*/g;
			for (let m = assign.exec(ctorMask); m; m = assign.exec(ctorMask)) {
				const rhsStart = m.index + m[0].length;
				let depth = 0;
				let end = rhsStart;
				for (; end < ctorMask.length; end++) {
					const ch = ctorMask[end];
					if (ch === "(" || ch === "[" || ch === "{") depth++;
					else if (ch === ")" || ch === "]" || ch === "}") depth--;
					else if (ch === ";" && depth <= 0) break;
				}
				if (!(m[1] in out)) out[m[1]] = defaultFromInitializer(ctorSrc.slice(rhsStart, end));
			}
		}
	}

	cache.set(key, out);
	return cloneDefaults(out);
}

type Loose = Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FakeSession = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FakeAgentService = any;

function cloneDefault(value: unknown): unknown {
	if (value instanceof Map) return new Map(value);
	if (value instanceof Set) return new Set(value);
	if (value instanceof WeakMap) return new WeakMap();
	if (value instanceof WeakSet) return new WeakSet();
	if (Array.isArray(value)) return [];
	if (value !== null && typeof value === "object") return {};
	return value;
}

function cloneDefaults(defaults: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(defaults)) out[key] = cloneDefault(value);
	return out;
}

function defineOwn(target: Loose, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function isPrototypeAccessor(proto: object, key: string): boolean {
	for (
		let cursor: object | null = proto;
		cursor && cursor !== Object.prototype;
		cursor = Object.getPrototypeOf(cursor)
	) {
		const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
		if (descriptor) return typeof descriptor.get === "function" || typeof descriptor.set === "function";
	}
	return false;
}

function isSafeDefault(value: unknown): boolean {
	return value instanceof Map || value instanceof WeakMap || value instanceof Set || value instanceof WeakSet;
}

function buildFake(proto: object, defaults: Record<string, unknown>, overrides: Loose): Loose {
	const target = Object.create(proto) as Loose;
	for (const [key, value] of Object.entries(defaults)) {
		if (!isSafeDefault(value)) continue;
		if (isPrototypeAccessor(proto, key)) continue;
		defineOwn(target, key, value);
	}
	for (const [key, value] of Object.entries(overrides)) defineOwn(target, key, value);
	return target;
}

export function fakeClientSession(overrides: Loose = {}): FakeSession {
	return buildFake(ClientSession.prototype, instanceFieldDefaults("ClientSession"), overrides) as FakeSession;
}

export function fakeAgentService(overrides: Loose = {}): FakeAgentService {
	return buildFake(AgentService.prototype, instanceFieldDefaults("AgentService"), overrides) as FakeAgentService;
}

export function protoMethod(proto: object, name: string): (...args: never[]) => unknown {
	return (proto as Loose)[name] as (...args: never[]) => unknown;
}
