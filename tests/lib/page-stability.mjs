import { setTimeout as sleep } from "node:timers/promises";

export async function waitForStablePage(page, { quietMs = 800, timeoutMs = 30000 } = {}) {
	let lastNav = Date.now();
	const onNav = (frame) => {
		if (frame === page.mainFrame()) lastNav = Date.now();
	};
	page.on("framenavigated", onNav);
	try {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			await sleep(100);
			if (Date.now() - lastNav > quietMs) return true;
		}
		return false;
	} finally {
		page.off("framenavigated", onNav);
	}
}
