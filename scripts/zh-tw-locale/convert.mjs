import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { OpenCC } from "./opencc.mjs";
import { extractPlaceholders } from "../lib/i18n-catalog.mjs";
const [zhPath, outPath, glossaryPath, manualPath] = process.argv.slice(2);
const zh = JSON.parse(readFileSync(zhPath, "utf8"));
const base = OpenCC.Converter({ from: "cn", to: "twp" });
const rules =
	glossaryPath && existsSync(glossaryPath)
		? await import(pathToFileURL(glossaryPath).href)
		: { pre: [], post: [], punct: [] };
const apply = (s, list) => {
	for (const [from, to] of list) s = typeof from === "string" ? s.split(from).join(to) : s.replace(from, to);
	return s;
};
const manual = manualPath && existsSync(manualPath) ? JSON.parse(readFileSync(manualPath, "utf8")) : {};
const out = {};
for (const [k, v] of Object.entries(zh)) {
	let r = apply(apply(base(apply(v, rules.pre)), rules.post), rules.punct);
	const m = manual[k];
	if (typeof m === "string") r = m;
	else if (Array.isArray(m))
		for (const [from, to] of m) {
			if (!r.includes(from)) throw new Error(`manual patch for ${k}: 找不到 ${JSON.stringify(from)}`);
			r = r.split(from).join(to);
		}
	if (JSON.stringify(extractPlaceholders(v)) !== JSON.stringify(extractPlaceholders(r))) {
		throw new Error(`convert/${k}: placeholder mismatch`);
	}
	out[k] = r;
}
writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(
	"converted:",
	Object.keys(out).length,
	"| manual overrides:",
	Object.keys(manual).length,
	"| glossary rules:",
	rules.post.length,
);
