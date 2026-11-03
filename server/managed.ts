/**
 * managed — instances whose updates come from outside.
 *
 * pi-web-ui can update itself: the top bar shows an updates badge and a panel
 * whose buttons run `npm i -g pi-web-ui@latest` in a visible terminal and
 * restart the server. The plugin market installs plugins from the network the
 * same way. On a developer's laptop both are conveniences.
 *
 * Behind a deploy pipeline they are not. A Docker image, a distribution
 * package, or a release script that also checks the reverse proxy, the service
 * unit and the environment variables a new version needs — for all of those,
 * an in-app self-update leaves the machine in a state nothing describes, until
 * the next real deploy silently undoes it. `PI_WEB_MANAGED=1` says "this
 * instance is managed from outside": the update paths refuse, and the client
 * stops offering them.
 *
 * Two rules kept this small:
 *
 * - **The server refuses, the client only hides.** Hiding a button while the
 *   socket still accepts the message is hiding, not disabling: anything that
 *   can open the WebSocket can still send it.
 * - **Nothing else changes.** Chatting, plugins already installed, git,
 *   terminal, settings are untouched — this switch is about who installs
 *   software on the machine, not about what the interface can do.
 */

/** The client messages that install or replace software on the machine. */
export const MANAGED_MESSAGES = [
	/** Update check behind the top-bar badge. */
	"check_update",
	/** "Re-check all" in the UPDATE panel (app + components). */
	"check_updates_all",
	/** Installs the pi agent itself. */
	"install_pi_agent",
	/** Updates an agent engine package via background process. */
	"update_engine",
	/** Uninstalls an agent engine package via background process. */
	"uninstall_engine",
	/** Plugin market: fetches and installs a plugin from the network. */
	"plugin_catalog_add",
	/** Plugin install/update/uninstall run as a background job (issue #152). */
	"plugin_job",
	/** Catalog sync can install/update entries too (issue #148). */
	"plugin_catalog_sync",
] as const;

/**
 * Whether this instance is managed from outside.
 *
 * Accepts the spellings people actually put in a systemd unit or a
 * docker-compose file; anything else — including an empty variable — means no,
 * so the default stays exactly what it is today.
 */
export function isManaged(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = (env.PI_WEB_MANAGED ?? "").trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * The reason to send back, or null when the message may proceed.
 *
 * Returning the text rather than a boolean keeps the caller a single line and
 * puts the explanation next to the rule it comes from — the user gets a
 * sentence, not a silently dropped message.
 */
export function managedRefusal(type: string, managed: boolean): string | null {
	if (!managed) return null;
	if (!(MANAGED_MESSAGES as readonly string[]).includes(type)) return null;
	return "This instance is managed: updates and plugin installs are handled by whoever deploys it (PI_WEB_MANAGED=1).";
}
