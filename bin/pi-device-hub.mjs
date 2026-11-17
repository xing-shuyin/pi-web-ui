#!/usr/bin/env node
import { runHubCliEntry } from "./device-hub-cli.mjs";
try {
	await runHubCliEntry();
} catch (error) {
	console.error(`[device-hub] ${error.message}`);
	process.exitCode = 1;
}
