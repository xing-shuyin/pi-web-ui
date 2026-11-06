import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createCommandChannel, type RelayFrame } from "../../server/device-center/relay.js";
import { VERIFICATION_RPC_TIMEOUT_MS } from "../../server/device-center/verification-limits.js";
import { VerificationStopUnconfirmedError } from "../../server/device-center/local-verification.js";

afterEach(() => vi.useRealTimers());
function pair(handler: Parameters<typeof createCommandChannel>[1]) {
	const sent: RelayFrame[] = [];
	let client!: ReturnType<typeof createCommandChannel>, server!: ReturnType<typeof createCommandChannel>;
	const socket = (receive: (frame: RelayFrame) => void) =>
		({
			readyState: WebSocket.OPEN,
			bufferedAmount: 0,
			terminate() {},
			send(data: string, cb?: () => void) {
				const frame = JSON.parse(data);
				sent.push(frame);
				queueMicrotask(() => receive(frame));
				cb?.();
			},
		}) as unknown as WebSocket;
	client = createCommandChannel(socket((frame) => server.handle(frame)));
	server = createCommandChannel(
		socket((frame) => client.handle(frame)),
		handler,
	);
	return {
		client,
		server,
		sent,
		close() {
			client.close();
			server.close();
		},
	};
}
describe("verification relay safety", () => {
	it("keeps only integration_verify alive beyond the ordinary RPC deadline", async () => {
		vi.useFakeTimers();
		const p = pair(async () => new Promise(() => {}));
		const verification = p.client.call("integration_verify", {});
		const verificationRejected = expect(verification).rejects.toMatchObject({ stopUnconfirmed: true });
		const ordinary = p.client.call("integration_prepare", {});
		const ordinaryRejected = expect(ordinary).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(60_000);
		await ordinaryRejected;
		expect(p.sent.filter((frame) => frame.type === "rpc_cancel")).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(VERIFICATION_RPC_TIMEOUT_MS - 60_000);
		await verificationRejected;
		p.close();
	});
	it("never acknowledges cancellation as stopped when the runtime reports unconfirmed stop", async () => {
		let entered!: () => void;
		const running = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const p = pair(async (_action, _payload, signal) => {
			entered();
			return new Promise((_, reject) =>
				signal.addEventListener("abort", () => reject(new VerificationStopUnconfirmedError()), { once: true }),
			);
		});
		const controller = new AbortController();
		const request = p.client.call("integration_verify", {}, { signal: controller.signal });
		const rejected = expect(request).rejects.toMatchObject({ stopUnconfirmed: true });
		await running;
		controller.abort();
		await rejected;
		expect(p.sent.some((frame) => frame.type === "rpc_cancel_ack")).toBe(false);
		expect(p.sent).toContainEqual(expect.objectContaining({ type: "rpc_error", stopUnconfirmed: true }));
		p.close();
	});
});
