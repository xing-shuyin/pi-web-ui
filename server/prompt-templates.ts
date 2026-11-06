import type { Express } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";

export interface StoredPromptTemplate {
	id: string;
	icon?: string;
	title?: string;
	desc?: string;
	prompt?: string;
	command?: string;
	hidden?: boolean;
}

export function parseStoredTemplate(value: unknown): StoredPromptTemplate {
	if (!value || typeof value !== "object") throw new Error("Invalid template");
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== "string" || !raw.id || raw.id.length > 200) throw new Error("Invalid template id");
	if (raw.hidden === true) return { id: raw.id, hidden: true };
	const result: StoredPromptTemplate = { id: raw.id };
	for (const key of ["icon", "title", "desc", "prompt", "command"] as const) {
		if (raw[key] !== undefined) {
			if (typeof raw[key] !== "string" || raw[key].length > (key === "prompt" ? 100_000 : 1000)) {
				throw new Error(`Invalid template ${key}`);
			}
			result[key] = raw[key];
		}
	}
	if (!result.title?.trim() || !result.prompt?.trim()) throw new Error("Title and prompt are required");
	if (result.command) {
		result.command = result.command.trim().replace(/^\//, "").toLowerCase();
		if (!/^[a-z][a-z0-9_-]*$/.test(result.command)) throw new Error("Invalid template command");
	}
	return result;
}

export function registerPromptTemplateRoutes(app: Express, dataDir: string): void {
	const file = join(dataDir, "prompt-templates.json");
	const load = (): StoredPromptTemplate[] => {
		try {
			const data: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (!Array.isArray(data)) throw new Error("Invalid template file");
			return data.map(parseStoredTemplate);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	};
	app.get("/api/prompt-templates", (_req, res) => {
		try {
			res.setHeader("Cache-Control", "no-store");
			res.json({ templates: load() });
		} catch (error) {
			res.status(500).json({ error: String(error) });
		}
	});
	app.post("/api/prompt-templates", (req, res) => {
		if (!req.is("application/json") || req.headers["sec-fetch-site"] === "cross-site") {
			res.status(403).json({ error: "Cross-site template write rejected" });
			return;
		}
		try {
			const body = req.body ?? {};
			let templates = load();
			switch (body.action) {
				case "upsert": {
					const tpl = parseStoredTemplate(body.template);
					if (tpl.command && templates.some((t) => t.id !== tpl.id && t.command === tpl.command)) {
						throw new Error("Template command already exists");
					}
					templates = [...templates.filter((t) => t.id !== tpl.id), tpl];
					break;
				}
				case "remove":
					if (typeof body.id !== "string") throw new Error("Invalid template id");
					templates = templates.filter((t) => t.id !== body.id);
					break;
				case "reset":
					templates = [];
					break;
				case "migrate": {
					if (!Array.isArray(body.templates)) throw new Error("Invalid migration");
					for (const value of body.templates) {
						const tpl = parseStoredTemplate(value);
						if (templates.some((t) => t.id === tpl.id)) continue;
						if (tpl.command && templates.some((t) => t.command === tpl.command)) tpl.command = "";
						templates.push(tpl);
					}
					break;
				}
				default:
					throw new Error("Unknown template action");
			}
			if (templates.length > 500) throw new Error("Too many templates");
			writeJsonAtomicSync(file, templates);
			res.json({ templates });
		} catch (error) {
			res.status(400).json({ error: String(error) });
		}
	});
}
