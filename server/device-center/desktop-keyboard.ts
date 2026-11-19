/** Track the key code actually sent, including keyups omitted by macOS while Command is held. */
export function desktopKeyboard(sendKey: (action: "down" | "up", code: string) => void) {
	const held = new Map<string, string>();
	const commandKeys = new Set<string>();
	function up(code: string) {
		const sent = held.get(code);
		if (!sent) return;
		sendKey("up", sent);
		held.delete(code);
		commandKeys.delete(code);
	}
	return {
		key(
			action: "down" | "up",
			event: { code: string; metaKey: boolean; repeat: boolean },
			viewer: string,
			target: string,
			translate: boolean,
		) {
			const code = event.code;
			const mac = /^Mac/i.test(viewer);
			const swap = translate && ((mac && target === "win32") || (/^Win/i.test(viewer) && target === "darwin"));
			const meta = code === "MetaLeft" || code === "MetaRight";
			if (action === "up") {
				if (mac && meta && !held.has(code === "MetaLeft" ? "MetaRight" : "MetaLeft")) {
					for (const key of commandKeys) up(key);
				}
				up(code);
				return;
			}
			if (held.has(code) && !event.repeat) up(code);
			let sent = held.get(code) ?? code;
			if (!held.has(code) && swap) {
				if (meta) sent = code.replace("Meta", "Control");
				else if (code === "ControlLeft" || code === "ControlRight") sent = code.replace("Control", "Meta");
			}
			held.set(code, sent);
			if (mac && event.metaKey && !/^(Meta|Control|Alt|Shift)(Left|Right)$/.test(code)) commandKeys.add(code);
			sendKey("down", sent);
		},
		clear() {
			held.clear();
			commandKeys.clear();
		},
	};
}
