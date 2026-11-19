import { join } from "node:path";
import { createRequire } from "node:module";
import { dirs, files, startMockSsh } from "../tests/lib/mock-ssh.mjs";
import { scanRemote } from "../plugins/sftp/lib/engine.mjs";

// 宽树：4 层 × 每层 8 个子目录 = 468 个目录
let front = ["/home/test"];
let created = 0;
for (let depth = 0; depth < 4; depth++) {
	const next = [];
	for (const parent of front) {
		for (let i = 0; i < 7; i++) {
			const p = `${parent}/w${depth}_${i}`;
			dirs[p] = [];
			dirs[parent].push(`w${depth}_${i}`);
			files[`${p}/f.txt`] = Buffer.from("x");
			next.push(p);
			created++;
		}
	}
	front = next;
}
console.log(`目录 ${created} 个，RTT ${process.env.LAT ?? 40}ms/次 readdir`);

const srv = await startMockSsh(join("E:/pi-web-ui", "plugins", "vscode-editor"), 21999, {
	latencyMs: Number(process.env.LAT ?? 40),
});
const req = createRequire(join("E:/pi-web-ui", "plugins", "vscode-editor", "package.json"));
const { Client } = req("ssh2");
const client = new Client();
const sftp = await new Promise((resolve, reject) => {
	client.on("ready", () => client.sftp((e, s) => (e ? reject(e) : resolve(s))));
	client.on("error", reject);
	client.connect({ host: "127.0.0.1", port: 21999, username: "tester", password: "secret123" });
});
for (const c of [1, 8, 16]) {
	const t0 = performance.now();
	const { files: f } = await scanRemote(
		sftp,
		"/home/test",
		(rel) => rel.startsWith("a.txt") || rel.startsWith("big.bin") || rel.startsWith("sub"),
		{ concurrency: c },
	);
	console.log(`concurrency=${c}: 远端 ${f.size} 个文件 / ${created} 个目录，${Math.round(performance.now() - t0)}ms`);
}
client.end();
srv.close();
