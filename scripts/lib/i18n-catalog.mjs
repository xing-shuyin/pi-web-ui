/** Read the frontend message catalog without importing React or evaluating application code. */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const MESSAGES_DIR = "web/src/i18n/messages";
const LEGACY_FILE = "web/src/i18n.tsx";

/** Include repeated tokens, nested template tokens, and marker names (titles may be localized). */
export function extractPlaceholders(value) {
	return [...value.matchAll(/\$\{[\w$]+\}|\{\{[\w$]+\}\}|\{\$?[\w]+\}|\[\[[a-z_/-]+/g)].map((match) => match[0]).sort();
}

function asDictionary(value, file) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${file}: expected a flat message object`);
	for (const [key, text] of Object.entries(value)) {
		if (typeof text !== "string" || !text.length) throw new Error(`${file}: ${key} must be a nonempty string`);
	}
	return value;
}

function parseDictionary(source, file) {
	const dictionary = asDictionary(JSON.parse(source), file);
	// A flat string dictionary has alternating key/value string tokens. JSON.parse already checked syntax.
	const tokens = [...source.matchAll(/"(?:[^"\\]|\\.)*"/g)];
	const seen = new Set();
	for (let index = 0; index < tokens.length; index += 2) {
		const key = JSON.parse(tokens[index][0]);
		if (seen.has(key)) throw new Error(`${file}: duplicate key ${key}`);
		seen.add(key);
	}
	return dictionary;
}

/** Validate each translated module before merging; modules may not mask another module's mistakes. */
export function validateMessages(reference, translated, label, { checkOrder = true } = {}) {
	asDictionary(reference, `${label}/zh`);
	asDictionary(translated, label);
	const keys = Object.keys(reference);
	const translatedKeys = Object.keys(translated);
	const missing = keys.filter((key) => !Object.hasOwn(translated, key));
	const extra = translatedKeys.filter((key) => !Object.hasOwn(reference, key));
	if (missing.length || extra.length)
		throw new Error(`${label}: missing keys [${missing.join(", ")}]; extra keys [${extra.join(", ")}]`);
	if (checkOrder && keys.some((key, index) => translatedKeys[index] !== key))
		throw new Error(`${label}: key order differs from zh`);
	for (const key of keys) {
		if (JSON.stringify(extractPlaceholders(reference[key])) !== JSON.stringify(extractPlaceholders(translated[key]))) {
			throw new Error(`${label}: placeholder mismatch for ${key}`);
		}
	}
}

/**
 * @typedef {{order: string[], map: Map<string, string>}} LocaleMap
 * @typedef {{name: string, locales: Record<string, Record<string, string>>}} MessageModule
 * @typedef {{zh: LocaleMap, en: LocaleMap, modules: MessageModule[], translations: Map<string, Map<string, string>>}} Catalog
 */

/**
 * Historical single-file layout only: use a syntax tree, never execute TSX or guess braces with regex.
 * @returns {{zh: LocaleMap, en: LocaleMap}}
 */
export function parseLocaleMaps(source) {
	const { parsers } = createRequire(import.meta.url)("prettier/plugins/typescript");
	const tree = parsers.typescript.parse(source);
	const out = {};
	function text(node) {
		if (node.type === "Literal" && typeof node.value === "string") return node.value;
		if (node.type === "TemplateLiteral" && !node.expressions.length) return node.quasis[0].value.cooked;
		if (node.type === "BinaryExpression" && node.operator === "+") return text(node.left) + text(node.right);
		throw new Error("Historical messages must use static string literals");
	}
	for (const statement of tree.body) {
		const variable = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
		if (variable?.type !== "VariableDeclaration") continue;
		for (const declaration of variable.declarations) {
			const name = declaration.id.name;
			if (name !== "zh" && name !== "en") continue;
			let expression = declaration.init;
			while (expression && ["TSAsExpression", "TSSatisfiesExpression"].includes(expression.type))
				expression = expression.expression;
			if (expression?.type !== "ObjectExpression") throw new Error(`Historical ${name} is not an inline dictionary`);
			const map = new Map();
			for (const property of expression.properties) {
				if (property.type !== "Property" || property.computed || property.method)
					throw new Error(`Historical ${name} has a nonliteral property`);
				const key = property.key.name ?? property.key.value;
				if (map.has(key)) throw new Error(`Historical ${name}: duplicate key ${key}`);
				map.set(key, text(property.value));
			}
			out[name] = { order: [...map.keys()], map };
		}
	}
	if (!out.zh || !out.en) throw new Error("Historical i18n.tsx must declare zh and en");
	return out;
}

function git(repoRoot, args) {
	return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * core first, then module names in stable codepoint order; locale entries retain source order.
 * @param {{repoRoot?: string, ref?: string, includeTranslations?: boolean}} [options]
 * @returns {Catalog}
 */
export function readCatalog({ repoRoot = root, ref, includeTranslations = true } = {}) {
	const modulesPath = join(repoRoot, MESSAGES_DIR);
	let files;
	if (ref) {
		files = git(repoRoot, ["ls-tree", "-r", "--name-only", ref, "--", MESSAGES_DIR]).trim().split("\n").filter(Boolean);
	} else if (existsSync(modulesPath)) {
		files = readdirSync(modulesPath, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.flatMap((entry) =>
				readdirSync(join(modulesPath, entry.name))
					.filter((file) => file.endsWith(".json"))
					.map((file) => `${MESSAGES_DIR}/${entry.name}/${file}`),
			);
	} else {
		throw new Error(`Missing ${MESSAGES_DIR}; current catalogs must use module JSON sources`);
	}
	if (ref && !files.length) {
		let source;
		try {
			source = git(repoRoot, ["show", `${ref}:${LEGACY_FILE}`]);
		} catch {
			/* file did not exist at this ref */
		}
		const maps = source
			? parseLocaleMaps(source)
			: { zh: { order: [], map: new Map() }, en: { order: [], map: new Map() } };
		return { ...maps, modules: [], translations: new Map() };
	}
	const grouped = new Map();
	for (const file of files.sort()) {
		const match = /^web\/src\/i18n\/messages\/([^/]+)\/([^/]+)\.json$/.exec(file);
		if (!match) continue;
		const [, name, locale] = match;
		if (!includeTranslations && locale !== "zh" && locale !== "en") continue;
		if (!grouped.has(name)) grouped.set(name, {});
		const source = ref ? git(repoRoot, ["show", `${ref}:${file}`]) : readFileSync(join(repoRoot, file), "utf8");
		grouped.get(name)[locale] = parseDictionary(source, file);
	}
	if (!grouped.has("core")) throw new Error(`${MESSAGES_DIR}: missing core module`);
	const names = [...grouped.keys()].sort((a, b) =>
		a === b ? 0 : a === "core" ? -1 : b === "core" ? 1 : a < b ? -1 : 1,
	);
	const modules = [];
	const owners = new Map();
	const maps = { zh: new Map(), en: new Map() };
	const translations = new Map();
	for (const name of names) {
		const locales = grouped.get(name);
		if (!locales.zh || !locales.en) throw new Error(`${name}: missing zh/en module source`);
		for (const [locale, messages] of Object.entries(locales)) {
			if (locale !== "zh") validateMessages(locales.zh, messages, `${name}/${locale}`, { checkOrder: locale === "en" });
		}
		for (const key of Object.keys(locales.zh)) {
			if (owners.has(key)) throw new Error(`duplicate key ${key}: ${owners.get(key)} and ${name}`);
			owners.set(key, name);
			maps.zh.set(key, locales.zh[key]);
			maps.en.set(key, locales.en[key]);
		}
		for (const [locale, messages] of Object.entries(locales)) {
			if (locale === "zh" || locale === "en") continue;
			if (!translations.has(locale)) translations.set(locale, new Map());
			for (const key of Object.keys(locales.zh)) translations.get(locale).set(key, messages[key]);
		}
		modules.push({ name, locales });
	}
	return {
		zh: { order: [...maps.zh.keys()], map: maps.zh },
		en: { order: [...maps.en.keys()], map: maps.en },
		modules,
		translations,
	};
}
