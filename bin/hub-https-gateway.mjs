import http from "node:http";
import https from "node:https";
import { readFile, open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function certificateOptions(config) {
	const [cert, key] = await Promise.all([readFile(config.cert), readFile(config.key)]);
	const x509 = new X509Certificate(cert),
		host = new URL(config.publicUrl).hostname.replace(/^\[|\]$/g, "");
	if (
		!(isIP(host) ? x509.checkIP(host) : x509.checkHost(host)) ||
		Date.parse(x509.validTo) < Date.now() + 60000 ||
		Date.parse(x509.validFrom) > Date.now()
	)
		throw Error("HTTPS certificate does not match the public address or has expired");
	return { cert, key, fingerprint: createHash("sha256").update(cert).update(key).digest("hex") };
}

export async function startHttpsGateway(config) {
	const publicUrl = new URL(config.publicUrl),
		upstream = new URL(config.upstream);
	if (
		publicUrl.protocol !== "https:" ||
		publicUrl.origin !== config.publicUrl ||
		publicUrl.username ||
		publicUrl.password
	)
		throw Error("Invalid HTTPS public origin");
	if (
		upstream.protocol !== "http:" ||
		!["127.0.0.1", "[::1]"].includes(upstream.hostname) ||
		upstream.origin !== config.upstream
	)
		throw Error("HTTPS upstream must be a fixed loopback HTTP origin");
	let certificate = await certificateOptions(config);
	const sockets = new Set();
	const allowed = (req) =>
		req.headers.host?.toLowerCase() === publicUrl.host.toLowerCase() &&
		req.url?.startsWith("/") &&
		!req.url.startsWith("//");
	const forward = (req) => {
		const headers = { ...req.headers, host: publicUrl.host };
		for (const key of Object.keys(headers))
			if (key.startsWith("x-forwarded-") || key === "forwarded") delete headers[key];
		headers["x-forwarded-proto"] = "https";
		return http.request(upstream, { method: req.method, path: req.url, headers });
	};
	const server = https.createServer(certificate, (req, res) => {
		if (!allowed(req)) {
			res.writeHead(421).end();
			return;
		}
		const target = forward(req);
		target.on("response", (reply) => {
			res.writeHead(reply.statusCode ?? 502, reply.headers);
			reply.pipe(res);
			reply.on("error", () => res.destroy());
		});
		target.on("error", () => {
			if (!res.headersSent) res.writeHead(502);
			res.end();
		});
		req.on("aborted", () => target.destroy());
		res.on("close", () => target.destroy());
		req.pipe(target);
	});
	server.requestTimeout = 0;
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	server.on("upgrade", (req, socket, head) => {
		if (!allowed(req)) return socket.destroy();
		const target = forward(req);
		target.on("upgrade", (reply, remote, remoteHead) => {
			socket.write(
				"HTTP/1.1 101 Switching Protocols\r\n" +
					Object.entries(reply.headers)
						.map(([key, value]) => key + ": " + value + "\r\n")
						.join("") +
					"\r\n",
			);
			if (remoteHead.length) socket.write(remoteHead);
			if (head.length) remote.write(head);
			remote.on("error", () => socket.destroy());
			socket.on("error", () => remote.destroy());
			socket.on("close", () => remote.destroy());
			remote.on("close", () => socket.destroy());
			socket.pipe(remote).pipe(socket);
		});
		target.on("response", () => socket.destroy());
		target.on("error", () => socket.destroy());
		socket.on("close", () => target.destroy());
		target.end();
	});
	const reload = async () => {
		try {
			const next = await certificateOptions(config);
			if (next.fingerprint !== certificate.fingerprint) {
				server.setSecureContext(next);
				certificate = next;
				console.log("[hub-https] Certificate reloaded");
			}
		} catch {
			console.error("[hub-https] Certificate reload failed; keeping the active certificate");
		}
	};
	const timer = setInterval(reload, 60000);
	timer.unref();
	process.on("SIGHUP", reload);
	await new Promise((r, j) => {
		server.once("error", j);
		server.listen(config.port ?? Number(publicUrl.port || 443), config.host ?? "0.0.0.0", r);
	});
	return {
		server,
		async close() {
			clearInterval(timer);
			process.off("SIGHUP", reload);
			for (const socket of sockets) socket.destroy();
			await new Promise((r) => server.close(r));
		},
	};
}

export async function startAcmeGateway(root, port = 80, host = "0.0.0.0") {
	const server = http.createServer(async (req, res) => {
		const match = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/.exec(req.url || "");
		if (!match || !["GET", "HEAD"].includes(req.method)) {
			res.writeHead(404).end();
			return;
		}
		let file;
		try {
			file = await open(join(root, ".well-known/acme-challenge", match[1]), constants.O_RDONLY | constants.O_NOFOLLOW);
			const info = await file.stat();
			if (!info.isFile() || info.size > 16384) throw Error("Invalid challenge");
			const data = await file.readFile();
			res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store", "content-length": data.length });
			res.end(req.method === "HEAD" ? undefined : data);
		} catch {
			res.writeHead(404).end();
		} finally {
			await file?.close();
		}
	});
	server.requestTimeout = 10000;
	server.headersTimeout = 10000;
	await new Promise((r, j) => {
		server.once("error", j);
		server.listen(port, host, r);
	});
	return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	if (process.argv[2] === "--acme-root" && process.argv.length === 4) await startAcmeGateway(process.argv[3]);
	else if (process.argv[2] === "--config" && process.argv.length === 4) {
		const gateway = await startHttpsGateway(JSON.parse(await readFile(process.argv[3], "utf8")));
		process.on("SIGTERM", () => void gateway.close());
	} else throw Error("Usage: hub-https-gateway.mjs --config FILE | --acme-root DIRECTORY");
}
