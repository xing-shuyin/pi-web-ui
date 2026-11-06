import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClientStateStore, normalizePathKey } from "../../server/client-state.js";
import {
	buildRemoteWorkspacePersona,
	createRemoteSdkOperations,
	formatCwdForPrompt,
	mapResolvedPathToRemote,
	resolveRemoteWorkspacePath,
	resolveWorkspaceSessionDir,
	restoreWorkspaceUriFromSessionDir,
} from "../../server/remote-ssh-service.js";
import { isInsideWorkspaceRoots } from "../../server/tool-guards.js";
import {
	formatRemoteWorkspaceUri,
	isRemoteWorkspaceUri,
	parseRemoteWorkspaceUri,
} from "../../web/src/remote-ssh-client.js";

describe("Remote Workspace & SSH URI", () => {
	it("formats and parses remote workspace URIs accurately", () => {
		const uri = formatRemoteWorkspaceUri("ubuntu", "192.168.1.100", 22, "/data/projects/my-web-app");
		expect(uri).toBe("ssh://ubuntu@192.168.1.100:22/data/projects/my-web-app");
		expect(isRemoteWorkspaceUri(uri)).toBe(true);
		expect(isRemoteWorkspaceUri("/home/user/local-project")).toBe(false);

		const parsed = parseRemoteWorkspaceUri(uri);
		expect(parsed).not.toBeNull();
		expect(parsed?.username).toBe("ubuntu");
		expect(parsed?.host).toBe("192.168.1.100");
		expect(parsed?.port).toBe(22);
		expect(parsed?.remotePath).toBe("/data/projects/my-web-app");
	});

	it("normalizePathKey preserves remote ssh:// URIs without corrupting them into local paths", () => {
		const remoteUri = "ssh://root@10.0.0.1:2222/var/www/site";
		expect(normalizePathKey(remoteUri)).toBe(remoteUri);
	});

	it("ClientStateStore retains remote workspace in recent projects without being purged by fs.access", async () => {
		const testDir = path.join(
			os.tmpdir(),
			`pi-web-client-state-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await fs.mkdir(testDir, { recursive: true });

		try {
			const store = new ClientStateStore(path.join(testDir, "client-state.json"));
			const clientId = "client_test_remote";
			const remoteUri = "ssh://developer@192.168.50.2:22/home/developer/app";

			store.remember(clientId, remoteUri);

			const state = store.get(clientId);
			expect(state.lastCwd).toBe(remoteUri);

			const projects = await store.getRecentProjects(clientId);
			expect(projects.length).toBeGreaterThanOrEqual(1);
			expect(projects[0].path).toBe(remoteUri);
		} finally {
			await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("maps remote workspace session directories and resolves remote paths safely", async () => {
		const testDir = path.join(
			os.tmpdir(),
			`pi-web-remote-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await fs.mkdir(testDir, { recursive: true });
		try {
			const remoteUri = "ssh://root@198.51.100.10:22/project/game-share";
			const localSessionDir = resolveWorkspaceSessionDir(testDir, remoteUri);
			expect(localSessionDir).not.toBe(remoteUri);
			expect(restoreWorkspaceUriFromSessionDir(localSessionDir)).toBe(remoteUri);

			const localSubFile = path.join(localSessionDir, "src", "main.ts");
			expect(mapResolvedPathToRemote(localSubFile, localSessionDir, remoteUri)).toBe("/project/game-share/src/main.ts");
			expect(mapResolvedPathToRemote("/project/game-share/package.json", localSessionDir, remoteUri)).toBe(
				"/project/game-share/package.json",
			);

			expect(resolveRemoteWorkspacePath("/project/game-share", "src/index.ts")).toEqual({
				abs: "/project/game-share/src/index.ts",
				rel: "src/index.ts",
			});
			expect(resolveRemoteWorkspacePath("/project/game-share", "../../etc/passwd")).toBeNull();
			expect(isInsideWorkspaceRoots("src/index.ts", localSessionDir)).toBe(true);
			expect(isInsideWorkspaceRoots("/project/game-share/README.md", localSessionDir)).toBe(true);
			expect(isInsideWorkspaceRoots("/etc/passwd", localSessionDir)).toBe(false);

			const ops = createRemoteSdkOperations(localSessionDir);
			expect(ops).not.toBeNull();
			expect(ops?.remoteUri).toBe(remoteUri);

			expect(formatCwdForPrompt(localSessionDir)).toBe(
				"/project/game-share (remote SSH: ssh://root@198.51.100.10:22/project/game-share)",
			);
			const persona = buildRemoteWorkspacePersona(remoteUri);
			expect(persona).toContain("REMOTE SSH workspace");
			expect(persona).toContain("root@198.51.100.10:22");
			expect(persona).toContain("/project/game-share");
		} finally {
			await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
		}
	});
});
