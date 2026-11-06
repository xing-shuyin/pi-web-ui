import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const SCAN_EXT = [".mjs", ".js"];
const SKIP_DIRS = new Set(["node_modules", ".git"]);

const SPEC_PATTERNS = [
	/(?:^|[\s;{}()])import\s+[^;'"`]*?from\s*["'](S\d+)["']/g,
	/(?:^|[\s;{}()])export\s+[^;'"`]*?from\s*["'](S\d+)["']/g,
	/(?:^|[\s;{}()])import\s*["'](S\d+)["']/g,
	/(?:^|[\s;{}()])import\s*\(\s*["'](S\d+)["']/g,
];

function skeletonize(src) {
	const out = [];
	const literals = [];
	let mode = "code";
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (mode === "code") {
			if (c === "/" && src[i + 1] === "/") {
				mode = "line";
				out.push(" ", " ");
				i += 2;
				continue;
			}
			if (c === "/" && src[i + 1] === "*") {
				mode = "block";
				out.push(" ", " ");
				i += 2;
				continue;
			}
			if (c === '"' || c === "'" || c === "`") {
				let j = i + 1;
				let buf = "";
				while (j < src.length) {
					if (src[j] === "\\") {
						buf += src[j + 1] ?? "";
						j += 2;
						continue;
					}
					if (src[j] === c) break;
					buf += src[j];
					j++;
				}
				const id = literals.push(buf) - 1;
				out.push(c, `S${id}`, c);
				i = j + 1;
				continue;
			}
			out.push(c);
			i++;
			continue;
		}
		if (mode === "line") {
			if (c === "\n") {
				mode = "code";
				out.push("\n");
			} else out.push(" ");
			i++;
			continue;
		}
		if (c === "*" && src[i + 1] === "/") {
			mode = "code";
			out.push(" ", " ");
			i += 2;
			continue;
		}
		out.push(c === "\n" ? "\n" : " ");
		i++;
	}
	return { skeleton: out.join(""), literals };
}

export function staticImportSpecifiers(src) {
	const { skeleton, literals } = skeletonize(src);
	const out = [];
	const seen = new Set();
	for (const re of SPEC_PATTERNS) {
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(skeleton)) !== null) {
			const spec = literals[Number(m[1].slice(1))];
			if (spec === undefined || spec === "" || seen.has(spec)) continue;
			seen.add(spec);
			out.push(spec);
		}
	}
	return out;
}

export function listPluginModules(root) {
	const out = [];
	const walk = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
				continue;
			}
			if (e.isFile() && SCAN_EXT.some((ext) => e.name.endsWith(ext)))
				out.push(relative(root, join(dir, e.name)).split(sep).join("/"));
		}
	};
	walk(root);
	return out.sort();
}

function isRelativeSpec(spec) {
	return spec.startsWith("./") || spec.startsWith("../");
}

export function scanPluginImports(root) {
	const clientRoot = resolve(root, "client");
	const rows = [];
	for (const file of listPluginModules(root)) {
		let src;
		try {
			src = readFileSync(join(root, file), "utf8");
		} catch {
			continue;
		}
		const absFile = resolve(root, file);
		const isClient = absFile === clientRoot || absFile.startsWith(clientRoot + sep);
		for (const spec of staticImportSpecifiers(src)) {
			if (!isRelativeSpec(spec)) continue;
			const abs = resolve(resolve(absFile, ".."), spec.replace(/[?#].*$/, ""));
			let missing = true;
			try {
				missing = !statSync(abs).isFile();
			} catch {
				missing = true;
			}
			rows.push({
				file,
				spec,
				target: relative(root, abs).split(sep).join("/"),
				missing,
				client: isClient,
				escapesClient: isClient && abs !== clientRoot && !abs.startsWith(clientRoot + sep),
			});
		}
	}
	return rows;
}

export function checkPluginImports(root) {
	const scanned = listPluginModules(root);
	const problems = [];
	for (const row of scanPluginImports(root)) {
		if (row.escapesClient)
			problems.push({ kind: "escapes-client", file: row.file, spec: row.spec, target: row.target });
		else if (row.missing) problems.push({ kind: "missing", file: row.file, spec: row.spec, target: row.target });
	}
	const rank = (p) => (p.kind === "escapes-client" ? 0 : 1);
	return { scanned, problems: problems.sort((a, b) => rank(a) - rank(b)) };
}
