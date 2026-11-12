import { describe, expect, it } from "vitest";
import { groupDesktops } from "../../web/src/group-desktop";
import type { GroupDetail } from "../../web/src/device-group-messages";

const detail: GroupDetail = {
	room: { id: "team", name: "Team", botIds: ["writer", "reviewer", "offline", "legacy"] },
	bots: [
		{ id: "writer", name: "Writer", deviceId: "pc", deviceName: "Old name" },
		{ id: "reviewer", name: "Reviewer", deviceId: "pc" },
		{ id: "offline", name: "Offline", deviceId: "away", online: true },
		{ id: "legacy", name: "No device" },
		{ id: "outside", name: "Outside group", deviceId: "other" },
	],
	messages: [],
	tasks: [],
};
describe("group desktop identity", () => {
	it("shares one desktop per hosting device while retaining every member and the full device label", () => {
		const targets = groupDesktops(detail, [{ id: "pc", name: "WORKSTATION", remark: "Studio", online: true }]);
		expect(targets).toHaveLength(2);
		expect(targets[0]).toMatchObject({ id: "pc", name: "Studio · WORKSTATION", online: true });
		expect(targets[0].members.map((bot) => bot.id)).toEqual(["writer", "reviewer"]);
		expect(targets[1]).toMatchObject({ id: "away", online: false });
	});
	it("never guesses a device from a Bot ID or grants an unrelated Bot a desktop", () => {
		const targets = groupDesktops(detail, [
			{ id: "legacy", name: "Wrong device", online: true },
			{ id: "other", name: "Other", online: true },
		]);
		expect(targets.map((target) => target.id)).toEqual(["pc", "away"]);
		expect(targets.every((target) => !target.online)).toBe(true);
		expect(groupDesktops(null, [])).toEqual([]);
	});
	it("follows current membership and hosting changes instead of retaining a stale target", () => {
		const changed = {
			...detail,
			room: { ...detail.room, botIds: ["writer"] },
			bots: [{ id: "writer", name: "Writer", deviceId: "new-pc" }],
		};
		expect(groupDesktops(changed, [{ id: "new-pc", name: "New PC", online: true }])).toEqual([
			{ id: "new-pc", name: "New PC", online: true, members: changed.bots },
		]);
	});
});
