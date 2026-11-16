import type { MessageKey } from "./i18n/catalog";
import type { SlashCommandInfo } from "./types";

export interface CommandTemplate {
	id: string;
	command?: string;
	prompt: string;
}

export interface TemplateVariableDef {
	key: string;
	labelKey: MessageKey;
	descKey: MessageKey;
}

export const COMMON_TEMPLATE_VARIABLES: readonly TemplateVariableDef[] = [
	{ key: "{{input}}", labelKey: "tpl.vars.inputLabel", descKey: "tpl.vars.inputDesc" },
	{ key: "{{clipboard}}", labelKey: "tpl.vars.clipboardLabel", descKey: "tpl.vars.clipboardDesc" },
	{ key: "{{date}}", labelKey: "tpl.vars.dateLabel", descKey: "tpl.vars.dateDesc" },
	{ key: "{{time}}", labelKey: "tpl.vars.timeLabel", descKey: "tpl.vars.timeDesc" },
	{ key: "{{datetime}}", labelKey: "tpl.vars.datetimeLabel", descKey: "tpl.vars.datetimeDesc" },
	{ key: "{{selection}}", labelKey: "tpl.vars.selectionLabel", descKey: "tpl.vars.selectionDesc" },
];

export function resolveDynamicTemplateVariables(text: string, now: Date = new Date()): string {
	if (!text.includes("{{")) return text;
	const pad = (n: number) => String(n).padStart(2, "0");
	const year = now.getFullYear();
	const month = pad(now.getMonth() + 1);
	const day = pad(now.getDate());
	const hours = pad(now.getHours());
	const minutes = pad(now.getMinutes());
	const seconds = pad(now.getSeconds());

	const dateStr = `${year}-${month}-${day}`;
	const timeStr = `${hours}:${minutes}:${seconds}`;
	const datetimeStr = `${dateStr} ${timeStr}`;

	return text
		.replaceAll("{{date}}", dateStr)
		.replaceAll("{{time}}", timeStr)
		.replaceAll("{{datetime}}", datetimeStr)
		.replaceAll("{{year}}", String(year));
}

export function normalizeTemplateCommand(value: string): string {
	return value.trim().replace(/^\//, "").toLowerCase();
}

export function validTemplateCommand(value: string): boolean {
	return /^[a-z][a-z0-9_-]*$/.test(value);
}

export function availableTemplateCommands<T extends CommandTemplate>(
	templates: readonly T[],
	reserved: readonly Pick<SlashCommandInfo, "name">[],
): T[] {
	const used = new Set(["help", "copy", ...reserved.map((c) => c.name.toLowerCase())]);
	return templates.filter((tpl) => {
		const name = normalizeTemplateCommand(tpl.command ?? "");
		if (!validTemplateCommand(name) || used.has(name)) return false;
		used.add(name);
		return true;
	});
}

export function expandTemplateCommand(
	text: string,
	templates: readonly CommandTemplate[],
	now: Date = new Date(),
): string {
	const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	if (!match) return text;
	const tpl = templates.find((t) => normalizeTemplateCommand(t.command ?? "") === match[1].toLowerCase());
	if (!tpl) return text;
	const input = match[2] ?? "";
	const withInput = tpl.prompt.includes("{{input}}")
		? tpl.prompt.replaceAll("{{input}}", () => input)
		: [tpl.prompt, input].filter(Boolean).join("\n\n");
	return resolveDynamicTemplateVariables(withInput, now);
}
