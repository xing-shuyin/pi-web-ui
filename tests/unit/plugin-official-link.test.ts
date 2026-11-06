import { describe, expect, it } from "vitest";
import { OFFICIAL_PLUGINS_REPO_URL, pluginOfficialUrl } from "../../web/src/components/SettingsModal";

describe("plugin official link helper", () => {
	it("official plugins repository URL is configured correctly", () => {
		expect(OFFICIAL_PLUGINS_REPO_URL).toBe("https://github.com/xing-shuyin/pi-web-ui-plugins");
	});

	it("returns explicit homepage when available and valid http/https", () => {
		expect(
			pluginOfficialUrl({
				homepage: "https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/webmail",
			}),
		).toBe("https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/webmail");

		expect(
			pluginOfficialUrl({
				homepage: "http://example.com/plugin-docs",
				source: "owner/repo",
			}),
		).toBe("http://example.com/plugin-docs");
	});

	it("resolves GitHub source when homepage is omitted", () => {
		expect(
			pluginOfficialUrl({
				source: "modelcontextprotocol/servers",
			}),
		).toBe("https://github.com/modelcontextprotocol/servers");

		expect(
			pluginOfficialUrl({
				source: "xing-shuyin/pi-web-ui/plugins/webmail",
			}),
		).toBe("https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/webmail");

		expect(
			pluginOfficialUrl({
				source: "https://github.com/custom-org/my-plugin",
			}),
		).toBe("https://github.com/custom-org/my-plugin");

		expect(
			pluginOfficialUrl({
				source: "git@github.com:foo/bar.git",
			}),
		).toBe("https://github.com/foo/bar");
	});

	it("returns null for non-url and non-github sources", () => {
		expect(pluginOfficialUrl(null)).toBeNull();
		expect(pluginOfficialUrl(undefined)).toBeNull();
		expect(pluginOfficialUrl({})).toBeNull();
		expect(pluginOfficialUrl({ source: "builtin:0.1.0" })).toBeNull();
		expect(pluginOfficialUrl({ source: "local-folder" })).toBeNull();
	});
});
