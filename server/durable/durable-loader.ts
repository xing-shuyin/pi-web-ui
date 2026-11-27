import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dynamicImportGlobalPackage, resolvePackageEntryFileFromRoot, resolvePackageRoot } from "../global-loader.js";

const DURABLE_PKG = "@earendil-works/pi-durable";

function resolveNestedDurablePeerRoot(packageName: string): string | null {
	const durableRoot = resolvePackageRoot(DURABLE_PKG);
	if (!durableRoot) return null;
	const candidateDir = join(durableRoot, "node_modules", ...packageName.split("/"));
	const pkgJsonPath = join(candidateDir, "package.json");
	if (!existsSync(pkgJsonPath)) return null;
	try {
		const info = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { name?: string };
		if (info.name === packageName) return resolve(candidateDir);
	} catch {}
	return null;
}

export async function loadDurableModule<T = any>(subpath = ""): Promise<T> {
	return dynamicImportGlobalPackage<T>(DURABLE_PKG, subpath);
}

export async function loadDurablePeerModule<T = any>(packageName: string, subpath = ""): Promise<T | null> {
	const nestedRoot = resolveNestedDurablePeerRoot(packageName);
	if (nestedRoot) {
		const entryFile = resolvePackageEntryFileFromRoot(nestedRoot, subpath);
		if (entryFile) {
			try {
				return (await import(/* webpackIgnore: true */ pathToFileURL(entryFile).href as string)) as T;
			} catch {}
		}
	}
	try {
		return await dynamicImportGlobalPackage<T>(packageName, subpath);
	} catch {
		return null;
	}
}
