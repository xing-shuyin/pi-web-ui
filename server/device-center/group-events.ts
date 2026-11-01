import type { Response } from "express";
import type { DeviceTaskProgress } from "../protocol.js";
import type { DeviceHubStore } from "./store.js";
import { projectTaskActivity, validTaskProgress } from "./task-progress.js";
import type { createTaskJournalManager } from "./task-journal.js";

/** Ephemeral progress, separate from durable task reports. Slow consumers reconnect. */
export function createGroupEvents(store: DeviceHubStore, journalManager?: ReturnType<typeof createTaskJournalManager>) {
	let closed = false;
	const progress = new Map<string, DeviceTaskProgress>();
	const clients = new Set<{ accountId: string; roomId: string; res: Response; deviceId?: string }>();
	const pendingAppends = new Set<Promise<unknown>>();
	const journalFailures = new Map<string, string>();
	function send(res: Response, event: string, data: unknown) {
		if (!res.destroyed && !res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) res.destroy();
	}
	const unsubscribe = store.subscribe(() => {
		const state = store.snapshot();
		for (const [id, p] of progress)
			if (!state.tasks.some((t) => t.id === id && t.status === "running" && t.attemptId === p.attemptId))
				progress.delete(id);
		for (const c of clients) {
			if (
				!state.rooms.some((r) => r.id === c.roomId && r.accountId === c.accountId) ||
				(c.deviceId && !state.devices.some((d) => d.id === c.deviceId && d.accountId === c.accountId))
			)
				c.res.end();
			else send(c.res, "invalidate", {});
		}
	});
	return {
		invalidate(roomId: string) {
			const room = store.snapshot().rooms.find((item) => item.id === roomId);
			if (!room) return;
			for (const client of clients)
				if (client.roomId === roomId && client.accountId === room.accountId) send(client.res, "invalidate", {});
		},
		connect(accountId: string, roomId: string, res: Response, deviceId?: string) {
			if (!store.snapshot().rooms.some((r) => r.id === roomId && r.accountId === accountId)) {
				res.sendStatus(404);
				return;
			}
			if (clients.size >= 128 || [...clients].filter((c) => c.accountId === accountId).length >= 16) {
				res.sendStatus(429);
				return;
			}
			res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
			res.flushHeaders();
			const client = { accountId, roomId, res, deviceId };
			clients.add(client);
			send(res, "invalidate", {});
			const state = store.snapshot();
			for (const p of progress.values())
				if (state.tasks.some((t) => t.id === p.taskId && t.roomId === roomId)) send(res, "progress", p);
			const timer = setInterval(() => send(res, "ping", {}), 15000);
			timer.unref();
			res.once("close", () => {
				clearInterval(timer);
				clients.delete(client);
			});
		},
		accept(deviceId: string, event: DeviceTaskProgress) {
			if (closed || !validTaskProgress(event)) return;
			const state = store.snapshot();
			const device = state.devices.find((d) => d.id === deviceId);
			const task = state.tasks.find(
				(t) =>
					t.id === event.taskId &&
					t.deviceId === deviceId &&
					t.botId === event.botId &&
					t.attemptId === event.attemptId &&
					t.accountId === device?.accountId &&
					t.status === "running",
			);
			if (
				!task ||
				!state.bots.some(
					(b) =>
						b.id === task.botId &&
						b.enabled &&
						b.deviceId === deviceId &&
						b.accountId === task.accountId &&
						b.revision === task.botRevision,
				) ||
				!state.rooms.some(
					(r) => r.id === task.roomId && r.accountId === task.accountId && r.botIds.includes(task.botId),
				)
			)
				return;
			const previous = progress.get(task.id);
			if (previous && previous.attemptId === event.attemptId && previous.sequence >= event.sequence) return;
			if (!previous && progress.size >= 1024) return;
			const p = {
				...projectTaskActivity(event)!,
				taskId: task.id,
				botId: task.botId,
				attemptId: event.attemptId,
				sequence: event.sequence,
			};
			progress.set(task.id, p);

			// Persist progress into durable journal
			if (journalManager && !closed) {
				const appendPromise = journalManager
					.append(
						task.id,
						{
							botId: task.botId,
							attemptId: event.attemptId,
							type: "progress",
							phase: p.phase === "model" ? "running" : p.phase === "tool" ? "running" : "waiting",
							toolName: p.toolName,
							output: p.text,
							summary: p.toolName ? `Running tool ${p.toolName}` : p.text,
						},
						{ roomId: task.roomId, accountId: task.accountId },
					)
					.catch((err: any) => {
						const key = `${task.id}:${event.attemptId}`;
						if (journalFailures.size >= 128) {
							const oldest = journalFailures.keys().next().value;
							if (oldest) journalFailures.delete(oldest);
						}
						journalFailures.set(key, err?.message ?? "Journal disk append failed");
					});
				pendingAppends.add(appendPromise);
				appendPromise.finally(() => pendingAppends.delete(appendPromise));
			}

			for (const c of clients)
				if (c.accountId === task.accountId && c.roomId === task.roomId) send(c.res, "progress", p);
		},
		isJournalUnavailable(taskId: string, attemptId: string): boolean {
			return journalFailures.has(`${taskId}:${attemptId}`);
		},
		async close() {
			closed = true;
			unsubscribe();
			for (const c of clients) c.res.end();
			clients.clear();
			progress.clear();
			if (pendingAppends.size > 0) {
				await Promise.allSettled(Array.from(pendingAppends));
				pendingAppends.clear();
			}
		},
	};
}
