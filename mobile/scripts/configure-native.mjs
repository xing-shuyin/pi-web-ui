import { readFile, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.includes("--check")) {
	const nativePackage = JSON.parse(await readFile(resolve(root, "native/push/package.json"), "utf8"));
	const podspec = await readFile(resolve(root, "native/push/PiMobileNativePush.podspec"), "utf8");
	const podfile = await readFile(resolve(root, "ios/App/Podfile"), "utf8");
	const plugins = JSON.parse(
		await readFile(resolve(root, "android/app/src/main/assets/capacitor.plugins.json"), "utf8"),
	);
	if (
		nativePackage.name !== "@pi-mobile/native-push" ||
		!podspec.includes("s.name = 'PiMobileNativePush'") ||
		!podfile.includes("pod 'PiMobileNativePush'")
	)
		throw new Error("CocoaPods plugin name mismatch");
	for (const name of ["PiPushPlugin", "PiCredentialsPlugin"]) {
		if (plugins.filter((plugin) => plugin.classpath.endsWith("." + name)).length !== 1)
			throw new Error("Android plugin registration missing or duplicated: " + name);
	}
	let spm = false;
	try {
		await access(resolve(root, "ios/App/CapApp-SPM"));
		spm = true;
	} catch {}
	if (spm) throw new Error("Use the CocoaPods iOS template for the JPush plugin");
	console.log(
		"Native project structure and plugin registration verified. Native compilation still requires platform SDKs.",
	);
} else {
	const appKey = process.env.PI_MOBILE_JPUSH_APP_KEY?.trim();
	if (!appKey || !/^[0-9a-f]{24}$/i.test(appKey))
		throw new Error("Set PI_MOBILE_JPUSH_APP_KEY to the 24-character JPush AppKey (never the MasterSecret).");
	await writeFile(
		resolve(root, "android/pi-push.properties"),
		"# Local configuration; do not commit.\npiJpushAppKey=" + appKey + "\n",
		{ mode: 0o600 },
	);
	await writeFile(
		resolve(root, "ios/App/App/NativeConfig.xcconfig"),
		"// Local configuration; do not commit.\nPI_JPUSH_APP_KEY = " + appKey + "\n",
		{ mode: 0o600 },
	);
	console.log(
		"Configured Android and iOS JPush AppKey. Configure APNs/OEM channels and signing before device testing.",
	);
}
