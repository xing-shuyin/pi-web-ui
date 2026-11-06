import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicSync } from "../atomic-file.js";
import type { CanvasCustomCard, CanvasEngineId, CanvasNodeRole } from "../protocol.js";
import { isSafeGraphId } from "./canvas-store.js";

const VALID_ENGINES: ReadonlySet<string> = new Set(["pi", "dsh", "codex", "claude", "durable"]);

export function isSafeCardId(id: unknown): id is string {
	return isSafeGraphId(id);
}

function cardsPath(dataDir: string): string {
	const dir = join(dataDir, "canvas");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return join(dir, "custom-cards.json");
}

export function listCustomCards(dataDir: string): CanvasCustomCard[] {
	try {
		const raw = JSON.parse(readFileSync(cardsPath(dataDir), "utf8")) as { cards?: CanvasCustomCard[] };
		if (!Array.isArray(raw?.cards)) return [];
		return raw.cards.filter((c) => c && isSafeCardId(c.id));
	} catch {
		return [];
	}
}

function persist(dataDir: string, cards: CanvasCustomCard[]): void {
	writeJsonAtomicSync(cardsPath(dataDir), { cards });
}

export interface CardInput {
	title?: unknown;
	role?: unknown;
	instruction?: unknown;
	systemPrompt?: unknown;
	model?: unknown;
	engine?: unknown;
	config?: unknown;
}

export function sanitizeCardInput(
	input: CardInput,
	isValidRole: (r: string) => boolean,
): Pick<CanvasCustomCard, "title" | "role"> &
	Partial<Pick<CanvasCustomCard, "instruction" | "systemPrompt" | "model" | "engine" | "config">> {
	const title = (typeof input.title === "string" ? input.title : "").trim().slice(0, 24);
	if (!title) throw new Error("Card title is required (1-24 chars).");
	const role = (typeof input.role === "string" ? input.role : "").trim();
	if (!role || !isValidRole(role)) throw new Error(`Invalid card role: ${JSON.stringify(input.role)}`);
	const out: Pick<CanvasCustomCard, "title" | "role"> &
		Partial<Pick<CanvasCustomCard, "instruction" | "systemPrompt" | "model" | "engine" | "config">> = {
		title,
		role: role as CanvasNodeRole,
	};
	const instruction = (typeof input.instruction === "string" ? input.instruction : "").trim().slice(0, 2000);
	if (instruction) out.instruction = instruction;
	const systemPrompt = (typeof input.systemPrompt === "string" ? input.systemPrompt : "").trim().slice(0, 2000);
	if (systemPrompt) out.systemPrompt = systemPrompt;
	const model = (typeof input.model === "string" ? input.model : "").trim().slice(0, 120);
	if (model) out.model = model;
	const engine = (typeof input.engine === "string" ? input.engine : "").trim();
	if (engine) {
		if (!VALID_ENGINES.has(engine)) throw new Error(`Invalid card engine: ${JSON.stringify(input.engine)}`);
		out.engine = engine as CanvasEngineId;
	}
	if (input.config !== undefined) {
		if (typeof input.config !== "object" || input.config === null || Array.isArray(input.config)) {
			throw new Error("Card config must be a plain object.");
		}
		const entries = Object.entries(input.config as Record<string, unknown>);
		if (entries.length > 20) throw new Error("Card config holds at most 20 keys.");
		const clean: Record<string, string | number | boolean> = {};
		for (const [k, v] of entries) {
			if (!/^[A-Za-z0-9_-]{1,32}$/.test(k)) throw new Error(`Invalid card config key: ${JSON.stringify(k)}`);
			if (typeof v === "string") clean[k] = v.slice(0, 500);
			else if (typeof v === "number" || typeof v === "boolean") clean[k] = v;
			else throw new Error(`Invalid card config value for ${JSON.stringify(k)} (scalar only).`);
		}
		if (Object.keys(clean).length > 0) out.config = clean;
	}
	return out;
}

export function addCustomCard(
	dataDir: string,
	input: CardInput,
	isValidRole: (r: string) => boolean,
): CanvasCustomCard {
	const clean = sanitizeCardInput(input, isValidRole);
	const cards = listCustomCards(dataDir);
	const card: CanvasCustomCard = {
		id: `card_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
		...clean,
		updatedAt: Date.now(),
	};
	cards.push(card);
	persist(dataDir, cards);
	return card;
}

export function updateCustomCard(
	dataDir: string,
	id: string,
	patch: CardInput,
	isValidRole: (r: string) => boolean,
): CanvasCustomCard {
	if (!isSafeCardId(id)) throw new Error(`Invalid card id: ${JSON.stringify(id)}`);
	const cards = listCustomCards(dataDir);
	const card = cards.find((c) => c.id === id);
	if (!card) throw new Error(`Card not found: ${id}`);
	const merged: CardInput = {
		title: patch.title ?? card.title,
		role: patch.role ?? card.role,
		instruction: patch.instruction ?? card.instruction ?? "",
		systemPrompt: patch.systemPrompt ?? card.systemPrompt ?? "",
		model: patch.model ?? card.model ?? "",
		engine: patch.engine ?? card.engine ?? "",
		config: patch.config ?? card.config ?? {},
	};
	const clean = sanitizeCardInput(merged, isValidRole);
	Object.assign(card, clean, { updatedAt: Date.now() });
	if (!clean.instruction) delete card.instruction;
	if (!clean.systemPrompt) delete card.systemPrompt;
	if (!clean.model) delete card.model;
	if (!clean.engine) delete card.engine;
	if (!clean.config) delete card.config;
	persist(dataDir, cards);
	return card;
}

export function deleteCustomCard(dataDir: string, id: string): boolean {
	if (!isSafeCardId(id)) throw new Error(`Invalid card id: ${JSON.stringify(id)}`);
	const cards = listCustomCards(dataDir);
	const next = cards.filter((c) => c.id !== id);
	if (next.length === cards.length) return false;
	persist(dataDir, next);
	return true;
}
