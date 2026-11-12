/** Labels are presentation only; device IDs remain the routing/authorization identity. */
export function deviceLabel(name: unknown, remark: unknown, fallback = "Device"): string {
	const clean = (value: unknown) => (typeof value === "string" ? value.trim().slice(0, 256) : "");
	const computer = clean(name),
		note = clean(remark);
	return note && computer && note !== computer ? `${note} · ${computer}` : note || computer || fallback;
}
