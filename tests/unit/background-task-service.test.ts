import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchSession } from "../../server/engine-service.js";
import type { ServerMessage } from "../../server/protocol.js";

const h = vi.hoisted(() => ({
	starts: [] as any[],
	listed: [] as any[],
	snapshot: undefined as any,
	killed: [] as string[],
	killAndWait: [] as string[],
	killAll: 0,
	disposed: 0,
	registries: [] as any[],
}));

vi.mock("../../server/job-runner.js", () => ({
	JOB_TASK_PREFIX: "job:",
	JobRegistry: class {
		constructor(public options: any) {
			h.registries.push(this);
		}
		start(spec: any) {
			h.starts.push(spec);
			return { id: `j${h.starts.length}`, ...spec };
		}
		list() {
			return h.listed;
		}
		get(id: string) {
			return id === h.snapshot?.id ? h.snapshot : undefined;
		}
		kill(id: string) {
			h.killed.push(id);
			return true;
		}
		killAndWait(id: string) {
			h.killAndWait.push(id);
			return Promise.resolve({ ok: true, exited: true, timedOut: false });
		}
		killAll() {
			h.killAll++;
			return ["j1"];
		}
		dispose() {
			h.disposed++;
		}
	},
}));

import {
	BackgroundTaskService,
	backgroundJobRow,
	handleHostBackgroundTaskMessage,
} from "../../server/background-task-service.js";

function fakeSession(cwd: string, conversationId = "conv-1"): DispatchSession {
	return {
		cwd,
		activeConversationId: () => conversationId,
		listBgServers: vi.fn(async () => {}),
		emitNotice: vi.fn(),
	} as unknown as DispatchSession;
}

let dir: string;
let session: DispatchSession;
let service: BackgroundTaskService;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-bg-host-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite", build: "tsc" } }));
	session = fakeSession(dir);
	service = new BackgroundTaskService({ dataDir: dir, getSession: () => session });
	h.starts.length = 0;
	h.listed.length = 0;
	h.snapshot = undefined;
	h.killed.length = 0;
	h.killAndWait.length = 0;
	h.killAll = 0;
	h.disposed = 0;
	h.registries.length = 0;
});

afterEach(() => {
	service.disposeAll();
	rmSync(dir, { recursive: true, force: true });
});

describe("引擎无关的后台任务宿主服务", () => {
	it("切引擎只换会话，不换 JobRegistry；job 行仍由同一个服务提供", () => {
		const piRegistry = service.registryFor("client-1");
		session = fakeSession(dir, "conv-codex");
		const codexRegistry = service.registryFor("client-1");
		expect(codexRegistry).toBe(piRegistry);
		h.listed = [
			{
				id: "j1",
				pid: 42,
				command: "npm run dev",
				label: "dev",
				cwd: dir,
				origin: "conv-1",
				since: 1,
				logPath: "/tmp/j1.log",
				state: "running",
				exitCode: null,
			},
		];
		expect(service.rows("client-1")).toEqual([
			expect.objectContaining({ taskId: "job:j1", kind: "job", command: "npm run dev", origin: "conv-1" }),
		]);
	});

	it("project_scripts / start_bg_script 由宿主直接处理，不依赖任何引擎可选方法", () => {
		const sent: ServerMessage[] = [];
		expect(
			handleHostBackgroundTaskMessage({ type: "project_scripts" }, "client-1", (msg) => sent.push(msg), service),
		).toBe(true);
		expect(sent.at(-1)).toEqual({ type: "project_scripts", cwd: dir, scripts: { dev: "vite", build: "tsc" } });

		expect(
			handleHostBackgroundTaskMessage({ type: "start_bg_script", script: "dev" }, "client-1", () => {}, service),
		).toBe(true);
		expect(h.starts.at(-1)).toEqual({
			command: "npm run dev",
			cwd: dir,
			label: "dev",
			origin: "conv-1",
		});
	});

	it("job 停止/重启/全部停止都命中共享注册表", async () => {
		h.snapshot = {
			id: "j1",
			pid: 42,
			command: "npm run dev",
			label: "dev",
			cwd: dir,
			origin: "conv-1",
			since: 1,
			logPath: "/tmp/j1.log",
			state: "running",
			exitCode: null,
		};
		expect(
			handleHostBackgroundTaskMessage(
				{ type: "kill_background_server", taskId: "job:j1" },
				"client-1",
				() => {},
				service,
			),
		).toBe(true);
		await vi.waitFor(() => expect(h.killAndWait).toEqual(["j1"]));

		handleHostBackgroundTaskMessage({ type: "restart_bg_job", taskId: "job:j1" }, "client-1", () => {}, service);
		expect(h.killed).toEqual(["j1"]);
		expect(h.starts.at(-1)).toEqual(
			expect.objectContaining({ command: "npm run dev", cwd: dir, label: "dev", origin: "conv-1" }),
		);
		expect(service.killAllJobs("client-1")).toEqual(["j1"]);
		expect(h.killAll).toBe(1);
	});

	it("非 job 停止请求交回引擎端口追踪器", () => {
		expect(
			handleHostBackgroundTaskMessage({ type: "kill_background_server", port: 5173 }, "client-1", () => {}, service),
		).toBe(false);
	});

	it("job 行形状只有一份实现", () => {
		expect(
			backgroundJobRow({
				id: "j1",
				pid: 42,
				command: "npm run dev",
				label: "dev",
				cwd: dir,
				since: 1,
				logPath: "/tmp/j1.log",
				state: "running",
				exitCode: null,
			}),
		).toEqual({
			kind: "job",
			taskId: "job:j1",
			pid: 42,
			since: 1,
			name: "dev",
			command: "npm run dev",
			status: "running",
			logPath: "/tmp/j1.log",
		});
	});
});
