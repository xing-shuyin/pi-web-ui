import { hostApi } from "@pi-web-ui/plugin-sdk/client";

const KEY = "__piHongguoRuntime";
globalThis[KEY]?.destroy();
const host = hostApi();
const revision = new URL(import.meta.url).search;
const { createPlayer } = await import(`./player.mjs${revision}`);
const player = createPlayer(host);
const off = host.onUiAction("hongguo:toggle", () => player.toggle());
let disposed = false;
function dispose() {
	if (disposed) return;
	disposed = true;
	off();
	player.destroy();
	if (globalThis[KEY]?.destroy === dispose) delete globalThis[KEY];
}
globalThis[KEY] = { destroy: dispose };
export default { dispose };
