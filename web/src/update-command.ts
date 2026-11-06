/**
 * Build the chained shell command for updating pi components in a visible
 * terminal tab. The command depends on WHERE each component lives:
 *
 * - "package" (pi extensions, installed under <agentDir>/npm — e.g.
 *   ~/.pi/agent/npm): `pi update npm:<name>` is the ONLY command that updates
 *   the copy pi actually loads. A bare `npm i -g` installs to the npm global
 *   root instead, leaving the checked copy stale — the next update check would
 *   still report an update (the bug this kind split fixes).
 * - "git-extension" (git-source pi extensions, cloned under <agentDir>/git):
 *   `pi update git:<host>/<path>` — the `git:` prefix is required (a bare
 *   `host/path` fails with "No matching package found"; issue #178).
 * - "pi-core" / "webui" (globally installed via npm): `npm i -g <name>@latest`.
 *
 * Multiple targets are joined with `;` so a failing step never blocks the
 * rest. Pure — unit-tested.
 */
interface UpdateTarget {
	name: string;
	kind: "webui" | "pi-core" | "package" | "git-extension" | "plugin" | "engine";
	source?: string;
	pluginId?: string;
}

export function buildUpdateCommand(targets: UpdateTarget[]): string {
	return targets
		.map((t) =>
			t.kind === "package"
				? `pi update npm:${t.name}`
				: t.kind === "git-extension"
					? `pi update ${toGitUpdateArg(t.source ?? t.name)}`
					: t.kind === "plugin"
						? `pi-web-ui install ${t.source ?? t.name} --name ${t.pluginId ?? t.name} --force`
						: `npm i -g ${t.name}@latest`,
		)
		.join("; ");
}

function toGitUpdateArg(source: string): string {
	return source.startsWith("git:") ? source : `git:${source}`;
}
