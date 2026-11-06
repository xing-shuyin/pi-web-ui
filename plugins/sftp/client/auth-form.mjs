export function authFormState(connection) {
	const auth = connection?.auth ?? {};
	const password = String(auth.password ?? "");
	const explicit = ["key", "agent", "password", "secret"].includes(auth.method) ? auth.method : "";
	const method =
		explicit || (password.startsWith("secret:") ? "secret" : password ? "password" : auth.agent ? "agent" : "key");
	return {
		method,
		secretName:
			method === "secret"
				? password.startsWith("secret:")
					? password.slice(7)
					: `${connection?.name || "default"}-password`
				: "",
	};
}
