import { randomUUID } from "node:crypto";
import type { QuestionAnswer, UiQuestion } from "./protocol.js";

export type QuestionResult =
	QuestionAnswer[] | { cancelled: true; reason?: string } | { status: "timed_out"; timed_out: true } | null;

export class PendingQuestion {
	readonly id = `q-${randomUUID()}`;
	readonly createdAt = Date.now();
	readonly deadline?: number;
	readonly promise: Promise<QuestionResult>;
	conversationId: string;
	audience: "user" | "parent";
	settled = false;
	onSettled?: () => void;
	private finish!: (result: QuestionResult) => void;
	private timer?: ReturnType<typeof setTimeout>;
	private removeAbort?: () => void;
	private readonly settledListeners = new Set<() => void>();

	constructor(
		readonly questions: UiQuestion[],
		conversationId: string,
		audience: "user" | "parent",
		timeoutSeconds: number,
		signal?: Pick<AbortSignal, "aborted" | "addEventListener" | "removeEventListener">,
	) {
		this.conversationId = conversationId;
		this.audience = audience;
		this.promise = new Promise((resolve) => {
			this.finish = resolve;
		});
		if (timeoutSeconds > 0) {
			this.deadline = this.createdAt + timeoutSeconds * 1000;
			this.timer = setTimeout(() => this.resolve({ status: "timed_out", timed_out: true }), timeoutSeconds * 1000);
			this.timer.unref?.();
		}
		if (signal) {
			const abort = () => this.resolve(null);
			this.removeAbort = () => signal.removeEventListener?.("abort", abort);
			signal.addEventListener?.("abort", abort, { once: true });
			if (signal.aborted) abort();
		}
	}

	subscribeSettled(listener: () => void): () => void {
		if (this.settled) {
			listener();
			return () => {};
		}
		this.settledListeners.add(listener);
		return () => {
			this.settledListeners.delete(listener);
		};
	}

	addSettledListener(listener: () => void): () => void {
		return this.subscribeSettled(listener);
	}

	resolve = (result: QuestionResult): void => {
		if (this.settled) return;
		this.settled = true;
		clearTimeout(this.timer);
		this.removeAbort?.();
		this.removeAbort = undefined;
		this.finish(result);
		const onSettled = this.onSettled;
		this.onSettled = undefined;
		const listeners = [...this.settledListeners];
		this.settledListeners.clear();
		let firstError: unknown;
		let failed = false;
		for (const listener of [...listeners, ...(onSettled ? [onSettled] : [])]) {
			try {
				listener();
			} catch (error) {
				if (!failed) {
					failed = true;
					firstError = error;
				}
			}
		}
		if (failed) throw firstError;
	};
}
