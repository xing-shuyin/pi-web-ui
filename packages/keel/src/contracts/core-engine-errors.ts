export class CoreEngineNotReadyError extends Error {
	constructor(what: string) {
		super(`core engine: ${what} lands after the W0 skeleton`);
		this.name = "CoreEngineNotReadyError";
	}
}
