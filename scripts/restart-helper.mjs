#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";

const TARGET_PORT = 8787;
const TARGET_PID = parseInt(process.argv[2], 10) || 47892;
const REPO_DIR = "/Volumes/P/project/pi-web-ui";
const NODE_BIN = "/Users/c/.local/share/fnm/node-versions/v26.12.1/installation/bin/node";
const NEW_PROCESS_ARGS = ["--import", "./dist/server/resolve-global-sdk.js", "dist/server/index.js"];
const LOG_PATH = "/Volumes/P/project/pi-web-ui/.restart-helper.log";
const SERVER_LOG_PATH = "/Volumes/P/project/pi-web-ui/.server-restart.log";

function log(msg) {
	const line = `[${new Date().toISOString()}] ${msg}\n`;
	try {
		fs.appendFileSync(LOG_PATH, line);
	} catch {}
}

async function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkHealth() {
	return new Promise((resolve) => {
		const req = http.get(`http://127.0.0.1:${TARGET_PORT}/api/health`, { timeout: 2000 }, (res) => {
			let data = "";
			res.on("data", (chunk) => {
				data += chunk;
			});
			res.on("end", () => {
				resolve(res.statusCode === 200 && data.includes('"ok":true'));
			});
		});
		req.on("error", () => resolve(false));
		req.on("timeout", () => {
			req.destroy();
			resolve(false);
		});
	});
}

function isPidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return false;
	}
}

async function run() {
	log(`=== Helper armed ===`);
	log(`Target PID: ${TARGET_PID}, Port: ${TARGET_PORT}, Repo: ${REPO_DIR}`);
	log(`Waiting 15s for device task to finish and group response to be delivered...`);

	await sleep(15000);

	log(`Checking target PID ${TARGET_PID} status before signaling...`);
	if (!isPidAlive(TARGET_PID)) {
		log(`Target PID ${TARGET_PID} is already not running. Aborting.`);
		return;
	}

	log(`Sending SIGTERM to target PID ${TARGET_PID}...`);
	try {
		process.kill(TARGET_PID, "SIGTERM");
	} catch (err) {
		log(`Failed to send SIGTERM: ${err.message}`);
		return;
	}

	log(`Waiting for PID ${TARGET_PID} to exit and port ${TARGET_PORT} to release...`);
	let waitCount = 0;
	while (waitCount < 60) {
		await sleep(500);
		waitCount++;
		const alive = isPidAlive(TARGET_PID);
		if (!alive) {
			log(`PID ${TARGET_PID} has exited after ~${waitCount * 0.5}s.`);
			break;
		}
	}

	if (isPidAlive(TARGET_PID)) {
		log(`PID ${TARGET_PID} did not exit after 30s. Aborting restart to prevent dual instances.`);
		return;
	}

	const stillServing = await checkHealth();
	if (stillServing) {
		log(`Port ${TARGET_PORT} is still healthy/occupied by another process! Aborting.`);
		return;
	}

	log(`Port ${TARGET_PORT} is free. Spawning new server instance...`);
	const serverLogOut = fs.openSync(SERVER_LOG_PATH, "a");

	const child = spawn(NODE_BIN, NEW_PROCESS_ARGS, {
		cwd: REPO_DIR,
		env: process.env,
		detached: true,
		stdio: ["ignore", serverLogOut, serverLogOut],
	});
	child.unref();

	log(`Spawned new server PID: ${child.pid}. Monitoring /api/health for up to 60s...`);

	let healthOk = false;
	for (let i = 0; i < 60; i++) {
		await sleep(1000);
		healthOk = await checkHealth();
		if (healthOk) {
			log(`Health check passed after ${i + 1}s! Service is up and running.`);
			break;
		}
	}

	if (!healthOk) {
		log(`Health check did not pass within 60s. Check ${SERVER_LOG_PATH} for details.`);
	} else {
		log(`=== Restart sequence successfully completed ===`);
	}
}

run().catch((err) => {
	log(`Unhandled error: ${err.stack || err.message}`);
});
