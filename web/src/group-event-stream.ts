import type { DeviceTaskProgress } from "../../server/protocol";

/** One visible group owns one stream; disposed connections cannot publish late events. */
export function openGroupEventStream(
	url: string,
	callbacks: {
		alive: () => boolean;
		sync: () => void;
		connected: (value: boolean) => void;
		progress: (value: DeviceTaskProgress) => void;
	},
	create: (url: string) => EventSource = (url) => new EventSource(url),
): () => void {
	let disposed = false;
	const source = create(url);
	const alive = () => !disposed && callbacks.alive();
	source.onopen = () => {
		if (alive()) {
			callbacks.connected(true);
			callbacks.sync();
		}
	};
	source.onerror = () => {
		if (alive()) {
			callbacks.connected(false);
			callbacks.sync();
		}
	};
	source.addEventListener("invalidate", () => {
		if (alive()) callbacks.sync();
	});
	source.addEventListener("progress", (event) => {
		if (!alive()) return;
		try {
			const value = JSON.parse((event as MessageEvent).data);
			if (
				!value ||
				[value.taskId, value.botId, value.attemptId].some((id) => typeof id !== "string" || !id || id.length > 128) ||
				!Number.isSafeInteger(value.sequence) ||
				value.sequence < 1 ||
				!["model", "tool", "waiting"].includes(value.phase) ||
				(value.text !== undefined &&
					(typeof value.text !== "string" || new TextEncoder().encode(value.text).byteLength > 2048)) ||
				(value.toolName !== undefined &&
					(typeof value.toolName !== "string" || !/^[A-Za-z0-9_.:-]{1,80}$/.test(value.toolName)))
			)
				return;
			callbacks.progress({
				taskId: value.taskId,
				botId: value.botId,
				attemptId: value.attemptId,
				sequence: value.sequence,
				phase: value.phase,
				...(value.text !== undefined ? { text: value.text } : {}),
				...(value.toolName !== undefined ? { toolName: value.toolName } : {}),
			});
		} catch {
			/* the next full synchronization repairs malformed events */
		}
	});
	return () => {
		disposed = true;
		source.close();
	};
}

export function taskProgressMatches(
	task: { id: string; botId: string; attemptId?: string; status: string },
	progress: DeviceTaskProgress | undefined,
): progress is DeviceTaskProgress {
	return (
		!!progress &&
		task.status === "running" &&
		task.id === progress.taskId &&
		task.botId === progress.botId &&
		task.attemptId === progress.attemptId
	);
}
export function acceptTaskProgress(previous: DeviceTaskProgress | undefined, value: DeviceTaskProgress): boolean {
	return !previous || previous.attemptId !== value.attemptId || previous.sequence < value.sequence;
}
