import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
	appId: "com.piwebui.mobile",
	appName: "π",
	webDir: "dist",
	server: {
		hostname: "localhost",
		androidScheme: "https",
		iosScheme: "capacitor",
		cleartext: true,
	},
	android: { allowMixedContent: true },
	plugins: {
		Keyboard: { resize: "body", resizeOnFullScreen: true },
		SplashScreen: { launchAutoHide: true, launchShowDuration: 400 },
	},
};
export default config;
