#!/usr/bin/env node
/**
 * 从 `server/engine-service.ts` 的 `export interface DispatchSession` 生成 `packages/keel/src/adapters/wire/dispatch-surface.ts`：
 * 新树照这份清单逐个接入，接口改动后跑一次即可，禁止手抄成员名。
 * 用法：`node scripts/gen-core-dispatch-surface.mjs`（写文件）· `--check`（只校验现有文件是否过期）
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(root, "server", "engine-service.ts");
const TARGET = join(root, "packages", "keel", "src", "adapters", "wire", "dispatch-surface.ts");
const INTERFACE = "DispatchSession";
const HEADER = "// 生成物，勿手改：node scripts/gen-core-dispatch-surface.mjs";
const MODIFIERS = new Set(["readonly", "public", "private", "protected", "static", "override", "declare"]);
const IDENT = /[A-Za-z_$][\w$]*/y;

/** 把注释与字符串字面量抹成空格（保留偏移与换行），后面的括号配平就不会被 `{` `(` `;` 干扰。 */
function maskNonCode(text) {
	const out = text.split("");
	const blank = (from, to) => {
		for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
	};
	let i = 0;
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
					k += 1;
					break;
				}
				k += 1;
			}
			blank(i + 1, k - 1);
			i = k;
			continue;
		}
		i += 1;
	}
	return out.join("");
}

function findInterfaceBody(mask, name) {
	const at = new RegExp(`\\binterface\\s+${name}\\b`).exec(mask);
	if (!at) throw new Error(`找不到 interface ${name}`);
	const start = mask.indexOf("{", at.index);
	if (start === -1) throw new Error(`interface ${name} 没有花括号体`);
	let depth = 0;
	for (let i = start; i < mask.length; i++) {
		if (mask[i] === "{") depth += 1;
		else if (mask[i] === "}") {
			depth -= 1;
			if (depth === 0) return { start, end: i };
		}
	}
	throw new Error(`interface ${name} 的花括号不配平`);
}

function skipDeclaration(mask, from, end) {
	let depth = 0;
	for (let i = from; i < end; i++) {
		const ch = mask[i];
		if (ch === "(" || ch === "[" || ch === "{") depth += 1;
		else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
		else if (ch === ";" && depth === 0) return i + 1;
	}
	throw new Error(`interface 成员在偏移 ${from} 处没有以分号结尾`);
}

function parseMembers(mask, start, end) {
	const members = new Map();
	let i = start + 1;
	while (i < end) {
		if (/\s/.test(mask[i])) {
			i += 1;
			continue;
		}
		IDENT.lastIndex = i;
		const nameMatch = IDENT.exec(mask);
		if (!nameMatch) throw new Error(`成员名解析失败（偏移 ${i}）：${JSON.stringify(mask.slice(i, i + 40))}`);
		const name = nameMatch[0];
		i = IDENT.lastIndex;
		if (MODIFIERS.has(name)) continue;
		while (i < end && /\s/.test(mask[i])) i += 1;
		let optional = false;
		if (mask[i] === "?") {
			optional = true;
			i += 1;
			while (i < end && /\s/.test(mask[i])) i += 1;
		}
		if (mask[i] !== "(" && mask[i] !== ":" && mask[i] !== "<") {
			throw new Error(`成员 ${name} 后面不是 ( / : / <（偏移 ${i}）`);
		}
		if (!members.has(name)) members.set(name, optional);
		i = skipDeclaration(mask, i, end);
	}
	return [...members].map(([name, optional]) => ({ name, optional }));
}

function renderArray(name, items) {
	return [`export const ${name} = [`, ...items.map((item) => `\t${JSON.stringify(item)},`), "] as const;"].join("\n");
}

function render(members) {
	const names = members.map((member) => member.name);
	const optional = members.filter((member) => member.optional).map((member) => member.name);
	return [
		HEADER,
		"",
		renderArray("DISPATCH_SURFACE", names),
		"",
		"export type DispatchSessionMember = (typeof DISPATCH_SURFACE)[number];",
		"",
		renderArray("DISPATCH_OPTIONAL_MEMBERS", optional),
		"",
	].join("\n");
}

const mask = maskNonCode(readFileSync(SOURCE, "utf8"));
const body = findInterfaceBody(mask, INTERFACE);
const members = parseMembers(mask, body.start, body.end);
const content = render(members);
const summary = `${members.length} 个成员（其中 ${members.filter((member) => member.optional).length} 个可选）`;

if (process.argv.includes("--check")) {
	const current = readFileSync(TARGET, "utf8");
	if (current !== content) {
		console.error(
			"✗ packages/keel/src/adapters/wire/dispatch-surface.ts 已过期，请运行 node scripts/gen-core-dispatch-surface.mjs",
		);
		process.exit(1);
	}
	console.log(`✓ dispatch-surface.ts 与 interface ${INTERFACE} 一致：${summary}`);
} else {
	mkdirSync(dirname(TARGET), { recursive: true });
	writeFileSync(TARGET, content);
	console.log(`✓ 写入 ${TARGET}：${summary}`);
}
