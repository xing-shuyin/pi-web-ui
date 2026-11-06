import { WebSocket } from "ws";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const WS = "ws://localhost:8791/ws";
const CLIENT_ID = "test-client-0001";
const PROJ_B = "/tmp/pi-webui-test/proj-b";
const phase = process.argv[2] ?? "phase1";

function connect() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(WS);
		const inbox = [];
		const waiters = [];
		ws.on("message", (d) => {
			let msg;
			try {
				msg = JSON.parse(d.toString());
			} catch {
				return;
			}
			const idx = waiters.findIndex((w) => w.pred(msg));
			if (idx >= 0) {
				const [w] = waiters.splice(idx, 1);
				w.resolve(msg);
			} else {
				inbox.push(msg);
			}
		});
		ws.on("open", () =>
			resolve({
				ws,
				send: (m) => ws.send(JSON.stringify(m)),
				wait: (pred, timeout = 8000) =>
					new Promise((res, rej) => {
						const i = inbox.findIndex(pred);
						if (i >= 0) {
							res(inbox.splice(i, 1)[0]);
							return;
						}
						const t = setTimeout(() => rej(new Error("timeout waiting for message")), timeout);
						waiters.push({
							pred,
							resolve: (m) => {
								clearTimeout(t);
								res(m);
							},
						});
					}),
				close: () => ws.close(),
			}),
		);
		ws.on("error", reject);
	});
}

async function phase1() {
	const c = await connect();
	c.send({ type: "hello", clientId: CLIENT_ID });
	await c.wait((m) => m.type === "ready");
	const first = await c.wait((m) => m.type === "snapshot");
	console.log("[1] initial cwd =", first.state.cwd);

	c.send({ type: "set_cwd", path: PROJ_B });
	const afterSwitch = await c.wait((m) => m.type === "snapshot" && m.state.cwd === PROJ_B);
	console.log("[2] after set_cwd →", afterSwitch.state.cwd);

	const projs = await c.wait((m) => m.type === "projects");
	console.log(
		"[3] projects =",
		projs.projects.map((p) => p.path),
	);
	if (!projs.projects.some((p) => p.path === PROJ_B)) {
		throw new Error("FAIL: new cwd missing from project list");
	}
	c.send({ type: "list_projects" });
	const projs2 = await c.wait((m) => m.type === "projects");
	console.log(
		"[4] list_projects →",
		projs2.projects.map((p) => p.path),
	);
	if (projs2.projects[0].path !== PROJ_B) {
		throw new Error("FAIL: most recent project not first");
	}
	c.close();
	console.log("\n✅ PHASE 1 PASSED");
	await testMakeDirScenario();
}

async function testMakeDirScenario() {
	let c;
	const tempBase = mkdtempSync(join(tmpdir(), "pi-proj-mkdir-"));
	const target = join(tempBase, "new-project-folder");
	try {
		c = await connect();
		c.send({ type: "hello", clientId: CLIENT_ID });
		await c.wait((m) => m.type === "ready");
		await c.wait((m) => m.type === "snapshot");

		c.send({ type: "make_dir", path: target, setAsCwd: true });
		const normTarget = resolve(target);
		const snap = await c.wait((m) => m.type === "snapshot" && resolve(m.state.cwd) === normTarget, 10000);
		console.log("[mkdir] after make_dir(setAsCwd: true) → cwd =", snap.state.cwd);

		if (!existsSync(target)) {
			throw new Error("FAIL: target directory was not created on disk");
		}

		c.send({ type: "list_projects" });
		const projs = await c.wait((m) => m.type === "projects");
		console.log(
			"[mkdir] projects =",
			projs.projects.map((p) => p.path),
		);
		if (!projs.projects.some((p) => resolve(p.path) === normTarget)) {
			throw new Error("FAIL: created directory missing from projects list");
		}
		console.log("\n✅ MAKE_DIR (setAsCwd: true) SCENARIO PASSED");
	} finally {
		if (c) c.close();
		try {
			rmSync(tempBase, { recursive: true, force: true });
		} catch {}
	}
}

async function phase2() {
	const c = await connect();
	c.send({ type: "hello", clientId: CLIENT_ID });
	await c.wait((m) => m.type === "ready");
	const restored = await c.wait((m) => m.type === "snapshot");
	console.log("[5] after restart, cwd =", restored.state.cwd);
	if (restored.state.cwd !== PROJ_B) {
		throw new Error(`FAIL: cwd not restored (got ${restored.state.cwd})`);
	}
	c.send({ type: "list_projects" });
	const projs = await c.wait((m) => m.type === "projects");
	console.log(
		"[6] projects after restart =",
		projs.projects.map((p) => p.path),
	);
	if (!projs.projects.some((p) => p.path === PROJ_B)) {
		throw new Error("FAIL: restored project missing from list");
	}
	c.close();
	console.log("\n✅ PHASE 2 PASSED — cwd remembered across restart");
}

const run = phase === "phase2" ? phase2 : phase === "mkdir" ? testMakeDirScenario : phase1;
run().catch((e) => {
	console.error("❌", e.message);
	process.exit(1);
});
