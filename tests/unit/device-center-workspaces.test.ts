import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateDeviceProject } from "../../server/device-center/workspaces.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "device-project-path-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const dataDir = join(dir, "data");
	const project = join(dir, "project");
	await Promise.all([mkdir(dataDir), mkdir(project)]);
	return { dir, dataDir, project };
}

describe("device project path validation", () => {
	it("returns a canonical existing directory and allows sibling names sharing the data prefix", async () => {
		const f = await fixture();
		expect(await validateDeviceProject(f.project, f.dataDir)).toBe(await realpath(f.project));
		const sibling = `${f.dataDir}-project`;
		await mkdir(sibling);
		expect(await validateDeviceProject(sibling, f.dataDir)).toBe(await realpath(sibling));
	});
	it("rejects relative, missing, non-directory, home, volume and data-ancestor roots", async () => {
		const f = await fixture();
		const file = join(f.dir, "file");
		await writeFile(file, "content");
		for (const path of [
			"",
			".",
			"relative",
			join(f.dir, "missing"),
			file,
			homedir(),
			parse(f.dir).root,
			f.dataDir,
			f.dir,
		]) {
			await expect(validateDeviceProject(path, f.dataDir)).rejects.toMatchObject({
				status: 400,
				code: "WORKSPACE_INVALID",
			});
		}
	});
	it("accepts SSH workspaces for directly reachable devices and normalizes them", async () => {
		const f = await fixture();
		expect(await validateDeviceProject("ssh://dev@192.168.1.10/home/dev/app/", f.dataDir)).toBe(
			"ssh://dev@192.168.1.10:22/home/dev/app",
		);
		expect(await validateDeviceProject("ssh://dev@example.com:2222//srv/app//", f.dataDir)).toBe(
			"ssh://dev@example.com:2222/srv/app",
		);
		for (const bad of [
			"ssh://",
			"ssh://bad-uri",
			"ssh://@host/path",
			"ssh:///path",
			"ssh://u@h:0/x",
			"ssh://u@h:99999/x",
		]) {
			await expect(validateDeviceProject(bad, f.dataDir)).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });
		}
	});
	it("rejects symbolic links in the selected directory and all ancestor segments", async () => {
		const f = await fixture();
		await mkdir(join(f.project, "child"));
		const link = join(f.dir, "link");
		await symlink(f.project, link, process.platform === "win32" ? "junction" : "dir");
		for (const path of [link, join(link, "child")]) {
			await expect(validateDeviceProject(path, f.dataDir)).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });
		}
	});
});
