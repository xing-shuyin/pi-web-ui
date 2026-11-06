import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

if (!CHROME_PATH) {
	console.log("SKIP remote workbench UI: Chrome unavailable");
} else {
	const base = fileURLToPath(new URL("..", import.meta.url));
	const hosts = [
		{ name: "alpha", host: "alpha.test", username: "tester", port: 22, group: "ops", environment: "production" },
		{ name: "beta", host: "beta.test", username: "tester", port: 2222, group: "dev", environment: "staging" },
	];
	const calls = [];
	let tasks = [],
		tunnels = [];
	const html = `<!doctype html><style>:root{--bg:#111827;--bg-elev:#182030;--bg-elev2:#223047;--text:#eee;--text-faint:#bbc;--border:#456;--accent:#8b5cf6;--accent-contrast:#fff}body{margin:0}#app{height:950px;width:1280px}</style><script type="importmap">{"imports":{"@pi-web-ui/plugin-sdk/client":"/pi/sdk.mjs"}}</script><div id="app"></div><script type="module">
	import plugin from '/pi/plugins/remote-workbench/client/entry.mjs';
	window.messages=[];window.listenerCount=()=>listeners.size;const listeners=new Set();let number=0;
	window.emit=(msg)=>{for(const cb of listeners)cb(msg)};
	window.ctx={appUrl:(p)=>'/pi'+p,onData(cb){listeners.add(cb);return()=>listeners.delete(cb)},send(m){messages.push(m);if(m.action==='shell_input'){const writable=!window.blockNextInput;queueMicrotask(()=>emit({res:true,reqId:m.reqId,ok:true,accepted:true,writable}));window.blockNextInput=false;}if(m.action==='shell_open'||m.action==='shell_attach'){const id='shell-'+(++number);queueMicrotask(()=>emit({res:true,action:m.action,reqId:m.reqId,ok:true,shellId:id,resumeToken:m.resumeToken||'token-'+number}));}}};
	window.mount=()=>{window.unmount=plugin.mount(document.querySelector('#app'),ctx)};window.mount();window.ready=true;
	</script>`;
	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url, "http://mock");
			if (url.pathname === "/") {
				res.setHeader("Content-Type", "text/html");
				res.end(html);
				return;
			}
			if (url.pathname === "/pi/sdk.mjs") {
				res.setHeader("Content-Type", "text/javascript");
				res.end(await readFile(resolve(base, "plugin-sdk/client-utils.mjs")));
				return;
			}
			if (url.pathname.startsWith("/pi/plugins/remote-workbench/client/")) {
				const file = resolve(base, url.pathname.slice(4));
				assert(file.startsWith(resolve(base, "plugins/remote-workbench/client") + sep));
				res.setHeader("Content-Type", file.endsWith("css") ? "text/css" : "text/javascript");
				res.end(await readFile(file));
				return;
			}
			let raw = "";
			for await (const chunk of req) raw += chunk;
			const body = raw ? JSON.parse(raw) : {};
			const path = url.pathname.replace("/pi/plugins-api/remote-workbench", "");
			calls.push({ path, body });
			let data = {};
			if (path === "/hosts") data = { hosts };
			else if (path === "/tasks") data = { tasks };
			else if (path === "/tasks/start") {
				tasks = [
					{
						id: "task-1",
						...body,
						status: "running",
						items: body.hostNames.map((hostName) => ({ hostName, status: "running", attempt: 1 })),
					},
				];
				data = { task: tasks[0] };
			} else if (path === "/tasks/cancel") {
				tasks[0].status = "cancelled";
				tasks[0].items.forEach((item) => {
					item.status = "cancelled";
				});
				data = { task: tasks[0] };
			} else if (path === "/tunnels") data = { tunnels };
			else if (path === "/tunnels/save") {
				tunnels = [{ id: "tunnel-1", ...body, status: "stopped" }];
				data = { tunnel: tunnels[0] };
			} else if (path === "/tunnels/start") {
				tunnels[0].status = "listening";
				data = { tunnel: tunnels[0] };
			} else if (path === "/tunnels/stop") {
				tunnels[0].status = "stopped";
				data = { tunnel: tunnels[0] };
			} else {
				res.statusCode = 404;
				res.end(JSON.stringify({ ok: false, error: `Unexpected ${path}` }));
				return;
			}
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ ok: true, data }));
		} catch (error) {
			res.statusCode = 500;
			res.end(JSON.stringify({ ok: false, error: error.message }));
		}
	});
	await new Promise((done, reject) => {
		let port = 19000 + Math.floor(Math.random() * 10000);
		const retry = (error) => {
			if (error.code === "EADDRINUSE") server.listen(++port, "127.0.0.1");
			else reject(error);
		};
		server.on("error", retry);
		server.once("listening", () => {
			server.off("error", retry);
			done();
		});
		server.listen(port, "127.0.0.1");
	});
	let browser;
	try {
		browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
		const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
		const errors = [];
		page.on("pageerror", (err) => errors.push(err.message));
		page.on("dialog", (dialog) => dialog.accept());
		await page.goto(`http://127.0.0.1:${server.address().port}`);
		await page.waitForFunction(() => window.ready);
		await page.locator(".rw-host-card").nth(1).waitFor();
		assert.equal(await page.locator(".rw-host-card").count(), 2);
		await page.locator("#rw-search").fill("production");
		assert.equal(await page.locator(".rw-host-card").count(), 1);
		await page.locator("#rw-search").fill("");
		await page.getByText("多机任务中心", { exact: true }).click();
		await page.locator('[name="target"]').first().check();
		await page.locator('[name="cmd"]').fill("printf mock");
		await page.getByText("执行所选主机", { exact: true }).click();
		await page.locator(".rw-task-card").waitFor();
		assert.deepEqual(calls.find((c) => c.path === "/tasks/start").body.hostNames, ["alpha"]);
		await page.locator(".rw-task-cancel").click();
		await page.waitForFunction(() => document.querySelector(".rw-task-card")?.textContent.includes("cancelled"));
		await page.locator(".rw-ops-close").click();
		await page.locator(".rw-op-tunnel").first().click();
		await page.locator("#rw-tun-start").click();
		await page.locator(".rw-tunnel-card").waitFor();
		assert(calls.some((c) => c.path === "/tunnels/save"));
		assert(calls.some((c) => c.path === "/tunnels/start"));
		await page.locator(".rw-op-stoptun").click();
		await page.getByText("恢复隧道", { exact: true }).waitFor();
		await page.locator('[data-tab="hosts"]').click();
		await page.locator(".rw-op-term").first().click();
		await page.locator(".xterm").waitFor();
		await page.waitForFunction(() => messages.some((m) => m.action === "shell_open"));
		await page.evaluate(() => {
			const bytes = new TextEncoder().encode("中文输出\r\n");
			const b64 = (b) => btoa(String.fromCharCode(...b));
			emit({ event: "shell_data", shellId: "shell-1", b64: b64(bytes.slice(0, 2)), seq: 1 });
			emit({ event: "shell_data", shellId: "shell-1", b64: b64(bytes.slice(2)), seq: 2 });
		});
		await page.waitForFunction(() => messages.some((m) => m.action === "shell_ack" && m.seq === 2));
		await page.getByLabel("搜索终端缓冲").fill("中文输出");
		await page.getByText("下一个", { exact: true }).click();
		assert.match(await page.locator('.rw-snippet-bar [role="status"]').textContent(), /第/);
		await page.locator(".xterm-helper-textarea").evaluate((el) => {
			const data = new DataTransfer();
			data.setData("text/plain", "echo 中文\necho mock\n");
			el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
		});
		await page.getByText("多行粘贴预览", { exact: true }).waitFor();
		const before = await page.evaluate(() => messages.filter((m) => m.action === "shell_input").length);
		await page.getByText("发送以上内容", { exact: true }).click();
		assert.equal(await page.evaluate(() => messages.filter((m) => m.action === "shell_input").length), before + 1);
		await page.evaluate(() => {
			window.blockNextInput = true;
		});
		await page.locator(".xterm-helper-textarea").evaluate((el) => {
			const data = new DataTransfer();
			data.setData("text/plain", "中".repeat(6000) + "\n");
			el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
		});
		const inputCount = await page.evaluate(() => messages.filter((m) => m.action === "shell_input").length);
		await page.getByText("发送以上内容", { exact: true }).click();
		await page.waitForFunction((n) => messages.filter((m) => m.action === "shell_input").length === n + 1, inputCount);
		await page.evaluate(() => emit({ event: "shell_drain", shellId: "shell-1" }));
		await page.waitForFunction((n) => messages.filter((m) => m.action === "shell_input").length === n + 2, inputCount);
		assert(
			await page.evaluate(() =>
				messages.filter((m) => m.action === "shell_input").every((m) => atob(m.b64).length <= 16384),
			),
		);
		await page.locator('[data-tab="hosts"]').click();
		await page.locator(".rw-op-term").nth(1).click();
		await page.waitForFunction(() => messages.filter((m) => m.action === "shell_open").length === 2);
		await page.locator(".rw-term-tabs .rw-term-tab").first().click();
		await page.evaluate(() => {
			emit({ event: "shell_data", shellId: "shell-2", b64: btoa("pass"), seq: 1 });
			emit({ event: "shell_data", shellId: "shell-2", b64: btoa("word:"), seq: 2 });
		});
		await page.locator("#rw-secure-input").fill("mock-secret");
		await page.locator("#rw-secure-send").click();
		assert.equal(
			await page.evaluate(() => messages.filter((m) => m.action === "shell_input").at(-1).shellId),
			"shell-2",
		);
		assert.equal(await page.locator("#rw-secure-input").inputValue(), "");
		await page.evaluate(() => {
			unmount();
			mount();
		});
		await page.waitForFunction(() => messages.some((m) => m.action === "shell_attach"));
		assert(await page.evaluate(() => messages.some((m) => m.action === "shell_detach")));
		await page.locator('[data-tab="hosts"]').click();
		await mkdir(resolve(base, ".temp"), { recursive: true });
		await page.screenshot({ path: resolve(base, ".temp/remote-workbench-review.png") });
		await page.evaluate(() => unmount());
		assert.equal(await page.evaluate(() => window.listenerCount()), 0);
		const finalCount = await page.evaluate(() => messages.length);
		await page.evaluate(() => {
			emit({ event: "shell_data", shellId: "shell-1", b64: btoa("late"), seq: 100 });
			window.dispatchEvent(new Event("resize"));
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		await page.waitForTimeout(80);
		assert.equal(await page.evaluate(() => messages.length), finalCount);
		assert.deepEqual(errors, []);
		console.log(
			"PASS remote-workbench UI: module import, hosts/filter, tasks/cancel, tunnels, UTF8/search, paste, detach/restore",
		);
	} finally {
		await browser?.close();
		await new Promise((done) => server.close(done));
	}
}
