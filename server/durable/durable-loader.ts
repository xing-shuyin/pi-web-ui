import { dynamicImportGlobalPackage } from "../global-loader.js";

const DURABLE_PKG = "@earendil-works/pi-durable";

export async function loadDurableModule<T = any>(subpath = ""): Promise<T> {
	return dynamicImportGlobalPackage<T>(DURABLE_PKG, subpath);
}

export async function loadDurablePeerModule<T = any>(packageName: string, subpath = ""): Promise<T | null> {
	try {
		return await dynamicImportGlobalPackage<T>(packageName, subpath);
	} catch {
		return null;
	}
}
