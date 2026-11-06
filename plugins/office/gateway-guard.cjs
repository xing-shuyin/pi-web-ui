"use strict";

const http = require("node:http");
const installed = Symbol.for("pi-web-ui.office.gateway-browser-guard");

function browserHeader(name) {
	return (
		name === "origin" || name === "sec-websocket-origin" || (name.startsWith("sec-fetch-") && name !== "sec-fetch-mode")
	);
}

function admitted(request) {
	const headers = request.headers || {};
	const raw = request.rawHeaders || [];
	let hostCount = 0;
	for (let index = 0; index < raw.length; index += 2) {
		const name = raw[index].toLowerCase();
		if (name === "host") hostCount++;
		if (browserHeader(name)) return false;
	}
	for (const name of Object.keys(headers)) {
		if (browserHeader(name)) return false;
	}
	const port = request.socket?.localPort;
	if (!Number.isInteger(port) || port < 1 || hostCount !== 1) return false;
	const host = headers.host;
	if (host !== `127.0.0.1:${port}` && host !== `[::1]:${port}`) return false;
	return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket?.remoteAddress);
}

if (!http.Server.prototype[installed]) {
	const emit = http.Server.prototype.emit;
	Object.defineProperty(http.Server.prototype, installed, { value: true });
	http.Server.prototype.emit = function (event, request, response, ...args) {
		if ((event === "request" || event === "upgrade") && !admitted(request)) {
			if (event === "request") {
				response.writeHead(403, {
					"Content-Type": "text/plain; charset=utf-8",
					"Cache-Control": "no-store",
					Connection: "close",
				});
				response.end("Office gateway browser access denied");
			} else {
				response.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			}
			return true;
		}
		return Reflect.apply(emit, this, [event, request, response, ...args]);
	};
}
