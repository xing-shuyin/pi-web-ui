import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DeviceHubStore } from "../../server/device-center/store.js";

describe("Hub transaction update boundaries", () => {
	it("rejects async updates without persisting or publishing their detached draft", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hub-sync-transaction-"));
		const store = await DeviceHubStore.open(dir);
		try {
			await store.transact((draft) => {
				draft.accounts.push({ id: "owner", username: "owner", passwordHash: "", createdAt: 1 });
			});
			const before = await readFile(join(dir, "device-hub.json"), "utf8");
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const update = (draft: any) => {
				draft.accounts = [];
				return gate.then(() => {
					draft.rooms = [];
				});
			};
			await expect(store.transact(update as any)).rejects.toThrow("synchronous update");
			release();
			await gate;
			expect(store.snapshot().accounts).toHaveLength(1);
			expect(await readFile(join(dir, "device-hub.json"), "utf8")).toBe(before);
			await store.transact((draft) => {
				draft.accounts[0].username = "still writable";
			});
			expect(store.snapshot().accounts[0].username).toBe("still writable");
		} finally {
			await store.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
