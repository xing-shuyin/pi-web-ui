/**
 * Only workspace-relative file paths can be handed to the editor
 * (rejects machine roots like "@root", absolute paths, and ".." traversal).
 */
export function canOpenInEditor(path: string): boolean {
	if (!path || typeof path !== "string") return false;
	const p = path.trim();
	if (!p || p === "@root" || p === "/" || p === "." || p === "..") return false;
	if (p.startsWith("/") || p.startsWith("\\")) return false;
	if (/^[A-Za-z]:($|[\\/])/.test(p)) return false;
	if (p.split(/[\\/]/).some((seg) => seg === "..")) return false;
	return true;
}
