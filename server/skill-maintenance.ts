import {
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	discoverDiskSkills,
	getMultiAgentSkillCandidateDirs,
	parseSkillFrontmatter,
	type DiscoveredSkill,
	type DiscoverSkillsOptions,
	type SkillAgentSource,
	type SkillScope,
} from "./skill-discovery.js";
import { decodeText } from "./text-sniff.js";

export interface UniversalSkillsScanResult {
	totalUnique: number;
	totalDiscovered: number;
	skills: DiscoveredSkill[];
	bySource: Record<SkillAgentSource, number>;
	byScope: Record<SkillScope, number>;
	conflicts: Array<{
		name: string;
		chosen: DiscoveredSkill;
		overridden: DiscoveredSkill[];
	}>;
	scannedDirs: string[];
}

export interface SkillHealthCheck {
	valid: boolean;
	filePath: string;
	sizeBytes: number;
	exceedsBudget: boolean;
	hasFrontmatter: boolean;
	name: string;
	description: string;
	issues: string[];
}

export interface SyncAgentSkillsOptions {
	cwd: string;
	targetDir?: string;
	mode?: "symlink" | "copy";
	sources?: SkillAgentSource[];
	dryRun?: boolean;
}

export function scanAllAgentSkills(opts: DiscoverSkillsOptions): UniversalSkillsScanResult {
	const allDirs = getMultiAgentSkillCandidateDirs(opts);
	const existingDirs = allDirs.filter((d) => existsSync(d.path)).map((d) => d.path);

	const primarySkills = discoverDiskSkills({ ...opts, includeConflicts: false });
	const allSkills = discoverDiskSkills({ ...opts, includeConflicts: true });

	const bySource: Record<SkillAgentSource, number> = {
		pi: 0,
		agents: 0,
		claude: 0,
		cursor: 0,
		windsurf: 0,
		github: 0,
		opencode: 0,
		cline: 0,
		roo: 0,
		npm: 0,
		"data-dir": 0,
		custom: 0,
	};

	const byScope: Record<SkillScope, number> = {
		project: 0,
		ancestor: 0,
		global: 0,
		package: 0,
	};

	for (const s of primarySkills) {
		if (s.source) bySource[s.source] = (bySource[s.source] || 0) + 1;
		if (s.scope) byScope[s.scope] = (byScope[s.scope] || 0) + 1;
	}

	const mapAll = new Map<string, DiscoveredSkill[]>();
	for (const s of allSkills) {
		const key = s.name.toLowerCase();
		const list = mapAll.get(key) ?? [];
		list.push(s);
		mapAll.set(key, list);
	}

	const conflicts: UniversalSkillsScanResult["conflicts"] = [];
	for (const chosen of primarySkills) {
		const key = chosen.name.toLowerCase();
		const allSameName = mapAll.get(key) || [];
		if (allSameName.length > 1) {
			const overridden = allSameName.filter((item) => item.filePath !== chosen.filePath);
			if (overridden.length > 0) {
				conflicts.push({
					name: chosen.name,
					chosen,
					overridden,
				});
			}
		}
	}

	return {
		totalUnique: primarySkills.length,
		totalDiscovered: allSkills.length,
		skills: primarySkills,
		bySource,
		byScope,
		conflicts,
		scannedDirs: existingDirs,
	};
}

export function generateSkillsReport(result: UniversalSkillsScanResult, lang: "zh" | "en" = "zh"): string {
	const isZh = lang === "zh";
	const lines: string[] = [];

	lines.push(isZh ? "=== 跨智能体全源技能扫描与维护报告 ===" : "=== Universal Multi-Agent Skills Report ===");
	lines.push(
		isZh
			? `整合唯一技能数: ${result.totalUnique} 个 (全源物理发现: ${result.totalDiscovered} 个, 扫描目录: ${result.scannedDirs.length} 处)`
			: `Total Unique Skills: ${result.totalUnique} (Discovered: ${result.totalDiscovered}, Scanned Dirs: ${result.scannedDirs.length})`,
	);
	lines.push("");

	lines.push(isZh ? "【各智能体生态分布】:" : "[Agent Distribution]:");
	for (const [source, count] of Object.entries(result.bySource)) {
		if (count > 0) {
			lines.push(`  - ${source.toUpperCase()}: ${count} skills`);
		}
	}
	lines.push("");

	lines.push(isZh ? "【作用域层级分布】:" : "[Scope Distribution]:");
	for (const [scope, count] of Object.entries(result.byScope)) {
		if (count > 0) {
			lines.push(`  - ${scope}: ${count} skills`);
		}
	}
	lines.push("");

	if (result.conflicts.length > 0) {
		lines.push(
			isZh
				? `【同名技能优先级决议 (${result.conflicts.length} 处)】:`
				: `[Skill Precedence Conflicts (${result.conflicts.length})]:`,
		);
		for (const c of result.conflicts) {
			lines.push(`  * ${c.name}:`);
			lines.push(`      [生效] [${c.chosen.source}/${c.chosen.scope}] ${c.chosen.filePath}`);
			for (const o of c.overridden) {
				lines.push(`      [覆盖] [${o.source}/${o.scope}] ${o.filePath}`);
			}
		}
		lines.push("");
	}

	lines.push(isZh ? "【整合生效技能清单】:" : "[Effective Skills Catalog]:");
	for (const s of result.skills) {
		const tag = `[${(s.source || "custom").toUpperCase()}|${s.scope || "global"}]`;
		lines.push(`  - ${s.name} ${tag}: ${s.description || "No description"} (${s.filePath})`);
	}

	return lines.join("\n");
}

export function verifySkillFile(filePath: string): SkillHealthCheck {
	const issues: string[] = [];
	if (!existsSync(filePath)) {
		return {
			valid: false,
			filePath,
			sizeBytes: 0,
			exceedsBudget: false,
			hasFrontmatter: false,
			name: basename(filePath, ".md"),
			description: "",
			issues: ["File does not exist"],
		};
	}

	let sizeBytes = 0;
	try {
		const st = statSync(filePath);
		sizeBytes = st.size;
	} catch {
		issues.push("Cannot read file metadata");
	}

	const exceedsBudget = sizeBytes > 8192;
	if (exceedsBudget) {
		issues.push(`File size (${sizeBytes} B) exceeds the 8KB skill budget limit`);
	}

	let raw = "";
	try {
		raw = decodeText(readFileSync(filePath));
	} catch {
		issues.push("Cannot decode file text");
	}

	const hasFrontmatter = raw.trim().startsWith("---");
	if (!hasFrontmatter) {
		issues.push("Missing YAML frontmatter (recommend adding --- name & description ---)");
	}

	const fallback =
		basename(filePath).toLowerCase() === "skill.md" ? basename(dirname(filePath)) : basename(filePath, ".md");
	const parsed = parseSkillFrontmatter(raw, fallback);
	if (!parsed.description || parsed.description === `Skill ${parsed.name}`) {
		issues.push("Missing informative description");
	}

	return {
		valid: issues.length === 0,
		filePath,
		sizeBytes,
		exceedsBudget,
		hasFrontmatter,
		name: parsed.name,
		description: parsed.description,
		issues,
	};
}

function isWithin(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function physicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		const parent = dirname(path);
		if (parent === path) throw err;
		return join(physicalPath(parent), basename(path));
	}
}

function destinationExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		return false;
	}
}

function copySkillDirectory(source: string, destination: string, root: string, ancestors = new Set<string>()): void {
	const physical = realpathSync(source);
	if (!isWithin(root, physical)) throw new Error("Skill resource escapes source directory");
	if (ancestors.has(physical)) throw new Error("Recursive skill resource link");
	const nextAncestors = new Set(ancestors).add(physical);
	for (const entry of readdirSync(source)) {
		const from = join(source, entry);
		const to = join(destination, entry);
		if (!isWithin(root, realpathSync(from))) throw new Error("Skill resource escapes source directory");
		const stat = statSync(from);
		if (stat.isDirectory()) {
			mkdirSync(to);
			copySkillDirectory(from, to, root, nextAncestors);
		} else if (stat.isFile()) {
			copyFileSync(from, to, constants.COPYFILE_EXCL);
		} else {
			throw new Error("Unsupported skill resource type");
		}
	}
}

export function syncAgentSkills(opts: SyncAgentSkillsOptions): {
	synced: Array<{ name: string; from: string; to: string }>;
	skipped: Array<{ name: string; reason: string }>;
} {
	const targetDir = resolve(opts.targetDir || join(opts.cwd, ".pi", "skills"));
	const mode = opts.mode || "copy";
	const dryRun = !!opts.dryRun;

	const scan = scanAllAgentSkills({ cwd: opts.cwd });
	const targetSources = opts.sources && opts.sources.length > 0 ? new Set(opts.sources) : null;

	const synced: Array<{ name: string; from: string; to: string }> = [];
	const skipped: Array<{ name: string; reason: string }> = [];

	for (const skill of scan.skills) {
		if (targetSources && skill.source && !targetSources.has(skill.source)) {
			continue;
		}

		if (
			!skill.name ||
			skill.name === "." ||
			skill.name === ".." ||
			/[<>:"/\\|?*\x00-\x1f]/.test(skill.name) ||
			/[. ]$/.test(skill.name)
		) {
			skipped.push({ name: skill.name, reason: "Invalid skill name" });
			continue;
		}

		if (isWithin(targetDir, resolve(skill.filePath))) {
			skipped.push({ name: skill.name, reason: "Already in target directory" });
			continue;
		}

		const isDirSkill = basename(skill.filePath).toLowerCase() === "skill.md";
		const destination = join(targetDir, isDirSkill ? skill.name : `${skill.name}.md`);
		const destPath = isDirSkill ? join(destination, "SKILL.md") : destination;
		let ownedDestination = false;
		try {
			const physicalTarget = physicalPath(targetDir);
			const source = realpathSync(isDirSkill ? dirname(skill.filePath) : skill.filePath);
			if (isWithin(physicalTarget, source)) {
				skipped.push({ name: skill.name, reason: "Already in target directory" });
				continue;
			}
			if (isDirSkill && isWithin(source, physicalTarget)) {
				skipped.push({ name: skill.name, reason: "Target directory is inside source skill" });
				continue;
			}
			if (destinationExists(destination)) {
				skipped.push({ name: skill.name, reason: "Destination already exists" });
				continue;
			}
			if (!dryRun) {
				mkdirSync(targetDir, { recursive: true });
				if (mode === "symlink") {
					symlinkSync(source, destination, isDirSkill ? (process.platform === "win32" ? "junction" : "dir") : "file");
				} else {
					if (isDirSkill) {
						mkdirSync(destination);
						ownedDestination = true;
						copySkillDirectory(source, destination, source);
					} else {
						const fd = openSync(destination, "wx");
						ownedDestination = true;
						try {
							writeFileSync(fd, readFileSync(source));
						} finally {
							closeSync(fd);
						}
					}
				}
			}
		} catch (err) {
			if (ownedDestination) rmSync(destination, { recursive: isDirSkill, force: true });
			skipped.push({ name: skill.name, reason: `FS Error: ${(err as Error).message}` });
			continue;
		}

		synced.push({ name: skill.name, from: skill.filePath, to: destPath });
	}

	return { synced, skipped };
}
