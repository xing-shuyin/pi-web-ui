import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { decodeText } from "./text-sniff.js";

export type SkillAgentSource =
	| "pi"
	| "agents"
	| "claude"
	| "cursor"
	| "windsurf"
	| "github"
	| "opencode"
	| "cline"
	| "roo"
	| "npm"
	| "data-dir"
	| "custom";

export type SkillScope = "project" | "ancestor" | "global" | "package";

export interface DiscoveredSkill {
	name: string;
	description: string;
	descriptionEn?: string;
	filePath: string;
	dirPath: string;
	source?: SkillAgentSource;
	scope?: SkillScope;
	depth?: number;
	disableModelInvocation?: boolean;
	allowedTools?: string[];
}

export interface SkillCandidateDir {
	path: string;
	source: SkillAgentSource;
	scope: SkillScope;
	depth: number;
}

export interface DiscoverSkillsOptions {
	cwd: string;
	agentDir?: string;
	homeDir?: string;
	includeHome?: boolean;
	workspaceRoots?: string[];
	scanAncestors?: boolean;
	maxAncestorDepth?: number;
	includeNpm?: boolean;
	dataDir?: string;
	includeConflicts?: boolean;
}

/** YAML 块标量标记（`>` / `|` 可带 `-` / `+` 尾缀），值本身不是描述文本。 */
const BLOCK_SCALAR_MARKER = /^[>|][-+]?$/;

export function parseSkillFrontmatter(
	content: string,
	fallbackName: string,
): {
	name: string;
	description: string;
	disableModelInvocation?: boolean;
	allowedTools?: string[];
} {
	const trimmed = content.trim();
	let name = fallbackName;
	let description = "";
	let disableModelInvocation = false;
	let allowedTools: string[] | undefined;

	if (trimmed.startsWith("---")) {
		const secondDash = trimmed.indexOf("\n---", 3);
		if (secondDash !== -1) {
			const header = trimmed.slice(3, secondDash);
			// YAML 块标量（`description: >` / `|` / `>-` / `|-`）的描述正文在后续缩进行里。
			// 块标记本身不是描述；未实现时会被当成字面量 ">"，目录里就只剩一个 ">"。
			let blockLines: string[] | null = null;
			for (const line of header.split("\n")) {
				if (blockLines) {
					if (/^[ \t]+\S/.test(line)) {
						blockLines.push(line.trim());
						continue;
					}
					if (!line.trim()) continue;
					description = blockLines.join(" ");
					blockLines = null;
				}
				const colon = line.indexOf(":");
				if (colon <= 0) continue;
				const key = line.slice(0, colon).trim().toLowerCase();
				let val = line.slice(colon + 1).trim();
				if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
					val = val.slice(1, -1);
				}
				if (key === "name" && val) {
					name = val;
				} else if (key === "description" && val) {
					if (BLOCK_SCALAR_MARKER.test(val)) {
						blockLines = [];
					} else {
						description = val;
					}
				} else if (key === "disable-model-invocation" || key === "disablemodelinvocation") {
					disableModelInvocation = val === "true" || val === "1" || val === "yes";
				} else if (key === "allowed-tools" || key === "allowedtools") {
					allowedTools = val
						.split(/[\s,]+/)
						.map((t) => t.trim())
						.filter(Boolean);
				}
			}
			if (blockLines && !description) description = blockLines.join(" ");
			if (!description || BLOCK_SCALAR_MARKER.test(description)) {
				const rest = trimmed.slice(secondDash + 4).trim();
				const firstLine = rest.split("\n").find((l) => l.trim() && !l.trim().startsWith("#"));
				if (firstLine) description = firstLine.trim();
			}
		}
	}

	if (!description) {
		const firstHeader = trimmed.split("\n").find((l) => l.trim().startsWith("#"));
		if (firstHeader) {
			description = firstHeader.replace(/^#+\s*/, "").trim();
		} else {
			description = `Skill ${name}`;
		}
	}

	return { name, description, disableModelInvocation, allowedTools };
}

export function resolveGlobalAgentDir(explicitAgentDir?: string): string {
	if (explicitAgentDir?.trim()) return explicitAgentDir.trim();
	if (process.env.PI_CODING_AGENT_DIR?.trim()) return process.env.PI_CODING_AGENT_DIR.trim();
	return join(homedir(), ".pi", "agent");
}

export function getMultiAgentSkillCandidateDirs(opts: DiscoverSkillsOptions): SkillCandidateDir[] {
	const dirs: SkillCandidateDir[] = [];
	const seenPaths = new Set<string>();

	const add = (p: string, source: SkillAgentSource, scope: SkillScope, depth = 0) => {
		const normalized = resolve(p);
		if (!seenPaths.has(normalized)) {
			seenPaths.add(normalized);
			dirs.push({ path: normalized, source, scope, depth });
		}
	};

	const cwd = opts.cwd ? resolve(opts.cwd) : "";
	const home = opts.homeDir ? resolve(opts.homeDir) : homedir();
	const agentDir = resolveGlobalAgentDir(opts.agentDir);

	const rootDirs = [cwd];
	if (Array.isArray(opts.workspaceRoots)) {
		for (const r of opts.workspaceRoots) {
			if (r && typeof r === "string") rootDirs.push(resolve(r));
		}
	}

	for (const r of rootDirs) {
		if (!r) continue;
		add(join(r, ".pi", "skills"), "pi", "project", 0);
		add(join(r, ".agents", "skills"), "agents", "project", 0);
		add(join(r, ".claude", "skills"), "claude", "project", 0);
		add(join(r, ".cursor", "skills"), "cursor", "project", 0);
		add(join(r, ".windsurf", "skills"), "windsurf", "project", 0);
		add(join(r, ".github", "skills"), "github", "project", 0);
		add(join(r, ".opencode", "skills"), "opencode", "project", 0);
	}

	if (cwd && opts.scanAncestors !== false) {
		const maxDepth = typeof opts.maxAncestorDepth === "number" ? opts.maxAncestorDepth : 6;
		let cur = dirname(cwd);
		for (let i = 1; i <= maxDepth && cur && cur !== dirname(cur); i++, cur = dirname(cur)) {
			if (cur === home) break;
			add(join(cur, ".pi", "skills"), "pi", "ancestor", i);
			add(join(cur, ".agents", "skills"), "agents", "ancestor", i);
			add(join(cur, ".claude", "skills"), "claude", "ancestor", i);
			add(join(cur, ".cursor", "skills"), "cursor", "ancestor", i);
			if (existsSync(join(cur, ".git"))) {
				break;
			}
		}
	}

	add(join(agentDir, "skills"), "pi", "global", 0);

	if (opts.includeHome !== false) {
		add(join(home, ".agents", "skills"), "agents", "global", 0);
		add(join(home, ".claude", "skills"), "claude", "global", 0);
		add(join(home, ".cursor", "skills"), "cursor", "global", 0);
		add(join(home, ".windsurf", "skills"), "windsurf", "global", 0);
		add(join(home, ".codeium", "windsurf", "skills"), "windsurf", "global", 0);
		add(join(home, ".config", "opencode", "skills"), "opencode", "global", 0);
		add(join(home, ".cline", "skills"), "cline", "global", 0);
		add(join(home, ".roo-code", "skills"), "roo", "global", 0);

		if (opts.dataDir) {
			add(join(opts.dataDir, "skills"), "data-dir", "global", 0);
		}
	}

	if (opts.includeNpm !== false) {
		const npmRoots: string[] = [join(agentDir, "npm", "node_modules")];
		if (cwd) {
			npmRoots.push(join(cwd, ".pi", "npm", "node_modules"));
		}
		for (const npmRoot of npmRoots) {
			if (!existsSync(npmRoot)) continue;
			try {
				const entries = readdirSync(npmRoot, { withFileTypes: true });
				for (const entry of entries) {
					if (!entry.isDirectory()) continue;
					if (!entry.name.startsWith("@")) {
						add(join(npmRoot, entry.name, "skills"), "npm", "package", 0);
					} else {
						try {
							const subEntries = readdirSync(join(npmRoot, entry.name), { withFileTypes: true });
							for (const sub of subEntries) {
								if (sub.isDirectory()) {
									add(join(npmRoot, entry.name, sub.name, "skills"), "npm", "package", 0);
								}
							}
						} catch {}
					}
				}
			} catch {}
		}
	}

	return dirs;
}

function getSkillPriorityScore(skill: DiscoveredSkill): number {
	let scopeScore = 0;
	if (skill.scope === "project") scopeScore = 1000;
	else if (skill.scope === "ancestor") scopeScore = 800 - Math.min(skill.depth ?? 1, 10) * 20;
	else if (skill.scope === "global") scopeScore = 500;
	else if (skill.scope === "package") scopeScore = 200;

	let sourceScore = 0;
	switch (skill.source) {
		case "pi":
			sourceScore = 90;
			break;
		case "agents":
			sourceScore = 80;
			break;
		case "claude":
			sourceScore = 70;
			break;
		case "cursor":
			sourceScore = 60;
			break;
		case "windsurf":
			sourceScore = 50;
			break;
		case "github":
			sourceScore = 40;
			break;
		case "opencode":
			sourceScore = 30;
			break;
		case "data-dir":
			sourceScore = 20;
			break;
		case "npm":
			sourceScore = 10;
			break;
		default:
			sourceScore = 5;
			break;
	}

	return scopeScore + sourceScore;
}

export function discoverDiskSkills(opts: DiscoverSkillsOptions): DiscoveredSkill[] {
	const candidateDirs = getMultiAgentSkillCandidateDirs(opts);
	const skillCandidates = new Map<string, DiscoveredSkill[]>();

	for (const candidate of candidateDirs) {
		if (!existsSync(candidate.path)) continue;
		try {
			const entries = readdirSync(candidate.path, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;

				if (entry.isDirectory()) {
					const skillMd = join(candidate.path, entry.name, "SKILL.md");
					if (existsSync(skillMd)) {
						try {
							const text = decodeText(readFileSync(skillMd));
							const parsed = parseSkillFrontmatter(text, entry.name);
							const item: DiscoveredSkill = {
								name: parsed.name,
								description: parsed.description,
								filePath: skillMd,
								dirPath: join(candidate.path, entry.name),
								source: candidate.source,
								scope: candidate.scope,
								depth: candidate.depth,
								disableModelInvocation: parsed.disableModelInvocation,
								allowedTools: parsed.allowedTools,
							};
							const key = parsed.name.toLowerCase();
							const list = skillCandidates.get(key) ?? [];
							list.push(item);
							skillCandidates.set(key, list);
						} catch {}
					} else {
						try {
							const subEntries = readdirSync(join(candidate.path, entry.name), { withFileTypes: true });
							for (const sub of subEntries) {
								if (!sub.isDirectory() || sub.name.startsWith(".")) continue;
								const nestedMd = join(candidate.path, entry.name, sub.name, "SKILL.md");
								if (existsSync(nestedMd)) {
									try {
										const text = decodeText(readFileSync(nestedMd));
										const parsed = parseSkillFrontmatter(text, sub.name);
										const item: DiscoveredSkill = {
											name: parsed.name,
											description: parsed.description,
											filePath: nestedMd,
											dirPath: join(candidate.path, entry.name, sub.name),
											source: candidate.source,
											scope: candidate.scope,
											depth: candidate.depth,
											disableModelInvocation: parsed.disableModelInvocation,
											allowedTools: parsed.allowedTools,
										};
										const key = parsed.name.toLowerCase();
										const list = skillCandidates.get(key) ?? [];
										list.push(item);
										skillCandidates.set(key, list);
									} catch {}
								}
							}
						} catch {}
					}
				} else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md") {
					const filePath = join(candidate.path, entry.name);
					const base = basename(entry.name, ".md");
					try {
						const text = decodeText(readFileSync(filePath));
						const parsed = parseSkillFrontmatter(text, base);
						const item: DiscoveredSkill = {
							name: parsed.name,
							description: parsed.description,
							filePath,
							dirPath: candidate.path,
							source: candidate.source,
							scope: candidate.scope,
							depth: candidate.depth,
							disableModelInvocation: parsed.disableModelInvocation,
							allowedTools: parsed.allowedTools,
						};
						const key = parsed.name.toLowerCase();
						const list = skillCandidates.get(key) ?? [];
						list.push(item);
						skillCandidates.set(key, list);
					} catch {}
				}
			}
		} catch {}
	}

	const results: DiscoveredSkill[] = [];
	for (const list of skillCandidates.values()) {
		if (list.length === 0) continue;
		list.sort((a, b) => getSkillPriorityScore(b) - getSkillPriorityScore(a));
		if (opts.includeConflicts) {
			results.push(...list);
		} else {
			results.push(list[0]);
		}
	}

	results.sort((a, b) => a.name.localeCompare(b.name));
	return results;
}

export function readSkillInstruction(filePath: string): string {
	if (!existsSync(filePath)) return "";
	try {
		const raw = decodeText(readFileSync(filePath)).trim();
		return raw;
	} catch {
		return "";
	}
}

export function mergeSkillCollections<T extends { name: string; description?: string; filePath?: string }>(
	existingSkills: T[],
	discoveredSkills: DiscoveredSkill[],
): T[] {
	const map = new Map<string, T>();

	for (const s of existingSkills) {
		map.set(s.name.toLowerCase(), { ...s });
	}

	for (const d of discoveredSkills) {
		const key = d.name.toLowerCase();
		const current = map.get(key);
		if (!current) {
			map.set(key, {
				name: d.name,
				description: d.description,
				filePath: d.filePath,
				source: d.source,
				scope: d.scope,
				disableModelInvocation: d.disableModelInvocation,
				allowedTools: d.allowedTools,
			} as unknown as T);
		} else if (!current.filePath && d.filePath) {
			current.filePath = d.filePath;
		}
	}

	return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function isSkillStillOnDisk(
	skillName: string,
	opts: { cwd: string; agentDir?: string; workspaceRoots?: string[] },
): boolean {
	const n = skillName.trim().toLowerCase();
	if (!n) return false;

	const candidateDirs = getMultiAgentSkillCandidateDirs({
		cwd: opts.cwd,
		agentDir: opts.agentDir,
		workspaceRoots: opts.workspaceRoots,
		scanAncestors: true,
		includeHome: true,
		includeNpm: true,
	});

	for (const candidate of candidateDirs) {
		if (!existsSync(candidate.path)) continue;
		const dirSkill = join(candidate.path, skillName, "SKILL.md");
		if (existsSync(dirSkill)) return true;
		const mdSkill = join(candidate.path, `${skillName}.md`);
		if (existsSync(mdSkill)) return true;
	}

	return false;
}
