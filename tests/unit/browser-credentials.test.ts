import { describe, expect, it, vi } from "vitest";
import { fillCredential } from "../../browser/runtime/credentials.js";

const credential = {
	id: "fixture",
	name: "Fixture",
	url: "https://login.example/sign-in",
	username: "fixture-user",
	password: "fixture-value",
	createdAt: new Date(0).toISOString(),
};
describe("explicit browser credential fill", () => {
	it.each([
		"https://login.example.evil.test/",
		"http://login.example/",
		"https://login.example:8443/",
		"file:///tmp/form.html",
	])("rejects a different origin before sending credentials to %s", async (url) => {
		const executeJavaScript = vi.fn();
		await expect(fillCredential({ getURL: () => url, executeJavaScript } as any, credential)).rejects.toThrow(
			"different website",
		);
		expect(executeJavaScript).not.toHaveBeenCalled();
	});
	it("only dispatches to the exact website and includes a document-side origin guard", async () => {
		const executeJavaScript = vi.fn(async (_code: string) => undefined);
		await fillCredential({ getURL: () => "https://login.example/account", executeJavaScript } as any, credential);
		expect(executeJavaScript).toHaveBeenCalledOnce();
		expect(executeJavaScript.mock.calls[0]?.[0]).toContain("location.origin !== origin");
	});
});
