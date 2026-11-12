type Capture = { close(): void };
type Frame = { jpeg: Buffer; at: number };
type Options = {
	readOnly: boolean;
	preview: boolean;
	onFrame(jpeg: Buffer): void;
	onError(message: string): void;
	onClose(): void;
};

export function createDesktopPreview(start: (options: Options) => Capture) {
	let capture: Capture | undefined;
	let generation = 0;
	let cached: Frame | undefined;
	let idle: ReturnType<typeof setTimeout> | undefined;
	const live = new Map<object, Frame | undefined>();
	const pending = new Set<{ resolve(frame: Frame): void; reject(error: Error): void }>();
	function stop() {
		generation++;
		const previous = capture;
		capture = undefined;
		previous?.close();
	}
	function publish(jpeg: Buffer) {
		if (!jpeg.length || jpeg.length > 4 * 1024 * 1024) {
			reset("Desktop preview exceeds the frame size limit.");
			return;
		}
		cached = { jpeg, at: Date.now() };
		for (const request of pending) request.resolve(cached);
	}
	function scheduleIdle() {
		clearTimeout(idle);
		idle = setTimeout(() => {
			if (!pending.size) {
				stop();
				cached = undefined;
			}
		}, 6500);
		idle.unref();
	}
	function ensureCapture() {
		if (capture || live.size || !pending.size) return;
		const current = ++generation;
		try {
			const next = start({
				readOnly: true,
				preview: true,
				onFrame: (jpeg) => {
					if (current === generation) publish(jpeg);
				},
				onError: (message) => {
					if (current === generation) reset(message);
				},
				onClose: () => {
					if (current === generation) reset("Desktop preview capture stopped.");
				},
			});
			if (current === generation) capture = next;
			else next.close();
		} catch (error) {
			reset(error instanceof Error ? error.message : "Could not start desktop preview.");
		}
	}
	function reset(message = "Desktop preview stopped.") {
		clearTimeout(idle);
		stop();
		cached = undefined;
		for (const request of pending) request.reject(new Error(message));
	}
	return {
		read(signal: AbortSignal): Promise<Frame> {
			if (signal.aborted) return Promise.reject(new Error("Desktop preview cancelled."));
			scheduleIdle();
			const latest = [...live.values(), cached]
				.filter((frame): frame is Frame => !!frame)
				.sort((a, b) => b.at - a.at)[0];
			if (latest && Date.now() - latest.at < 2500) return Promise.resolve(latest);
			if (pending.size >= 8) return Promise.reject(new Error("Too many desktop preview requests."));
			return new Promise((resolve, reject) => {
				const finish = () => {
					pending.delete(request);
					clearTimeout(timeout);
					signal.removeEventListener("abort", abort);
					if (!pending.size) scheduleIdle();
				};
				const request = {
					resolve: (frame: Frame) => {
						finish();
						resolve(frame);
					},
					reject: (error: Error) => {
						finish();
						reject(error);
					},
				};
				const abort = () => request.reject(new Error("Desktop preview cancelled."));
				const timeout = setTimeout(() => request.reject(new Error("Desktop preview timed out.")), 60000);
				timeout.unref();
				pending.add(request);
				signal.addEventListener("abort", abort, { once: true });
				ensureCapture();
			});
		},
		liveStarted(key: object) {
			live.set(key, undefined);
			stop();
		},
		liveFrame(key: object, jpeg: Buffer) {
			if (!live.has(key)) return;
			live.set(key, { jpeg, at: Date.now() });
			publish(jpeg);
		},
		liveStopped(key: object) {
			live.delete(key);
			ensureCapture();
		},
		reset,
		close() {
			reset();
			clearTimeout(idle);
			live.clear();
		},
	};
}
