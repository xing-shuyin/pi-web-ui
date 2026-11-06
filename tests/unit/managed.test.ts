import { describe, expect, it } from "vitest";
import { isManaged, managedRefusal, MANAGED_MESSAGES } from "../../server/managed.js";

describe("managed instances", () => {
	it("is off unless asked for", () => {
		expect(isManaged({})).toBe(false);
		expect(isManaged({ PI_WEB_MANAGED: "" })).toBe(false);
		expect(isManaged({ PI_WEB_MANAGED: "0" })).toBe(false);
		expect(isManaged({ PI_WEB_MANAGED: "false" })).toBe(false);
	});

	it("accepts the spellings people actually write", () => {
		for (const v of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
			expect(isManaged({ PI_WEB_MANAGED: v }), v).toBe(true);
		}
	});

	it("refuses self-update and network plugin installs, and says why", () => {
		for (const type of MANAGED_MESSAGES) {
			const why = managedRefusal(type, true);
			expect(why, type).toBeTruthy();
			expect(why, type).toMatch(/managed/i);
		}
	});

	it("covers the whole self-update surface, not just the button", () => {
		expect([...MANAGED_MESSAGES].sort()).toEqual(
			[
				"check_update",
				"check_updates_all",
				"install_pi_agent",
				"update_engine",
				"uninstall_engine",
				"plugin_catalog_add",
				"plugin_job",
				"plugin_catalog_sync",
			].sort(),
		);
	});

	it("touches nothing else: chatting, git, terminal and plugins already there", () => {
		for (const type of ["prompt", "scm_status", "terminal_create", "plugins_reload", "plugin_catalog_remove"]) {
			expect(managedRefusal(type, true), type).toBeNull();
		}
	});

	it("is inert when the instance is not managed", () => {
		for (const type of MANAGED_MESSAGES) {
			expect(managedRefusal(type, false), type).toBeNull();
		}
	});
});
