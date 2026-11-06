export class DeviceTaskError extends Error {
	constructor(
		readonly publicReport: string,
		internalMessage = publicReport,
	) {
		super(internalMessage);
		this.name = "DeviceTaskError";
	}
}
export function deviceTaskFailure(error: unknown): string {
	return error instanceof DeviceTaskError
		? error.publicReport
		: "设备任务执行失败，请在目标设备查看任务对话。 / Device task failed; inspect the task conversation on the target device.";
}
