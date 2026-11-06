import { createHash } from "node:crypto";

export const sessionKey = (value) =>
	value.sessionId
		? `session:${value.sessionId}`
		: value.clientId && value.conversationId
			? `owner:${JSON.stringify([value.clientId, value.conversationId])}`
			: "";

export class SessionRoutes {
	constructor(bridge) {
		this.bridge = bridge;
		this.routes = new Map();
		this.tail = Promise.resolve();
	}
	account() {
		const cfg = this.bridge.getConfig() || {};
		return createHash("sha256")
			.update(JSON.stringify([cfg.appKey || "", cfg.robotCode || "", cfg.appSecret || ""]))
			.digest("hex");
	}
	async ready() {
		if (!this.loading) this.loading = this.load();
		await this.loading;
		if (this.accountId !== this.account()) {
			this.accountId = this.account();
			this.bridge.generation++;
			this.bridge.sessions.clear();
			this.bridge.pendingRuns.clear();
			this.bridge.earlyRuns.clear();
			this.routes.clear();
			await this.save();
		}
	}
	async load() {
		const saved = await this.bridge.host.storage?.get("sessionRoutes");
		this.accountId = this.account();
		if (saved?.account !== this.accountId || saved.version !== 1) {
			if (saved) await this.save();
			return;
		}
		for (const [scope, session] of saved.scopes || []) {
			if (typeof scope === "string" && session?.accountId && Number.isInteger(session.revision))
				this.bridge.sessions.set(scope, session);
		}
		for (const [key, route] of saved.routes || []) {
			if (key.startsWith("session:") && this.valid(route)) this.routes.set(key, route);
		}
	}
	valid(route) {
		const session = this.bridge.sessions.get(route?.scope);
		const allowed = (this.bridge.getConfig()?.allowedSenders || []).map(String).filter(Boolean);
		return (
			session &&
			session.accountId === route.accountId &&
			session.revision === route.revision &&
			(!allowed.length || allowed.includes(route.peer))
		);
	}
	bind(identity, session) {
		const key = sessionKey(identity);
		if (!key) return;
		const previous = this.routes.get(key);
		const route = {
			scope: session.scope,
			accountId: session.accountId,
			revision: session.revision,
			peer: session.peer,
		};
		this.routes.set(
			key,
			previous && (previous.ambiguous || previous.scope !== route.scope) ? { ambiguous: true } : route,
		);
	}
	revoke(scope) {
		for (const [key, route] of this.routes) if (route.scope === scope) this.routes.delete(key);
	}
	save() {
		const snapshot = {
			version: 1,
			account: this.accountId,
			scopes: [...this.bridge.sessions].map(([scope, s]) => [
				scope,
				Object.fromEntries(
					[
						"scope",
						"destination",
						"peer",
						"accountId",
						"revision",
						"conversationId",
						"sessionId",
						"clientId",
						"url",
						"model",
						"thinkingLevel",
						"cwd",
					]
						.filter((key) => s[key] !== undefined)
						.map((key) => [key, s[key]]),
				),
			]),
			routes: [...this.routes].filter(([key]) => key.startsWith("session:")),
		};
		const write = this.tail.catch(() => {}).then(() => this.bridge.host.storage?.set("sessionRoutes", snapshot));
		this.tail = write;
		return write;
	}
}
