import { createHash, randomUUID } from "node:crypto";

const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
export const accountKey = (cfg = {}) =>
	hash(JSON.stringify([cfg.corpId || "", cfg.agentId || "", cfg.corpSecret || "", cfg.webhookKey || ""]));
export const scopeKey = (event, sender, webhookKey, cfg) =>
	JSON.stringify([
		accountKey(cfg),
		hash(webhookKey),
		String(event.chatId || event.ChatId || event.roomId || ""),
		String(event.channelId || ""),
		String(event.threadId || ""),
		sender,
	]);
export const identityKey = (identity = {}) =>
	identity.sessionId
		? `session:${identity.sessionId}`
		: identity.clientId && identity.conversationId
			? `owner:${JSON.stringify([identity.clientId, identity.conversationId])}`
			: "";

export class SessionRoutes {
	constructor(host, getConfig, log) {
		this.host = host;
		this.getConfig = getConfig;
		this.log = log;
		this.scopes = new Map();
		this.routes = new Map();
		this.targets = new Map();
		this.ready = this.load();
	}
	async load() {
		const saved = await this.host.storage?.get("sessionRoutes");
		this.account = saved?.account || accountKey(this.getConfig());
		for (const [key, value] of saved?.scopes || []) this.scopes.set(key, value);
		for (const [key, value] of saved?.routes || []) if (key.startsWith("session:")) this.routes.set(key, value);
	}
	syncAccount() {
		const account = accountKey(this.getConfig());
		if (this.account !== account) {
			this.account = account;
			this.scopes.clear();
			this.routes.clear();
			this.targets.clear();
			return this.save();
		}
	}
	state(scope) {
		if (!this.scopes.has(scope)) this.scopes.set(scope, { epoch: randomUUID(), account: accountKey(this.getConfig()) });
		return this.scopes.get(scope);
	}
	valid(route) {
		return (
			route &&
			!route.ambiguous &&
			route.account === accountKey(this.getConfig()) &&
			this.scopes.get(route.scope)?.epoch === route.epoch
		);
	}
	save() {
		const snapshot = JSON.parse(
			JSON.stringify({
				account: this.account,
				scopes: [...this.scopes],
				routes: [...this.routes].filter(([key]) => key.startsWith("session:")),
			}),
		);
		this.saving = (this.saving || Promise.resolve())
			.catch(() => {})
			.then(() => this.host.storage?.set("sessionRoutes", snapshot));
		return this.saving;
	}
	async bind(identity, run) {
		const key = identityKey(identity);
		if (!key) return;
		const previous = this.routes.get(key);
		if (previous?.ambiguous || (this.valid(previous) && previous.scope !== run.scope))
			this.routes.set(key, { ambiguous: true });
		else {
			const target = hash(run.webhookKey);
			this.targets.set(target, run.webhookKey);
			await this.host.secrets?.set(`wecom.route.${target}`, run.webhookKey);
			if (run.account !== accountKey(this.getConfig()) || this.scopes.get(run.scope)?.epoch !== run.epoch) return;
			this.routes.set(key, {
				scope: run.scope,
				epoch: run.epoch,
				account: accountKey(this.getConfig()),
				target,
				conversationId: identity.conversationId,
				clientId: identity.clientId,
				sessionId: identity.sessionId,
			});
		}
		await this.save();
	}
	async destination(route) {
		const cfgKey = this.getConfig()?.webhookKey || "";
		return (
			this.targets.get(route.target) ||
			(hash(cfgKey) === route.target ? cfgKey : await this.host.secrets?.get(`wecom.route.${route.target}`))
		);
	}
	reset(scope) {
		this.scopes.set(scope, { epoch: randomUUID(), account: accountKey(this.getConfig()) });
		for (const [key, route] of this.routes) if (route.scope === scope) this.routes.delete(key);
	}
}
