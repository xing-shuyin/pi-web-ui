import * as U from "./gen-util.mjs";

export function extForImage(img) {
	const sniffed = U.sniffImageMime(img?.data);
	return U.mimeToExt(sniffed || img?.mimeType || "image/png");
}

export async function planOutputPaths(input) {
	const images = Array.isArray(input.images) ? input.images : [];
	const dir = U.normalizeRel(input.outDir) || U.normalizeRel(input.outputDir) || "generated";
	const explicit = U.normalizeRel(input.out);
	const out = [];
	for (let i = 0; i < images.length; i++) {
		const img = images[i];
		const ext = extForImage(img);
		let rel;
		if (explicit && images.length === 1) {
			rel = /\.[A-Za-z0-9]{2,5}$/.test(explicit) ? explicit : `${explicit}.${ext}`;
		} else if (explicit && i === 0) {
			rel = /\.[A-Za-z0-9]{2,5}$/.test(explicit) ? explicit : `${explicit}.${ext}`;
		} else {
			const base = U.filenameFromTemplate(input.template, {
				slug: input.prompt,
				model: input.model,
				n: i + 1,
			});
			rel = U.joinRel(dir, `${base}${images.length > 1 ? `-${i + 1}` : ""}.${ext}`);
		}
		let final = rel;
		let n = 1;
		while (await input.exists?.(final)) {
			const m = /^(.*?)(\.[A-Za-z0-9]{2,5})$/.exec(rel);
			final = m ? `${m[1]}-${n}${m[2]}` : `${rel}-${n}`;
			n += 1;
			if (n > 200) break;
		}
		out.push({ rel: final, img });
	}
	return out;
}
