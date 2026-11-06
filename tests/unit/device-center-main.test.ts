import { describe, expect, it } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDeviceHub } from "../../server/device-center/main.js";

describe("standalone device hub", () => {
	it("starts with only a public HTTP URL and no device domain", async () => {
		const probe = http.createServer();
		probe.listen(0, "127.0.0.1");
		await once(probe, "listening");
		const port = (probe.address() as { port: number }).port;
		await new Promise<void>((resolve) => probe.close(() => resolve()));
		const dir = await mkdtemp(join(tmpdir(), "device-main-"));
		const publicUrl = "http://198.51.100.10:8790";
		const hub = await startDeviceHub({
			PI_DEVICE_HUB_PUBLIC_URL: publicUrl,
			PI_DEVICE_HUB_PORT: String(port),
			PI_DEVICE_HUB_DATA_DIR: dir,
			PI_DEVICE_HUB_ALLOW_REGISTRATION: "1",
		});
		try {
			async function request(path: string, body?: object, cookie = "") {
				return new Promise<{ status: number; cookie?: string; data: any }>((resolve, reject) => {
					const req = http.request(
						{
							hostname: "127.0.0.1",
							port,
							path,
							method: body ? "POST" : "GET",
							headers: { host: "198.51.100.10:8790", origin: publicUrl, cookie, "content-type": "application/json" },
						},
						(res) => {
							const chunks: Buffer[] = [];
							res.on("data", (chunk) => chunks.push(chunk));
							res.on("end", () =>
								resolve({
									status: res.statusCode!,
									cookie: res.headers["set-cookie"]?.[0].split(";")[0],
									data: Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString()) : {},
								}),
							);
						},
					);
					req.on("error", reject);
					req.end(body ? JSON.stringify(body) : undefined);
				});
			}
			expect((await request("/api/info")).data).toEqual({ transport: "http", deviceWebAccess: true });
			const registration = await request("/api/auth/register", {
				username: "owner",
				["pass" + "word"]: "test-account-secret",
			});
			expect(registration.status).toBe(201);
			const cookie = registration.cookie!;
			const start = await request("/api/pair/start", { name: "device" });
			await request("/api/pair/approve", { code: start.data.code }, cookie);
			const paired = await request("/api/pair/poll", { pollToken: start.data.pollToken });
			const devices = await request("/api/devices", undefined, cookie);
			expect(devices.data.devices[0].url).toBe(`${publicUrl}/device/${paired.data.deviceId}/`);
			const opened = await request(`/api/devices/${paired.data.deviceId}/open`, {}, cookie);
			expect(opened.status).toBe(409);
			expect(opened.data.code).not.toBe("DEVICE_WEB_ORIGIN_REQUIRED");
		} finally {
			await hub.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
