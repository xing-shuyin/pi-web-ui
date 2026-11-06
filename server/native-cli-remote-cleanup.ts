import { cleanupRemoteNativeCliFiles } from "./native-cli-remote-files.js";

type CleanupService = Parameters<typeof cleanupRemoteNativeCliFiles>[0];
interface CleanupJob {
	service: CleanupService;
	cwd: string;
	path: string;
	attempts: number;
	nextAt: number;
}

export class RemoteNativeCliCleanupQueue {
	private jobs: CleanupJob[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running = false;

	constructor(private readonly cleanup = cleanupRemoteNativeCliFiles) {}

	enqueue(service: CleanupService, cwd: string, paths: readonly string[]): void {
		for (const path of paths) {
			if (!this.jobs.some((job) => job.service === service && job.cwd === cwd && job.path === path))
				this.jobs.push({ service, cwd, path, attempts: 0, nextAt: Date.now() + 30_000 });
		}
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.arm();
	}

	private arm(): void {
		if (this.running || this.timer || !this.jobs.length) return;
		const nextAt = this.jobs.reduce((earliest, job) => Math.min(earliest, job.nextAt), Infinity);
		const delay = Math.max(1, nextAt - Date.now());
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.run();
		}, delay);
		this.timer.unref?.();
	}

	private async run(): Promise<void> {
		this.running = true;
		try {
			const ready = this.jobs.filter((job) => job.nextAt <= Date.now()).slice(0, 8);
			await Promise.all(
				ready.map(async (job) => {
					try {
						await this.cleanup(job.service, job.cwd, [job.path]);
						this.jobs = this.jobs.filter((candidate) => candidate !== job);
					} catch {
						job.attempts++;
						job.nextAt = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(job.attempts, 5));
					}
				}),
			);
		} finally {
			this.running = false;
			this.arm();
		}
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.jobs = [];
	}
}

export const remoteNativeCliCleanupQueue = new RemoteNativeCliCleanupQueue();
