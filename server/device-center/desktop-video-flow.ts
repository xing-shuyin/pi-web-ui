/** Receiver-paced video. The minimum measured round trip estimates propagation;
 * excess delay is queueing. Both the map and the allowed window are bounded. */
export class DesktopVideoFlow {
	private pending = new Map<number, number>();
	private sequence = 0;
	private baseline = Infinity;
	private latestAck = 0;
	private lastSample = -Infinity;
	private good = 0;
	private bad = 0;
	private qualityScale = 1;
	private fpsScale = 1;
	ackMs = 0;
	queueMs = 0;
	measured = false;
	private window(fps: number) {
		return Math.min(
			64,
			Math.max(3, Math.ceil((((Number.isFinite(this.baseline) ? this.baseline : 60) + 24) * fps) / 1000)),
		);
	}
	blocked(fps: number) {
		return this.pending.size >= this.window(fps);
	}
	get count() {
		return this.pending.size;
	}
	get oldest() {
		return this.pending.values().next().value as number | undefined;
	}
	frame(now: number) {
		if (this.pending.size >= 128) throw new Error("Video feedback window exceeded");
		const id = ++this.sequence;
		this.pending.set(id, now);
		return id;
	}
	reset() {
		this.pending.clear();
	}
	ack(id: number, decodeQueue: number, now: number) {
		if (!Number.isSafeInteger(id) || !Number.isInteger(decodeQueue) || decodeQueue < 0 || decodeQueue > 128)
			return false;
		const sentAt = this.pending.get(id);
		if (id <= this.latestAck || sentAt === undefined) return false;
		this.latestAck = id;
		for (const key of this.pending.keys()) {
			if (key <= id) this.pending.delete(key);
		}
		this.ackMs = Math.max(0, now - sentAt);
		this.measured = true;
		this.baseline = Math.min(this.baseline, this.ackMs);
		this.queueMs = Math.max(0, this.ackMs - this.baseline);
		if (now - this.lastSample < 1000) return true;
		this.lastSample = now;
		this.bad = this.queueMs > 80 || decodeQueue > 3 ? this.bad + 1 : 0;
		this.good = this.queueMs < 30 && decodeQueue < 2 ? this.good + 1 : 0;
		// Reduce encoder bitrate first; lower capture FPS only after quality reaches its floor.
		if (this.bad >= 2 || this.queueMs > 250 || decodeQueue > 8) {
			if (this.qualityScale > 0.6) this.qualityScale = Math.max(0.6, this.qualityScale * 0.85);
			else this.fpsScale = Math.max(0.25, this.fpsScale * 0.8);
			this.bad = this.good = 0;
		} else if (this.good >= 4) {
			if (this.fpsScale < 1) this.fpsScale = Math.min(1, this.fpsScale + 0.1);
			else this.qualityScale = Math.min(1, this.qualityScale + 0.1);
			this.good = 0;
		}
		return true;
	}
	profile<T extends { fps: number; quality: number }>(base: T, automatic: boolean): T {
		return automatic
			? {
					...base,
					fps: Math.max(5, Math.round(base.fps * this.fpsScale)),
					quality: Math.max(35, Math.round(base.quality * this.qualityScale)),
				}
			: base;
	}
}
