import { expect, it } from "vitest";
import { resolveBotCwd } from "../../web/src/local-bot-path";
it("passes SSH workspace URIs through unchanged", () => {
	expect(resolveBotCwd("ssh://dev@192.168.1.10:22/home/dev/app", "/work")).toBe(
		"ssh://dev@192.168.1.10:22/home/dev/app",
	);
	expect(resolveBotCwd("  ssh://dev@example.com:2222/srv/app/  ", "/work")).toBe("ssh://dev@example.com:2222/srv/app/");
});
it.each([
	["web", "E:/project", "E:/project/web"],
	[".", "E:\\project", "E:/project"],
	["../other", "/work/project", "/work/other"],
	["/tmp/project", "E:/project", "/tmp/project"],
	["\\\\server\\share\\folder", "E:/project", "//server/share/folder"],
	["../../x", "C:/project", "C:/x"],
])("resolves %s against %s", (value, base, result) => {
	expect(resolveBotCwd(value, base)).toBe(result);
});
