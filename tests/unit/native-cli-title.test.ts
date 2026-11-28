import { describe, expect, it } from "vitest";
import { nativeCliTitleFromTerminalOutput } from "../../server/native-cli-title";
import { stripAnsi } from "../../server/terminals";

describe("stripAnsi", () => {
	it("strips Kitty keyboard protocol and private CSI sequences without leaving >7u fragments", () => {
		expect(stripAnsi("\x1b[>7u───────────────\n你好\n───────────────")).toBe("───────────────\n你好\n───────────────");
		expect(stripAnsi("\x1b[>4;2mhello\x1b[<u\x1b[=5;1u")).toBe("hello");
		expect(stripAnsi("\x1b[>0c\x1b[?2026hworld\x1b[?2026l")).toBe("world");
	});

	it("strips OSC, DCS, APC, PM, and SOS sequences", () => {
		expect(stripAnsi("\x1b]0;pi\x07\x1bP1$q\x1b\\\x1b_Ga=q\x1b\\\x1b^pm\x1b\\\x1bXsos\x1b\\ok")).toBe("ok");
	});
});

describe("nativeCliTitleFromTerminalOutput", () => {
	it("ignores Kitty keyboard protocol prefix on pi border lines and extracts user input", () => {
		const raw = ["pi v1.7.0", "\x1b[>7u──────────────────────────────", "你好", "──────────────────────────────"].join(
			"\n",
		);

		expect(nativeCliTitleFromTerminalOutput(raw, { title: "pi cli", preset: "pi" })).toBe("你好");
	});

	it("extracts prompted input when other CLIs emit modifyOtherKeys or Kitty sequences", () => {
		const raw = ["\x1b[>4;2m\x1b[>7u", "> 帮我检查这个报错", "\x1b[?2026hWorking\x1b[?2026l"].join("\n");

		expect(nativeCliTitleFromTerminalOutput(raw, { title: "claude cli", preset: "claude" })).toBe("帮我检查这个报错");
	});
});
