/// <reference path="../chrome.d.ts" />
/// <reference lib="dom" />

export async function requestPairHere(url: string): Promise<boolean> {
	return await askWorker("page-picker:pair-here", url);
}

export async function requestGrantHere(url: string): Promise<boolean> {
	return await askWorker("page-picker:grant-here", url);
}

async function askWorker(type: string, url: string): Promise<boolean> {
	try {
		const res = (await chrome.runtime.sendMessage({ type, url })) as { ok?: boolean } | undefined;
		return res?.ok === true;
	} catch {
		return false;
	}
}
