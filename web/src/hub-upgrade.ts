export interface HubUpgradeStatus {
	id: string;
	state: "queued" | "running" | "succeeded" | "failed";
	fromBootId: string;
	targetVersion?: string;
	version?: string;
	bootId?: string;
	error?: string;
}
export async function waitForHubUpgrade(
	initial: HubUpgradeStatus,
	options: {
		poll: (id: string) => Promise<HubUpgradeStatus>;
		isCurrent?: () => boolean;
		sleep?: (ms: number) => Promise<void>;
		timeoutMs?: number;
	},
) {
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
	let job = initial;
	if (!job || typeof job.id !== "string" || typeof job.fromBootId !== "string")
		throw new Error("Invalid Hub upgrade response");
	while (true) {
		if (options.isCurrent && !options.isCurrent()) throw new DOMException("Hub upgrade view closed", "AbortError");
		if (job.id !== initial.id) throw new Error("Hub upgrade job changed");
		if (job.state === "failed") throw new Error(job.error || "Hub upgrade failed");
		if (job.state === "succeeded") {
			if (!job.targetVersion || job.version !== job.targetVersion || !job.bootId || job.bootId === initial.fromBootId)
				throw new Error("Hub upgrade result does not match the new version and process");
			return job;
		}
		if (job.state !== "queued" && job.state !== "running") throw new Error("Invalid Hub upgrade state");
		if (Date.now() >= deadline) throw new Error("Hub upgrade timed out; inspect the Hub upgrade log");
		await sleep(1500);
		if (options.isCurrent && !options.isCurrent()) throw new DOMException("Hub upgrade view closed", "AbortError");
		try {
			job = await options.poll(initial.id);
		} catch (error) {
			const status = (error as { status?: number }).status;
			if (status && status < 500) throw error;
		}
	}
}
