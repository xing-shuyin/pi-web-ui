import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentService } from "../../server/agent-service-daemon.js";

const dirs: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("validates router models against its execution registry even when a browser client has a different catalog", async () => {
	const dir = await mkdtemp(join(tmpdir(), "router-directory-"));
	dirs.push(dir);
	const service = new AgentService(dir, join(dir, "state.json"));
	const active = vi.spyOn(service, "pluginClient").mockImplementation(() => {
		throw new Error("Router must not consult the active browser catalog");
	});
	const runtime = {
		refresh: vi.fn(async () => ({})),
		getAvailable: vi.fn(async () => [
			{ provider: "independent", id: "model", name: "Independent", reasoning: true, input: ["text"] },
		]),
	};
	vi.spyOn(service, "getGroupRouterModelRuntime").mockResolvedValue(runtime as any);
	const signal = new AbortController().signal;
	const models = await service.listGroupRouterModels(signal);
	expect(active).not.toHaveBeenCalled();
	expect(runtime.refresh).toHaveBeenCalledWith({ allowNetwork: false, signal });
	expect(models).toEqual([
		{ provider: "independent", id: "independent/model", name: "Independent", reasoning: true, vision: false },
	]);
});
