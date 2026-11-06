export const MANAGED_MESSAGES = [
	"check_update",
	"check_updates_all",
	"install_pi_agent",
	"update_engine",
	"uninstall_engine",
	"plugin_catalog_add",
	"plugin_job",
	"plugin_catalog_sync",
] as const;

export function isManaged(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = (env.PI_WEB_MANAGED ?? "").trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function managedRefusal(type: string, managed: boolean): string | null {
	if (!managed) return null;
	if (!(MANAGED_MESSAGES as readonly string[]).includes(type)) return null;
	return "This instance is managed: updates and plugin installs are handled by whoever deploys it (PI_WEB_MANAGED=1).";
}
