import { expect, it } from "vitest";
import { desktopKeyboard } from "../../server/device-center/desktop-keyboard.js";

it.each([
	["Win32", "darwin", "ControlLeft", "MetaLeft"],
	["macOS", "win32", "MetaRight", "ControlRight"],
	["MacIntel", "darwin", "MetaLeft", "MetaLeft"],
	["Win32", "win32", "ControlRight", "ControlRight"],
	["Linux x86_64", "win32", "ControlLeft", "ControlLeft"],
])("preserves raw input and translates only across Windows and Mac (%s -> %s)", (viewer, target, modifier, mapped) => {
	for (const enabled of [false, true]) {
		const events: string[] = [];
		const keys = desktopKeyboard((action, code) => events.push(action + " " + code));
		for (const [action, code] of [
			["down", modifier],
			["down", "KeyV"],
			["up", "KeyV"],
			["up", modifier],
		] as const)
			keys.key(
				action,
				{ code, metaKey: viewer.startsWith("Mac") && action === "down", repeat: false },
				viewer,
				target,
				enabled,
			);
		expect(events).toEqual([
			"down " + (enabled ? mapped : modifier),
			"down KeyV",
			"up KeyV",
			"up " + (enabled ? mapped : modifier),
		]);
	}
});

it("balances missing macOS keyups, preserves paste repeats, and releases the original mapping", () => {
	const events: string[] = [];
	const keys = desktopKeyboard((action, code) => events.push(action + " " + code));
	const key = (action: "down" | "up", code: string, repeat = false, translate = true) =>
		keys.key(action, { code, repeat, metaKey: action === "down" }, "MacIntel", "win32", translate);
	key("down", "MetaLeft");
	key("down", "KeyV");
	key("down", "KeyV", true);
	key("down", "KeyV");
	key("up", "MetaLeft", false, false);
	key("up", "KeyV");
	expect(events).toEqual([
		"down ControlLeft",
		"down KeyV",
		"down KeyV",
		"up KeyV",
		"down KeyV",
		"up KeyV",
		"up ControlLeft",
	]);
	key("down", "MetaRight");
	keys.clear();
	const count = events.length;
	key("up", "MetaRight");
	expect(events.length).toBe(count);
});
