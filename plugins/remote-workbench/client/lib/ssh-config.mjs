import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export function expandHome(value) {
	const s = String(value ?? "").trim();
	if (s === "~") return os.homedir();
	return /^~[/\\]/.test(s) ? path.join(os.homedir(), s.slice(2)) : s;
}

export function tokenizeConfig(line) {
	const tokens = [];
	let token = "",
		quote = "",
		escaped = false,
		started = false;
	for (let index = 0; index < line.length; index++) {
		const ch = line[index];
		if (escaped) {
			token += ch;
			escaped = false;
			started = true;
			continue;
		}
		if (ch === "\\" && /[\s#"'\\]/.test(line[index + 1] || "")) {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = "";
			else token += ch;
			started = true;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
			continue;
		}
		if (ch === "#") break;
		if (/\s/.test(ch) || (ch === "=" && (tokens.length === 0 || (tokens.length === 1 && !started)))) {
			if (started) {
				tokens.push(token);
				token = "";
				started = false;
			}
		} else {
			token += ch;
			started = true;
		}
	}
	if (escaped) token += "\\";
	if (started) tokens.push(token);
	return tokens;
}

function patternMatches(pattern, alias) {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i").test(alias);
}

export function parseSshConfig(text, { username = os.userInfo().username } = {}) {
	const blocks = [{ patterns: ["*"], directives: [] }];
	let current = blocks[0];
	const aliases = new Set();
	for (const raw of String(text ?? "").split(/\r?\n/)) {
		const [rawKey, ...values] = tokenizeConfig(raw);
		if (!rawKey || !values.length) continue;
		const key = rawKey.toLowerCase();
		if (key === "host") {
			current = { patterns: values, directives: [] };
			blocks.push(current);
			for (const alias of values) if (!/[*!?]/.test(alias)) aliases.add(alias);
		} else if (key === "match") {
			current = { patterns: [], directives: [["unsupported-match", values.join(" ")]] };
			blocks.push(current);
		} else current.directives.push([key, values.join(" ")]);
	}
	return [...aliases].map((alias) => {
		const resolved = new Map();
		const warnings = [];
		for (const block of blocks) {
			const positive = block.patterns.some((p) => !p.startsWith("!") && patternMatches(p, alias));
			const excluded = block.patterns.some((p) => p.startsWith("!") && patternMatches(p.slice(1), alias));
			if (!positive || excluded) continue;
			for (const [key, value] of block.directives) if (!resolved.has(key)) resolved.set(key, value);
		}
		for (const key of [
			"proxyjump",
			"proxycommand",
			"certificatefile",
			"identityagent",
			"include",
			"canonicalizehostname",
			"hostkeyalias",
		]) {
			const value = resolved.get(key)?.toLowerCase();
			if (value && value !== "none" && !(key === "canonicalizehostname" && value === "no"))
				warnings.push(`${key}: ${resolved.get(key)} (requires manual configuration; not imported)`);
		}
		if (blocks.some((b) => b.directives.some(([key]) => key === "unsupported-match")))
			warnings.push("Match blocks are not evaluated; verify connection settings manually");
		const rawPort = resolved.get("port") || "22";
		const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
		if (!Number.isInteger(port) || port < 1 || port > 65535) warnings.push(`Invalid port: ${rawPort}`);
		const replaceTokens = (value) =>
			value?.replace(
				/%%|%h|%n|%r|%d/g,
				(token) =>
					({
						"%%": "%",
						"%h": resolved.get("hostname") || alias,
						"%n": alias,
						"%r": resolved.get("user") || username,
						"%d": os.homedir(),
					})[token],
			);
		const privateKeyPath = replaceTokens(resolved.get("identityfile"));
		if (privateKeyPath && /%[A-Za-z]/.test(privateKeyPath))
			warnings.push("IdentityFile contains unsupported expansion tokens");
		return {
			alias,
			host: resolved.get("hostname") || alias,
			port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 22,
			username: resolved.get("user") || username,
			privateKeyPath: privateKeyPath && privateKeyPath !== "none" ? privateKeyPath : undefined,
			warnings,
			importable: warnings.length === 0,
		};
	});
}

export async function scanLocalSshConfig(configPath = path.join(os.homedir(), ".ssh", "config")) {
	const warnings = [];
	const stack = new Set();
	let bytes = 0,
		count = 0;
	async function expand(file, depth = 0) {
		const absolute = path.resolve(file);
		if (depth > 8 || count >= 64 || stack.has(absolute))
			throw new Error("SSH Include cycle or file/depth limit exceeded");
		stack.add(absolute);
		count++;
		try {
			const stat = await fs.stat(absolute);
			if (bytes + stat.size > 1024 * 1024) throw new Error("SSH config exceeds 1 MiB discovery limit");
			const content = await fs.readFile(absolute, "utf8");
			bytes += Buffer.byteLength(content);
			const output = [];
			for (const line of content.split(/\r?\n/)) {
				const [key, ...patterns] = tokenizeConfig(line);
				if (key?.toLowerCase() !== "include") {
					output.push(line);
					continue;
				}
				for (const pattern of patterns) {
					const expanded = expandHome(pattern);
					const target = path.isAbsolute(expanded) ? expanded : path.resolve(path.dirname(configPath), expanded);
					try {
						const dir = path.dirname(target),
							basename = path.basename(target);
						if (/[*?]/.test(dir)) throw new Error("Wildcards in Include directory components are unsupported");
						const files = /[*?]/.test(basename)
							? (await fs.readdir(dir))
									.filter((name) => patternMatches(basename, name))
									.sort()
									.map((name) => path.join(dir, name))
							: [target];
						for (const included of files) output.push(await expand(included, depth + 1));
					} catch (err) {
						warnings.push(`${pattern}: ${err.message}`);
						output.push(line);
					}
				}
			}
			return output.join("\n");
		} finally {
			stack.delete(absolute);
		}
	}
	try {
		const content = await expand(configPath);
		const list = parseSshConfig(content);
		if (warnings.length)
			for (const host of list) {
				host.warnings = [...(host.warnings || []), ...warnings];
				host.importable = false;
			}
		return { exists: true, path: configPath, list, warnings };
	} catch (err) {
		return { exists: err.code !== "ENOENT", path: configPath, list: [], warnings, error: err.message };
	}
}
