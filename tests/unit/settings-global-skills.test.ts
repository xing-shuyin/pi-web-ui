import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ClientStateStore } from "../../server/client-state.js";
import { SettingsService, type SettingsHost } from "../../server/settings-service.js";
import { SubagentTemplatesStore } from "../../server/subagent-templates.js";
import type { ServerMessage } from "../../server/protocol.js";
import * as skillDiscovery from "../../server/skill-discovery.js";

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: vi.fn(actual.homedir) };
});

let dir: string;
let home: string;
let cwd: string;
let store: ClientStateStore;
let emitted: ServerMessage[];
const skillName = "global-test-skill";

function makeService(overrides: Partial<SettingsHost> = {}): SettingsService {
	const host: SettingsHost = {
		clientId: "test-client",
		stateStore: store,
		emit: (msg) => void emitted.push(msg),
		flushSnapshot: () => {},
		isDisposed: () => false,
		getSession: () =>
			({
				resourceLoader: {
					getSkills: () => ({ skills: [] }),
					getExtensions: () => ({ extensions: [] }),
				},
			}) as never,
		cwd: () => cwd,
		agentDir: () => join(dir, "agent"),
		isStreaming: () => false,
		reloadSession: async () => {},
		applyRetryOverrides: () => {},
		applyCompactionOverrides: () => {},
		applyToolGating: () => {},
		promptSnapshot: () => ({ full: "", texts: {}, toolsSchema: "" }),
		...overrides,
	};
	return new SettingsService(host, new SubagentTemplatesStore(join(dir, "templates.json")));
}

function installSkill(format: "directory" | "markdown" = "directory") {
	const base = join(home, ".agents", "skills");
	const file = format === "directory" ? join(base, skillName, "SKILL.md") : join(base, `${skillName}.md`);
	mkdirSync(format === "directory" ? join(base, skillName) : base, { recursive: true });
	writeFileSync(file, `---\nname: ${skillName}\ndescription: Test skill\n---\nTest instructions.\n`);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "settings-global-skills-"));
	home = join(dir, "home");
	cwd = join(dir, "outside-home");
	mkdirSync(cwd, { recursive: true });
	vi.stubEnv("HOME", home);
	vi.mocked(homedir).mockReturnValue(home);
	store = new ClientStateStore(join(dir, "client-state.json"));
	emitted = [];
	store.saveSettings("test-client", {
		disabledSkills: [skillName],
		reviewDisabledSkills: [skillName],
		skillsFullText: [skillName],
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.mocked(homedir).mockReset();
	rmSync(dir, { recursive: true, force: true });
});

describe("global .agents/skills settings (issue #669)", () => {
	it("does not reload for disk skills excluded by the execution capability", () => {
		installSkill();
		store.saveSettings("test-client", { disabledSkills: [], reviewDisabledSkills: [] });
		const reload = vi.fn(async () => {});
		const svc = makeService({ filterDiskSkills: () => [], reloadSession: reload });
		svc.refreshResources();
		svc.refreshResources();
		expect(reload).not.toHaveBeenCalled();
		const state = emitted.filter((msg) => msg.type === "settings_state").at(-1);
		expect(state?.settings.skills.some((skill) => skill.name === skillName)).toBe(false);
	});

	it("does not reload or notify for disabled disk skills across settings pushes", () => {
		installSkill();
		const reload = vi.fn(async () => {});
		const svc = makeService({
			reloadSession: reload,
			filterDiskSkills: (skills) => skills.filter((skill) => skill.name === skillName),
		});
		svc.refreshResources();
		svc.refreshResources();
		expect(reload).not.toHaveBeenCalled();
		expect(emitted.filter((msg) => msg.type === "notice")).toEqual([]);
	});

	it("discovers enabled disk skills without reloading or notifying", () => {
		installSkill();
		store.saveSettings("test-client", { disabledSkills: [] });
		const reload = vi.fn(async () => {});
		const svc = makeService({ reloadSession: reload });
		svc.refreshResources();
		expect(reload).not.toHaveBeenCalled();
		expect(emitted.filter((msg) => msg.type === "notice")).toEqual([]);
		const state = emitted.filter((msg) => msg.type === "settings_state").at(-1);
		expect(state?.settings.skills).toContainEqual(expect.objectContaining({ name: skillName }));
	});

	it("ordinary state pushes do not discover, save preferences, or reload", () => {
		installSkill();
		const filter = vi.fn((skills) => skills);
		const reload = vi.fn(async () => {});
		const save = vi.spyOn(store, "saveSettings");
		const discover = vi.spyOn(skillDiscovery, "discoverDiskSkills");
		const svc = makeService({ filterDiskSkills: filter, reloadSession: reload });
		svc.push();
		svc.push();
		expect(filter).not.toHaveBeenCalled();
		expect(discover).not.toHaveBeenCalled();
		discover.mockRestore();
		expect(save).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
		expect(emitted.filter((msg) => msg.type === "notice")).toEqual([]);
		expect(svc.current.disabledSkills).toEqual([skillName]);
	});

	it("does not carry a discovered project catalog into another project", () => {
		const base = join(cwd, ".agents", "skills", "project-only");
		mkdirSync(base, { recursive: true });
		writeFileSync(join(base, "SKILL.md"), "---\nname: project-only\ndescription: Project skill\n---\nBody");
		const svc = makeService();
		svc.refreshResources();
		let state = emitted.filter((msg) => msg.type === "settings_state").at(-1);
		expect(state?.settings.skills.some((skill) => skill.name === "project-only")).toBe(true);
		cwd = join(dir, "another-project");
		mkdirSync(cwd, { recursive: true });
		svc.push();
		state = emitted.filter((msg) => msg.type === "settings_state").at(-1);
		expect(state?.settings.skills.some((skill) => skill.name === "project-only")).toBe(false);
	});

	it("does not discover skills or start reloads after disposal", () => {
		installSkill();
		const filter = vi.fn((skills) => skills);
		const reload = vi.fn(async () => {});
		const svc = makeService({ filterDiskSkills: filter, reloadSession: reload });
		svc.dispose();
		svc.refreshResources();
		expect(filter).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
		expect(emitted).toEqual([]);
	});
	it.each([
		["outside home", "directory"],
		["outside home", "markdown"],
		["deep under home", "directory"],
		["deep under home", "markdown"],
	] as const)("preserves disabled %s skills in %s format across settings pushes", (location, format) => {
		if (location === "deep under home") {
			cwd = join(home, "a", "b", "c", "d", "e", "f", "g", "project");
			mkdirSync(cwd, { recursive: true });
		}
		installSkill(format);
		// Also exercise a cleanup write without losing the existing global skill.
		store.saveSettings("test-client", {
			disabledSkills: [skillName, "deleted-test-skill"],
		});
		const updated = makeService();
		updated.refreshResources();
		updated.refreshResources();
		expect(updated.current.disabledSkills).toEqual([skillName]);
		expect(updated.current.reviewDisabledSkills).toEqual([skillName]);
		expect(updated.current.skillsFullText).toEqual([skillName]);
		const saved = new ClientStateStore(join(dir, "client-state.json")).getSettings("test-client");
		expect(saved.disabledSkills).toEqual([skillName]);
		expect(saved.reviewDisabledSkills).toEqual([skillName]);
		expect(saved.skillsFullText).toEqual([skillName]);
		const state = emitted.filter((msg) => msg.type === "settings_state").at(-1);
		expect(state?.settings.skills).toContainEqual(expect.objectContaining({ name: skillName, enabled: false }));
		expect(state?.settings.reviewSkills).toContainEqual(expect.objectContaining({ name: skillName, enabled: false }));
	});

	it("falls back to homedir when HOME is unset", () => {
		vi.stubEnv("HOME", undefined);
		installSkill();
		const svc = makeService();
		svc.refreshResources();
		expect(svc.current.disabledSkills).toEqual([skillName]);
		expect(svc.current.reviewDisabledSkills).toEqual([skillName]);
		expect(svc.current.skillsFullText).toEqual([skillName]);
	});

	it("prunes a deleted disabled skill from a previously discovered catalog", () => {
		installSkill();
		const svc = makeService();
		svc.refreshResources();
		rmSync(join(home, ".agents", "skills", skillName), { recursive: true });
		svc.refreshResources();
		expect(svc.current.disabledSkills).toEqual([]);
		expect(svc.current.reviewDisabledSkills).toEqual([]);
		expect(svc.current.skillsFullText).toEqual([]);
		const state = emitted.filter((msg) => msg.type === "settings_state").at(-1);
		expect(state?.settings.skills.some((skill) => skill.name === skillName)).toBe(false);
	});

	it("still prunes settings for a skill that no longer exists", () => {
		const svc = makeService();
		svc.refreshResources();
		expect(svc.current.disabledSkills).toEqual([]);
		expect(svc.current.reviewDisabledSkills).toEqual([]);
		expect(svc.current.skillsFullText).toEqual([]);
		const saved = new ClientStateStore(join(dir, "client-state.json")).getSettings("test-client");
		expect(saved.disabledSkills).toEqual([]);
		expect(saved.reviewDisabledSkills).toEqual([]);
		expect(saved.skillsFullText).toEqual([]);
	});

	it("dynamically discovers external newly-installed skills on disk even if loader hasn't reloaded", () => {
		const svc = makeService();
		svc.refreshResources();
		let state = emitted.filter((msg) => msg.type === "settings_state").at(-1);
		expect(state?.settings.skills.some((s: any) => s.name === "newly-installed")).toBe(false);

		const base = join(home, ".agents", "skills", "newly-installed");
		mkdirSync(base, { recursive: true });
		writeFileSync(join(base, "SKILL.md"), `---\nname: newly-installed\ndescription: Dynamically installed\n---\nBody`);

		svc.refreshResources();
		state = emitted.filter((msg) => msg.type === "settings_state").at(-1);
		expect(state?.settings.skills.some((s: any) => s.name === "newly-installed")).toBe(true);
	});
});
