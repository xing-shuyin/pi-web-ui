import { randomUUID } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { NativeCliConfig, NativeCliStatus } from "./protocol.js";
import { normalizePathKey } from "./client-state.js";

export const NATIVE_CLI_STATE_ENTRY = "webui/native-cli-state";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

export interface NativeCliBinding {
	version: 1;
	key: string;
	preset: NativeCliConfig["preset"];
	cwd: string;
	nativeId?: string;
	processId?: string;
	lastEventId?: string;
	seenEventIds: string[];
	stagingPaths?: string[];
	status?: NativeCliStatus;
}

export function isNativeCliStagingPath(value: unknown): value is string {
	return typeof value === "string" && /^\/tmp\/pi-native-cli-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
}

function identifier(value: unknown, max = 4096): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !CONTROL.test(value);
}

export function createNativeCliBinding(config: NativeCliConfig, cwd: string): NativeCliBinding {
	return { version: 1, key: randomUUID(), preset: config.preset, cwd, seenEventIds: [] };
}

export function readNativeCliBinding(
	manager: Pick<SessionManager, "getEntries">,
	config: NativeCliConfig,
	cwd: string,
): NativeCliBinding | undefined {
	const entry = [...manager.getEntries()]
		.reverse()
		.find((item) => item.type === "custom" && item.customType === NATIVE_CLI_STATE_ENTRY);
	if (!entry || entry.type !== "custom") return undefined;
	const value = entry.data as Partial<NativeCliBinding> | null;
	if (
		!value ||
		value.version !== 1 ||
		!identifier(value.key, 36) ||
		!UUID.test(value.key) ||
		value.preset !== config.preset ||
		!identifier(value.cwd) ||
		normalizePathKey(value.cwd) !== normalizePathKey(cwd) ||
		(value.nativeId !== undefined && !identifier(value.nativeId)) ||
		(value.processId !== undefined && (typeof value.processId !== "string" || !UUID.test(value.processId))) ||
		(value.lastEventId !== undefined && !identifier(value.lastEventId, 512)) ||
		!Array.isArray(value.seenEventIds) ||
		value.seenEventIds.length > 256 ||
		!value.seenEventIds.every((id) => identifier(id, 512)) ||
		(value.stagingPaths !== undefined &&
			(!Array.isArray(value.stagingPaths) ||
				value.stagingPaths.length > 2048 ||
				!value.stagingPaths.every(isNativeCliStagingPath)))
	)
		throw new Error("Invalid native CLI session binding or workspace mismatch");
	return {
		version: 1,
		key: value.key,
		preset: config.preset,
		cwd,
		...(value.nativeId ? { nativeId: value.nativeId } : {}),
		...(value.processId ? { processId: value.processId } : {}),
		...(value.lastEventId ? { lastEventId: value.lastEventId } : {}),
		seenEventIds: [...value.seenEventIds],
		...(value.stagingPaths?.length ? { stagingPaths: [...value.stagingPaths] } : {}),
	};
}

export function persistNativeCliBinding(manager: SessionManager, binding: NativeCliBinding): void {
	const data = {
		version: 1,
		key: binding.key,
		preset: binding.preset,
		cwd: binding.cwd,
		...(binding.nativeId ? { nativeId: binding.nativeId } : {}),
		...(binding.processId ? { processId: binding.processId } : {}),
		...(binding.lastEventId ? { lastEventId: binding.lastEventId } : {}),
		seenEventIds: binding.seenEventIds.slice(-256),
		...(binding.stagingPaths?.length ? { stagingPaths: [...binding.stagingPaths] } : {}),
	};
	const previous = [...manager.getEntries()]
		.reverse()
		.find((entry) => entry.type === "custom" && entry.customType === NATIVE_CLI_STATE_ENTRY);
	if (previous?.type === "custom" && JSON.stringify(previous.data) === JSON.stringify(data)) return;
	manager.appendCustomEntry(NATIVE_CLI_STATE_ENTRY, data);
}

export function acceptNativeCliEvent(
	binding: NativeCliBinding,
	eventId: string,
	advanceCursor = true,
	cursor = eventId,
): boolean {
	if (
		!identifier(eventId, 512) ||
		(advanceCursor && !identifier(cursor, 512)) ||
		binding.seenEventIds.includes(eventId)
	)
		return false;
	if (advanceCursor) binding.lastEventId = cursor;
	binding.seenEventIds.push(eventId);
	if (binding.seenEventIds.length > 256) binding.seenEventIds.splice(0, binding.seenEventIds.length - 256);
	return true;
}
