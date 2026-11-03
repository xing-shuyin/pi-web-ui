import { describe, expect, it } from "vitest";
import { isManaged, managedRefusal, MANAGED_MESSAGES } from "../../server/managed.js";

/**
 * PI_WEB_MANAGED — this instance is updated from outside.
 *
 * The top bar can run `npm i -g pi-web-ui@latest` in a terminal and restart the
 * server, and the plugin market installs plugins from the network. On a laptop
 * that is a convenience. Behind a deploy pipeline — a Docker image, a distro
 * package, a release script that also checks the reverse proxy, the service
 * unit and the new environment variables — it is a way to leave the machine in
 * a state nothing describes, until the next real release quietly undoes it.
 *
 * The part that matters is that the *server* refuses. Hiding the button while
 * the socket still accepts the message is hiding, not disabling: anything that
 * can open the WebSocket can still send it.
 */
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
		// The badge calls check_update, the panel's "Re-check all" calls
		// check_updates_all, and "install pi" calls install_pi_agent. Leaving one
		// open would leave a way to reinstall around the deploy.
		expect([...MANAGED_MESSAGES].sort()).toEqual(
			[
				"check_update",
				"check_updates_all",
				"install_pi_agent",
				"update_engine",
				"uninstall_engine",
				"plugin_catalog_add",
				// 插件安装/更新/卸载的后台作业（issue #152）与目录同步（#148，可带安装）
				// 都是网络安装入口：托管实例一并拒绝。
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
