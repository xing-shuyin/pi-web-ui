import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	acceptNativeCliEvent,
	createNativeCliBinding,
	NATIVE_CLI_STATE_ENTRY,
	persistNativeCliBinding,
	readNativeCliBinding,
} from "../../server/native-cli-state.js";

const config = { preset: "claude" } as const;
const cwd = "/project";

describe("native CLI durable identity", () => {
	it("restores the exact ID and resource ownership without persisting launch hooks or credentials", () => {
		const manager = SessionManager.inMemory(cwd);
		const binding = createNativeCliBinding(config, cwd);
		binding.nativeId = "01234567-0123-4567-89ab-0123456789ab";
		binding.stagingPaths = ["/tmp/pi-native-cli-12345678-1234-1234-1234-123456789abc"];
		acceptNativeCliEvent(binding, "turn-1");
		persistNativeCliBinding(manager, binding);
		expect(readNativeCliBinding(manager, config, cwd)).toEqual(binding);
		const count = manager.getEntries().length;
		persistNativeCliBinding(manager, binding);
		expect(manager.getEntries()).toHaveLength(count);
	});

	it.each([
		{ key: "not-a-uuid" },
		{ cwd: "/another-project" },
		{ preset: "codex" },
		{ nativeId: "id\n--last" },
		{ version: 2 },
		{ stagingPaths: ["/tmp/another-users-files"] },
		{ processId: "not-a-process-key" },
		{ seenEventIds: ["\x00event"] },
	])("rejects foreign or malformed metadata %#", (override) => {
		const manager = SessionManager.inMemory(cwd);
		manager.appendCustomEntry(NATIVE_CLI_STATE_ENTRY, { ...createNativeCliBinding(config, cwd), ...override });
		expect(() => readNativeCliBinding(manager, config, cwd)).toThrow("binding");
	});

	it("deduplicates replayed events and keeps synthetic process events out of the native spool cursor", () => {
		const binding = createNativeCliBinding(config, cwd);
		expect(acceptNativeCliEvent(binding, "official-hook-1")).toBe(true);
		expect(acceptNativeCliEvent(binding, "official-hook-1")).toBe(false);
		expect(acceptNativeCliEvent(binding, "process:run1:exit:2", false)).toBe(true);
		expect(binding.lastEventId).toBe("official-hook-1");
		for (let index = 0; index < 300; index++) acceptNativeCliEvent(binding, `event-${index}`);
		expect(binding.seenEventIds).toHaveLength(256);
		expect(binding.lastEventId).toBe("event-299");
	});
});
