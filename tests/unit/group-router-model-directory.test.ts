import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createGroupRouterModelDirectory } from "../../server/group-router-models.js";

const dirs: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("validates router models against its execution registry even when a browser client has a different catalog", async () => {
	const dir = await mkdtemp(join(tmpdir(), "router-directory-"));
	dirs.push(dir);
	const runtime = {
		refresh: vi.fn(async () => ({})),
		getAvailable: vi.fn(async () => [
			{ provider: "independent", id: "model", name: "Independent", reasoning: true, input: ["text"] },
		]),
	};
	const createSpy = vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime as any);
	const directory = createGroupRouterModelDirectory(() => dir);
	const signal = new AbortController().signal;
	const models = await directory.listGroupRouterModels(signal);
	expect(createSpy).toHaveBeenCalledWith({
		authPath: join(dir, "auth.json"),
		modelsPath: join(dir, "models.json"),
	});
	expect(runtime.refresh).toHaveBeenCalledWith({ allowNetwork: false, signal });
	expect(models).toEqual([
		{ provider: "independent", id: "independent/model", name: "Independent", reasoning: true, vision: false },
	]);
});
