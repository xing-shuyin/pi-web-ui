import { registerMarker } from "./registry.js";
import { notifyMarker } from "./builtins/notify.js";
import { renameMarker } from "./builtins/rename.js";
import { actionMarker, suggestMarker } from "./builtins/action.js";

let initialized = false;

export function ensureMarkersRegistered(): void {
	if (initialized) return;
	registerMarker(notifyMarker);
	registerMarker(renameMarker);
	registerMarker(actionMarker);
	registerMarker(suggestMarker);
	initialized = true;
}

export { notifyMarker, renameMarker, actionMarker, suggestMarker };
export * from "./marker.js";
export * from "./registry.js";
export * from "./store.js";
