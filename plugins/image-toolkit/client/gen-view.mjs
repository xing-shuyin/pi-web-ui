import * as api from "./gen-api.mjs";
import { baseName, copyText, el, fill, fmtBytes, fmtMs, fmtTime, linesToList, parseJsonField } from "./gen-dom.mjs";
import { detectLang, makeT } from "./gen-i18n.mjs";
import { CSS } from "./gen-styles.mjs";

const FIELD_SPECS = {
	authStyle: {
		kind: "select",
		options: ["bearer", "x-api-key", "x-goog-api-key", "api-key", "header", "query", "none"],
	},
	editFields: { kind: "select", options: ["openai", "indexed", "both"], hint: "hint.editFields" },
	responseFormat: { kind: "select", options: ["omit", "b64_json", "url"], hint: "hint.responseFormat" },
	mode: { kind: "select", options: ["auto", "generateContent", "predict"], hint: "hint.mode" },
	endpoint: { kind: "select", options: ["core", "ultra", "sd3"] },
	outputFormat: { kind: "select", options: ["png", "jpeg", "webp"] },
	strength: { kind: "number", hint: "hint.strength" },
	stabilityModel: { kind: "text" },
	modalities: { kind: "lines" },
	workflow: { kind: "json", rows: 8, hint: "hint.workflow" },
	workflowFile: { kind: "text" },
	sizeMap: { kind: "json", rows: 3, label: "svc.sizeMap" },
	qualityMap: { kind: "json", rows: 3, label: "svc.qualityMap" },
	extraHeaders: { kind: "json", rows: 3, label: "svc.extraHeaders" },
	extraBody: { kind: "json", rows: 4, label: "svc.extraBody" },
	query: { kind: "json", rows: 2, label: "svc.query" },
};

const JSON_FIELDS = ["sizeMap", "qualityMap", "extraHeaders", "extraBody", "query"].map((key) => ({
	key,
	...FIELD_SPECS[key],
}));

const EDITOR_GROUPS = [
	{
		key: "model",
		title: "svc.grpModel",
		fields: [
			{ key: "models", kind: "lines", ph: "svc.modelsPh", rows: 4, label: "svc.models" },
			{ key: "defaultModel", kind: "text", label: "svc.defaultModel" },
		],
	},
	{
		key: "params",
		title: "svc.grpParams",
		fields: [
			{ key: "sizes", kind: "lines", ph: "svc.sizesPh", rows: 3, label: "svc.sizes" },
			{ key: "defaultSize", kind: "text", label: "svc.defaultSize" },
			{ key: "qualities", kind: "lines", ph: "svc.qualitiesPh", rows: 2, label: "svc.qualities" },
			{ key: "defaultQuality", kind: "text", label: "svc.defaultQuality" },
			{ key: "timeoutSec", kind: "number", label: "svc.timeout" },
		],
	},
];

const EXAMPLES = [
	"a red apple on a wooden table, soft window light, photorealistic",
	"minimal flat logo for a coffee brand, one color, vector style",
	"cyberpunk street at night, neon reflections in the rain, cinematic",
	"watercolor illustration of a mountain lake at sunrise",
];

const IMAGE_MODEL_HINT =
	/image|flux|dall-?e|imagen|cogview|seedream|seendance|seedance|seaweed|kolors|wanx|recraft|ideogram|stable|sd[0-9.]|sdxl|checkpoint|banana/i;

function guessDefaultModel(list) {
	return list.find((m) => IMAGE_MODEL_HINT.test(String(m))) ?? list[0] ?? "";
}

const STATUS = {
	running: { cls: "run", key: "gen.progress" },
	done: { cls: "ok", key: "gen.done" },
	error: { cls: "err", key: "gen.failed" },
};

const STAGE_KEYS = {
	start: "gen.stageStart",
	request: "gen.stageRequest",
	upload: "gen.stageUpload",
	queue: "gen.stageQueue",
	running: "gen.stageRunning",
	download: "gen.stageDownload",
};

export function mountGenView(container, options = {}) {
	const app = {
		lang: options.getLang ? options.getLang() : detectLang(),
		tab: "gen",
		loading: true,
		config: null,
		shapes: [],
		presets: [],
		jobs: [],
		editId: null,
		draft: null,
		keyClear: false,
		testing: false,
		testOut: null,
		busy: false,
		advanced: false,
		modelsFetch: { busy: false, text: "", ok: null },
		gen: {
			prompt: "",
			service: "",
			model: "",
			size: "",
			quality: "",
			n: 1,
			negative: "",
			seed: "",
			outDir: "",
			refs: [],
		},
		pick: { open: false, dir: "", entries: [], error: "" },
		toast: "",
	};

	const gt = makeT(() => (options.getLang ? options.getLang() : app.lang));
	let toastTimer = null;
	let pollTimer = null;

	function toast(msg) {
		app.toast = String(msg ?? "");
		renderToast();
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => {
			app.toast = "";
			renderToast();
		}, 4200);
	}

	const services = () => app.config?.services ?? [];
	const serviceOf = (id) => services().find((s) => s.id === id) ?? null;
	const enabledServices = () => services().filter((s) => s.enabled !== false);
	const currentService = () => {
		const list = enabledServices();
		return list.find((s) => s.id === app.gen.service) ?? list[0] ?? null;
	};
	const shapeOf = (id) => app.shapes.find((s) => s.id === id) ?? null;
	const presetLabel = (p) => {
		const hit = gt(`preset.${p.id}`);
		return hit === `preset.${p.id}` ? (app.lang === "zh" ? p.label : p.labelEn || p.label) : hit;
	};

	function feedItems() {
		const out = [];
		for (const job of app.jobs ?? []) {
			if (job.status === "done" && Array.isArray(job.files) && job.files.length) {
				for (const f of job.files) out.push({ kind: "image", job, file: f });
			} else {
				out.push({ kind: "job", job });
			}
		}
		return out;
	}

	async function load(silent = false) {
		try {
			const data = await api.getConfig();
			app.config = data.config;
			app.shapes = data.shapes ?? [];
			app.presets = data.presets ?? [];
			app.jobs = data.jobs ?? [];
			if (!app.editId || !serviceOf(app.editId)) app.editId = services()[0]?.id ?? null;
			app.draft = app.editId ? { ...serviceOf(app.editId) } : null;
			if (!currentService() && enabledServices()[0]) app.gen.service = enabledServices()[0].id;
		} catch (err) {
			if (!silent) toast(gt("err.load", { msg: msgOf(err) }));
		} finally {
			app.loading = false;
			render();
		}
	}

	async function refreshJobs() {
		try {
			const jobs = await api.getJobs();
			if (JSON.stringify(jobs) !== JSON.stringify(app.jobs)) {
				app.jobs = jobs;
				renderFeed();
			}
		} catch {}
	}

	const msgOf = (err) => (err instanceof Error ? err.message : String(err));

	function readEditor() {
		const root = paneSvc.querySelector('[data-role="editor"]');
		if (!root) return null;
		const svc = { ...app.draft };
		const shape = shapeOf(svc.shape);
		const specs = [
			{ key: "name", kind: "text" },
			{ key: "baseUrl", kind: "text" },
			{ key: "enabled", kind: "toggle" },
			{ key: "notes", kind: "text" },
			...EDITOR_GROUPS.flatMap((g) => g.fields),
			...(shape?.fields ?? []).filter((f) => FIELD_SPECS[f]).map((f) => ({ key: f, kind: FIELD_SPECS[f].kind })),
			...JSON_FIELDS,
		];
		const seen = new Set();
		for (const spec of specs) {
			if (seen.has(spec.key)) continue;
			seen.add(spec.key);
			const node = root.querySelector(`[data-key="${spec.key}"]`);
			if (!node) continue;
			if (spec.kind === "toggle") svc[spec.key] = Boolean(node.checked);
			else if (spec.kind === "number") svc[spec.key] = Number(node.value) || 0;
			else if (spec.kind === "lines") svc[spec.key] = linesToList(node.value);
			else if (spec.kind === "json") svc[spec.key] = parseJsonField(node.value, gt(spec.label || `svc.${spec.key}`));
			else svc[spec.key] = String(node.value ?? "").trim();
		}
		return svc;
	}

	function readKey() {
		const node = paneSvc.querySelector('[data-role="apikey"]');
		return node ? String(node.value ?? "").trim() : "";
	}

	const rootEl = el("div", { class: "ig" });
	const styleEl = el("style", { text: CSS });
	rootEl.append(styleEl);

	const topbar = el("header", { class: "ig-top" });
	if (options.hideTopbar) topbar.style.display = "none";
	const paneGen = el("section", { class: "ig-pane ig-gen on" });
	const paneSvc = el("section", { class: "ig-pane ig-svc" });
	const paneCfg = el("section", { class: "ig-pane ig-cfg" });
	const panes = el("main", { class: "ig-panes" }, paneGen, paneSvc, paneCfg);
	const overlay = el("div", { class: "ig-overlay", style: { display: "none" } });
	const toastEl = el("div", { class: "ig-toast", style: { display: "none" } });

	rootEl.append(topbar, panes, overlay, toastEl);
	container.append(rootEl);

	function switchTab(next) {
		app.tab = next;
		paneGen.classList.toggle("on", next === "gen");
		paneSvc.classList.toggle("on", next === "svc");
		paneCfg.classList.toggle("on", next === "cfg");
		topbar.querySelectorAll(".ig-tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === next));
		if (next === "svc") renderServices();
		if (next === "cfg") renderConfig();
		if (next === "gen") renderFeed();
	}

	function renderTop() {
		const tabs = [
			{ key: "gen", label: gt("tab.gen") },
			{ key: "svc", label: gt("tab.svc") },
			{ key: "cfg", label: gt("tab.cfg") },
		];
		fill(
			topbar,
			el(
				"div",
				{ class: "ig-brand" },
				el("span", { class: "ig-logo", text: "🎨" }),
				el(
					"div",
					{ class: "ig-brandtext" },
					el("b", { text: gt("app.title") }),
					el("span", { class: "ig-brandsub", text: gt("app.subtitle") }),
				),
			),
			el("div", { class: "ig-spacer" }),
			el(
				"nav",
				{ class: "ig-tabs" },
				...tabs.map((tab) =>
					el("button", {
						class: `ig-tab${app.tab === tab.key ? " on" : ""}`,
						dataset: { tab: tab.key },
						text: tab.label,
						onclick: () => switchTab(tab.key),
					}),
				),
			),
			el("button", {
				class: "ig-btn ig-iconbtn",
				title: gt("app.refresh"),
				onclick: () => load(),
				text: "↻",
			}),
		);
	}

	const feedHead = el("div", { class: "ig-feed-head" });
	const feedBody = el("div", { class: "ig-feed" });
	const dockEl = el("footer", { class: "ig-dock" });
	paneGen.append(feedHead, feedBody, dockEl);

	function renderFeed() {
		const items = feedItems();
		fill(
			feedHead,
			el("b", { text: gt("gen.results") }),
			el("span", { class: "ig-dim", text: `(${items.length})` }),
			el("div", { class: "ig-spacer" }),
			items.length
				? el("button", {
						class: "ig-btn ig-small ig-ghost",
						text: gt("gen.clearJobs"),
						onclick: async () => {
							await api.clearJobs();
							app.jobs = [];
							renderFeed();
						},
					})
				: null,
		);
		if (!items.length) {
			fill(
				feedBody,
				el(
					"div",
					{ class: "ig-empty" },
					el("div", { class: "ig-empty-art", text: "🎨" }),
					el("div", { class: "ig-empty-title", text: gt("gen.emptyTitle") }),
					el("div", { class: "ig-empty-sub", text: gt("gen.empty") }),
					el(
						"div",
						{ class: "ig-examples" },
						...EXAMPLES.map((ex) =>
							el("button", {
								class: "ig-ex",
								text: ex,
								title: ex,
								onclick: () => {
									app.gen.prompt = ex;
									const ta = dockEl.querySelector("textarea");
									if (ta) ta.value = ex;
								},
							}),
						),
					),
				),
			);
			return;
		}
		const grid = el("div", { class: "ig-grid-tiles" });
		for (const it of items) {
			grid.append(it.kind === "image" ? imageTile(it) : jobTile(it.job));
		}
		fill(feedBody, grid);
	}

	function imageTile(it) {
		const { job, file } = it;
		const media = el("div", { class: "ig-media" });
		const img = el("img", {
			src: api.imageUrl(file.path),
			alt: job.prompt || file.path,
			loading: "lazy",
		});
		img.onload = () => {
			const w = img.naturalWidth;
			const h = img.naturalHeight;
			if (!w || !h) return;
			const ratio = Math.min(2.2, Math.max(1 / 2.2, w / h));
			media.style.aspectRatio = String(ratio);
		};
		img.onclick = () => openLightbox(file.path);
		media.append(
			img,
			el("span", { class: "ig-badge", text: [job.size, job.quality].filter(Boolean).join(" · ") || "image" }),
			el(
				"div",
				{ class: "ig-tile-hover", onclick: () => openLightbox(file.path) },
				el("button", {
					class: "ig-btn ig-small",
					text: gt("gen.preview"),
					onclick: (e) => {
						e.stopPropagation();
						openLightbox(file.path);
					},
				}),
				el("button", {
					class: "ig-btn ig-small ig-primary",
					text: gt("gen.editInToolkit"),
					title: gt("gen.editInToolkitHint"),
					onclick: (e) => {
						e.stopPropagation();
						options.onOpenInToolkit?.({ path: file.path, url: api.imageUrl(file.path) });
					},
				}),
				el("button", {
					class: "ig-btn ig-small",
					text: gt("gen.copyPath"),
					onclick: async (e) => {
						e.stopPropagation();
						await copyText(file.path);
						toast(gt("gen.copied"));
					},
				}),
				el("a", {
					class: "ig-btn ig-small",
					href: api.imageUrl(file.path),
					download: baseName(file.path),
					text: gt("gen.download"),
					onclick: (e) => e.stopPropagation(),
				}),
			),
		);
		return el(
			"article",
			{ class: "ig-tile" },
			media,
			el(
				"div",
				{ class: "ig-tile-meta" },
				el("div", { class: "ig-tile-prompt", title: job.prompt, text: job.prompt || file.path }),
				el(
					"div",
					{ class: "ig-tile-line" },
					el("span", {
						class: "ig-dim ig-ellip",
						title: [job.serviceId, job.model].filter(Boolean).join(" · "),
						text: [job.serviceId, job.model].filter(Boolean).join(" · "),
					}),
					el("span", { class: "ig-dim", text: job.ms ? fmtMs(job.ms) : fmtTime(job.startedAt) }),
					el("button", {
						class: "ig-x",
						text: "×",
						title: gt("gen.remove"),
						onclick: async () => {
							try {
								await api.removeJob(job.id);
								app.jobs = app.jobs.filter((j) => j.id !== job.id);
								renderFeed();
							} catch (err) {
								toast(msgOf(err));
							}
						},
					}),
				),
				el(
					"div",
					{ class: "ig-tile-line" },
					el("span", { class: "ig-dim ig-ellip", title: file.path, text: baseName(file.path) }),
					el("span", { class: "ig-dim", text: fmtBytes(file.bytes) }),
				),
			),
		);
	}

	function jobTile(job) {
		const st = STATUS[job.status] ?? STATUS.running;
		if (job.status === "error") {
			return el(
				"article",
				{ class: "ig-tile is-err" },
				el(
					"div",
					{ class: "ig-errbody" },
					el("b", { text: gt("gen.failed") }),
					el("pre", { class: "ig-errtext", text: job.error || "unknown error" }),
					el(
						"div",
						{ class: "ig-actions" },
						el("button", {
							class: "ig-btn ig-small",
							text: gt("gen.retry"),
							onclick: () => {
								triggerGenerate({
									prompt: job.prompt,
									service: job.serviceId,
									model: job.model,
									size: job.size,
									quality: job.quality,
									n: job.n,
								});
							},
						}),
						el("button", {
							class: "ig-btn ig-small ig-ghost",
							text: gt("gen.remove"),
							onclick: async () => {
								await api.removeJob(job.id);
								app.jobs = app.jobs.filter((j) => j.id !== job.id);
								renderFeed();
							},
						}),
					),
				),
			);
		}
		const stageLabel = STAGE_KEYS[job.stage] ? gt(STAGE_KEYS[job.stage]) : job.stage || gt(st.key);
		return el(
			"article",
			{ class: "ig-tile" },
			el(
				"div",
				{ class: "ig-media ig-skel" },
				el(
					"div",
					{ class: "ig-skel-center" },
					el("div", { class: "ig-spin" }),
					el("span", { text: stageLabel }),
					job.detail ? el("span", { class: "ig-dim", text: job.detail }) : null,
				),
			),
			el(
				"div",
				{ class: "ig-tile-meta" },
				el("div", { class: "ig-tile-prompt", text: job.prompt }),
				el(
					"div",
					{ class: "ig-tile-line" },
					el("span", { class: "ig-dim ig-ellip", text: [job.serviceId, job.model].filter(Boolean).join(" · ") }),
					el("span", { class: "ig-dim", text: fmtTime(job.startedAt) }),
				),
			),
		);
	}

	function renderDock() {
		const svc = currentService();
		const chipService = el(
			"label",
			{ class: "ig-chip" },
			el("span", { class: "ig-chip-ico", text: "⚙" }),
			el(
				"select",
				{
					onchange: (e) => {
						app.gen.service = e.target.value;
						const s = serviceOf(app.gen.service);
						if (s) {
							app.gen.model = s.defaultModel || s.models[0] || "";
							app.gen.size = s.defaultSize || s.sizes[0] || "";
							app.gen.quality = s.defaultQuality || s.qualities[0] || "";
						}
						renderDock();
					},
				},
				...enabledServices().map((s) =>
					el("option", { value: s.id, text: s.name, selected: s.id === (svc?.id ?? app.gen.service) }),
				),
			),
		);

		const chipModel = el(
			"label",
			{ class: "ig-chip" },
			el("span", { class: "ig-chip-ico", text: "🧠" }),
			el(
				"select",
				{
					onchange: (e) => (app.gen.model = e.target.value),
				},
				...(svc?.models?.length ? svc.models : [svc?.defaultModel || "default"]).map((m) =>
					el("option", { value: m, text: m, selected: m === (app.gen.model || svc?.defaultModel) }),
				),
			),
		);

		const sizes = svc?.sizes?.length ? svc.sizes : ["1:1", "16:9", "9:16", "4:3", "3:4"];
		const chipSize = el(
			"label",
			{ class: "ig-chip" },
			el("span", { class: "ig-chip-ico", text: "📐" }),
			el(
				"select",
				{
					onchange: (e) => (app.gen.size = e.target.value),
				},
				...sizes.map((s) => el("option", { value: s, text: s, selected: s === (app.gen.size || svc?.defaultSize) })),
			),
		);

		const chipQuality = svc?.qualities?.length
			? el(
					"label",
					{ class: "ig-chip" },
					el("span", { class: "ig-chip-ico", text: "✨" }),
					el(
						"select",
						{
							onchange: (e) => (app.gen.quality = e.target.value),
						},
						...svc.qualities.map((q) =>
							el("option", { value: q, text: q, selected: q === (app.gen.quality || svc?.defaultQuality) }),
						),
					),
				)
			: null;

		const chipN = el(
			"label",
			{ class: "ig-chip", title: gt("gen.count") },
			el("span", { class: "ig-chip-ico", text: "×" }),
			el("input", {
				type: "number",
				min: "1",
				max: String(app.config?.maxImages ?? 8),
				value: String(app.gen.n || 1),
				onchange: (e) => (app.gen.n = Math.max(1, Math.min(8, Number(e.target.value) || 1))),
			}),
		);

		const chipRefs = el(
			"button",
			{
				class: `ig-chip${app.gen.refs.length ? " on" : ""}`,
				onclick: () => openRefPicker(),
			},
			el("span", { class: "ig-chip-ico", text: "🖼" }),
			el("span", { text: app.gen.refs.length ? gt("gen.refsCount", { n: app.gen.refs.length }) : gt("gen.refs") }),
		);

		const refChips = app.gen.refs.map((rel, i) =>
			el(
				"span",
				{ class: "ig-refchip", title: rel },
				el("img", { src: api.imageUrl(rel), alt: "" }),
				el("span", { text: baseName(rel) }),
				el("button", {
					class: "ig-x",
					text: "×",
					onclick: (e) => {
						e.stopPropagation();
						app.gen.refs.splice(i, 1);
						renderDock();
					},
				}),
			),
		);

		const promptBox = el("textarea", {
			rows: "2",
			placeholder: gt("gen.promptPh"),
			value: app.gen.prompt,
			oninput: (e) => (app.gen.prompt = e.target.value),
			onkeydown: (e) => {
				if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
					e.preventDefault();
					triggerGenerate();
				}
			},
		});

		const runBtn = el(
			"button",
			{
				class: "ig-run",
				onclick: () => triggerGenerate(),
			},
			el("span", { text: "✦" }),
			el("span", { text: gt("gen.run") }),
		);

		const advBlock = el(
			"details",
			{ class: "ig-adv" },
			el("summary", { text: gt("gen.advanced") }),
			el(
				"div",
				{ class: "ig-adv-grid" },
				el(
					"label",
					{ class: "ig-field" },
					el("span", { class: "ig-label", text: gt("gen.negative") }),
					el("input", {
						class: "ig-input ig-small",
						placeholder: gt("gen.negativePh"),
						value: app.gen.negative,
						oninput: (e) => (app.gen.negative = e.target.value),
					}),
				),
				el(
					"label",
					{ class: "ig-field" },
					el("span", { class: "ig-label", text: gt("gen.seed") }),
					el("input", {
						class: "ig-input ig-small",
						placeholder: "auto",
						value: app.gen.seed,
						oninput: (e) => (app.gen.seed = e.target.value),
					}),
				),
				el(
					"label",
					{ class: "ig-field" },
					el("span", { class: "ig-label", text: gt("gen.outDir") }),
					el("input", {
						class: "ig-input ig-small",
						placeholder: app.config?.outputDir || "generated",
						value: app.gen.outDir,
						oninput: (e) => (app.gen.outDir = e.target.value),
					}),
				),
			),
		);

		fill(
			dockEl,
			el("div", { class: "ig-chips" }, chipService, chipModel, chipSize, chipQuality, chipN, chipRefs, ...refChips),
			el("div", { class: "ig-prompt" }, promptBox, runBtn),
			advBlock,
		);
	}

	async function triggerGenerate(overrides) {
		const svc = currentService();
		if (!svc) {
			toast(gt("gen.noService"));
			return;
		}
		const input = {
			prompt: app.gen.prompt.trim(),
			service: svc.id,
			model: app.gen.model || svc.defaultModel || "",
			size: app.gen.size || svc.defaultSize || "",
			quality: app.gen.quality || svc.defaultQuality || "",
			n: app.gen.n || 1,
			negative: app.gen.negative.trim() || undefined,
			seed: app.gen.seed ? Number(app.gen.seed) : undefined,
			references: app.gen.refs.length ? app.gen.refs : undefined,
			outDir: app.gen.outDir.trim() || undefined,
			...overrides,
		};
		if (!input.prompt) {
			toast(gt("gen.noPrompt"));
			return;
		}
		try {
			await api.generate(input);
			await refreshJobs();
		} catch (err) {
			toast(msgOf(err));
		}
	}

	function renderServices() {
		const list = services();
		fill(
			paneSvc,
			el(
				"aside",
				{ class: "ig-svc-list" },
				el("div", { class: "ig-svc-listhead" }, el("b", { text: gt("svc.title") }), el("div", { class: "ig-spacer" })),
				el(
					"div",
					{ class: "ig-svc-items" },
					...list.map((s) => {
						const isCur = s.id === app.editId;
						const nokey = !s.hasKey && s.shape !== "comfyui";
						return el(
							"button",
							{
								class: `ig-svc-item${isCur ? " on" : ""}`,
								onclick: () => {
									app.editId = s.id;
									app.draft = { ...s };
									app.testOut = null;
									renderServices();
								},
							},
							el("span", { class: `ig-dot${s.enabled === false ? " off" : nokey ? " nokey" : ""}` }),
							el(
								"div",
								{ class: "ig-svc-text" },
								el("b", { text: s.name }),
								el("span", { class: "ig-dim", text: s.shape }),
							),
						);
					}),
				),
				el(
					"div",
					{ class: "ig-svc-add" },
					el(
						"select",
						{
							class: "ig-input ig-small",
							onchange: async (e) => {
								const val = e.target.value;
								if (!val) return;
								try {
									const res = await api.addPreset(val);
									app.config = res.config;
									app.editId = res.service.id;
									app.draft = { ...res.service };
									renderServices();
								} catch (err) {
									toast(msgOf(err));
								}
								e.target.value = "";
							},
						},
						el("option", { value: "", text: `+ ${gt("svc.add")}…` }),
						...app.presets.map((p) => el("option", { value: p.id, text: presetLabel(p) })),
					),
				),
			),
			renderServiceEditor(),
		);
	}

	function renderServiceEditor() {
		const svc = app.draft;
		if (!svc) {
			return el(
				"div",
				{ class: "ig-svc-editor", style: { display: "flex", alignItems: "center", justifyContent: "center" } },
				el("span", { class: "ig-dim", text: gt("svc.empty") }),
			);
		}
		const shape = shapeOf(svc.shape);
		const form = el("div", { class: "ig-form", dataset: { role: "editor" } });

		form.append(
			el(
				"div",
				{ class: "ig-card" },
				el("div", { class: "ig-card-head" }, el("b", { text: gt("svc.grpBasic") })),
				el(
					"div",
					{ class: "ig-grid2" },
					el(
						"label",
						{ class: "ig-field" },
						el("span", { class: "ig-label", text: gt("svc.name") }),
						el("input", { class: "ig-input", dataset: { key: "name" }, value: svc.name }),
					),
					el(
						"label",
						{ class: "ig-field" },
						el("span", { class: "ig-label", text: gt("svc.baseUrl") }),
						el("input", { class: "ig-input ig-mono", dataset: { key: "baseUrl" }, value: svc.baseUrl }),
					),
				),
				el(
					"label",
					{ class: "ig-field" },
					el(
						"span",
						{ class: "ig-label" },
						el("span", { text: gt("svc.key") }),
						svc.hasKey ? el("span", { class: "ig-dim", text: `(${gt("svc.keySaved")})` }) : null,
					),
					el("input", {
						type: "password",
						class: "ig-input ig-mono",
						dataset: { role: "apikey" },
						placeholder: svc.hasKey ? "••••••••" : gt("svc.keyPh"),
					}),
				),
			),
		);

		for (const grp of EDITOR_GROUPS) {
			form.append(
				el(
					"div",
					{ class: "ig-card" },
					el("div", { class: "ig-card-head" }, el("b", { text: gt(grp.title) })),
					...grp.fields.map((f) => {
						const isArr = f.kind === "lines";
						const val = isArr ? (svc[f.key] ?? []).join("\n") : (svc[f.key] ?? "");
						return el(
							"label",
							{ class: "ig-field" },
							el(
								"span",
								{ class: "ig-label" },
								el("span", { text: gt(f.label) }),
								f.key === "models"
									? el("button", {
											class: "ig-btn ig-small",
											style: { marginLeft: "auto" },
											text: app.modelsFetch.busy ? gt("svc.fetching") : gt("svc.fetchModels"),
											onclick: async (e) => {
												e.preventDefault();
												app.modelsFetch.busy = true;
												renderServices();
												try {
													const draft = readEditor();
													const key = readKey();
													const res = await api.fetchModels(svc.id, { service: draft, apiKey: key });
													if (res.models && res.models.length) {
														const next = [...new Set([...(draft.models || []), ...res.models])];
														app.draft = {
															...draft,
															models: next,
															defaultModel: draft.defaultModel || guessDefaultModel(next),
														};
														toast(gt("svc.fetchOk", { n: res.models.length }));
													} else {
														toast(gt("svc.fetchNone"));
													}
												} catch (err) {
													toast(gt("svc.fetchFail", { msg: msgOf(err) }));
												} finally {
													app.modelsFetch.busy = false;
													renderServices();
												}
											},
										})
									: null,
							),
							isArr
								? el("textarea", {
										class: "ig-area ig-mono",
										rows: String(f.rows || 3),
										dataset: { key: f.key },
										value: val,
									})
								: el("input", { class: "ig-input", dataset: { key: f.key }, value: String(val) }),
						);
					}),
				),
			);
		}

		const bodyEl = el("div", { class: "ig-svc-editorbody" }, form);
		const footerEl = el(
			"div",
			{ class: "ig-svc-footer" },
			el("button", {
				class: "ig-btn ig-primary",
				text: gt("svc.save"),
				onclick: async () => {
					try {
						const nextSvc = readEditor();
						const key = readKey();
						const apiKeys = {};
						if (key) apiKeys[svc.id] = key;
						const nextServices = services().map((s) => (s.id === svc.id ? { ...nextSvc, id: s.id } : s));
						const res = await api.saveConfig({ ...app.config, services: nextServices }, apiKeys);
						app.config = res;
						app.draft = { ...serviceOf(svc.id) };
						toast(gt("svc.saved"));
						renderServices();
					} catch (err) {
						toast(msgOf(err));
					}
				},
			}),
			el("button", {
				class: "ig-btn",
				text: app.testing ? gt("svc.testing") : gt("svc.test"),
				onclick: async () => {
					app.testing = true;
					app.testOut = null;
					renderServices();
					try {
						const draft = readEditor();
						const key = readKey();
						const res = await api.probe(svc.id, { service: draft, apiKey: key });
						app.testOut = res;
					} catch (err) {
						app.testOut = { ok: false, detail: msgOf(err) };
					} finally {
						app.testing = false;
						renderServices();
					}
				},
			}),
			el("button", {
				class: "ig-btn ig-danger ig-ghost",
				text: gt("svc.delete"),
				onclick: async () => {
					if (!confirm(gt("svc.deleteConfirm", { name: svc.name }))) return;
					const nextServices = services().filter((s) => s.id !== svc.id);
					const res = await api.saveConfig({ ...app.config, services: nextServices }, { [svc.id]: "" });
					app.config = res;
					app.editId = services()[0]?.id ?? null;
					app.draft = app.editId ? { ...serviceOf(app.editId) } : null;
					renderServices();
				},
			}),
		);

		if (app.testOut) {
			footerEl.append(
				el("div", {
					class: `ig-testout ${app.testOut.ok ? "good" : "bad"}`,
					text: `${app.testOut.ok ? gt("svc.testOk") : gt("svc.testFail")}：${app.testOut.detail || ""}`,
				}),
			);
		}

		return el("div", { class: "ig-svc-editor" }, bodyEl, footerEl);
	}

	function renderConfig() {
		const cfg = app.config ?? {};
		fill(
			paneCfg,
			el(
				"div",
				{ class: "ig-card", style: { maxWidth: "600px" } },
				el("div", { class: "ig-card-head" }, el("b", { text: gt("cfg.title") })),
				el(
					"label",
					{ class: "ig-field" },
					el("span", { class: "ig-label", text: gt("cfg.defaultService") }),
					el(
						"select",
						{
							class: "ig-input",
							onchange: (e) => (cfg.defaultService = e.target.value),
						},
						el("option", { value: "", text: "(none)" }),
						...services().map((s) =>
							el("option", { value: s.id, text: s.name, selected: s.id === cfg.defaultService }),
						),
					),
				),
				el(
					"label",
					{ class: "ig-field" },
					el("span", { class: "ig-label", text: gt("cfg.outputDir") }),
					el("input", {
						class: "ig-input",
						value: cfg.outputDir || "generated",
						oninput: (e) => (cfg.outputDir = e.target.value),
					}),
				),
				el(
					"label",
					{ class: "ig-field" },
					el("span", { class: "ig-label", text: gt("cfg.template") }),
					el("input", {
						class: "ig-input",
						value: cfg.filenameTemplate || "{date}-{time}-{slug}",
						oninput: (e) => (cfg.filenameTemplate = e.target.value),
					}),
					el("span", { class: "ig-hint", text: gt("cfg.templateHint") }),
				),
				el(
					"label",
					{ class: "ig-switch" },
					el("input", {
						type: "checkbox",
						checked: cfg.returnImage !== false,
						onchange: (e) => (cfg.returnImage = e.target.checked),
					}),
					el("span", { text: gt("cfg.returnImage") }),
				),
				el("span", { class: "ig-hint", text: gt("cfg.returnImageHint") }),
				el(
					"div",
					{ class: "ig-actions", style: { marginTop: "10px" } },
					el("button", {
						class: "ig-btn ig-primary",
						text: gt("cfg.save"),
						onclick: async () => {
							try {
								const res = await api.saveConfig(cfg);
								app.config = res;
								toast(gt("cfg.saved"));
							} catch (err) {
								toast(msgOf(err));
							}
						},
					}),
				),
			),
		);
	}

	function renderToast() {
		if (!app.toast) {
			toastEl.style.display = "none";
			return;
		}
		toastEl.style.display = "block";
		fill(toastEl, el("div", { class: "ig-toast-card", text: app.toast }));
	}

	function openLightbox(path) {
		const accepted = window.__piWebUiHost?.openImagePreview?.({
			src: api.imageUrl(path),
			alt: baseName(path),
			actions: [
				{
					id: "edit",
					label: gt("gen.editInToolkit"),
					closeOnSelect: true,
					onSelect: () => options.onOpenInToolkit?.({ path, url: api.imageUrl(path) }),
				},
				{
					id: "reference",
					label: gt("gen.useAsRef"),
					closeOnSelect: true,
					onSelect: () => {
						addReference(path);
						toast(gt("gen.refsCount", { n: app.gen.refs.length }));
					},
				},
				{
					id: "copy",
					label: gt("gen.copyPath"),
					onSelect: async () => {
						await copyText(path);
						toast(gt("gen.copied"));
					},
				},
				{
					id: "download",
					label: gt("gen.download"),
					onSelect: () => {
						const link = document.createElement("a");
						link.href = api.imageUrl(path);
						link.download = baseName(path);
						document.body.append(link);
						link.click();
						link.remove();
					},
				},
			],
		});
		if (!accepted) window.open(api.imageUrl(path), "_blank", "noopener,noreferrer");
	}

	function renderOverlay() {
		if (app.pick.open) {
			renderPicker();
			overlay.style.display = "flex";
			return;
		}
		overlay.style.display = "none";
	}

	async function openRefPicker(dir = "") {
		app.pick.open = true;
		app.pick.dir = dir;
		app.pick.entries = [];
		renderOverlay();
		try {
			const res = await api.listDir(dir);
			app.pick.entries = res.entries ?? [];
		} catch (err) {
			app.pick.error = msgOf(err);
		}
		renderOverlay();
	}

	function renderPicker() {
		const modal = el(
			"div",
			{ class: "ig-modal" },
			el(
				"div",
				{ class: "ig-modalbar" },
				el("b", { text: gt("modal.refs") }),
				el("span", { class: "ig-dim", text: app.pick.dir ? `/${app.pick.dir}` : "/(root)" }),
				el("div", { class: "ig-spacer" }),
				app.pick.dir
					? el("button", {
							class: "ig-btn ig-small",
							text: "↑ " + gt("modal.up"),
							onclick: () => {
								const up = app.pick.dir.split("/").slice(0, -1).join("/");
								openRefPicker(up);
							},
						})
					: null,
				el("button", {
					class: "ig-btn ig-small ig-ghost",
					text: "✕",
					onclick: () => {
						app.pick.open = false;
						renderOverlay();
					},
				}),
			),
		);
		const grid = el("div", { class: "ig-pickgrid" });
		for (const e of app.pick.entries) {
			if (e.type === "dir") {
				grid.append(
					el("button", {
						class: "ig-diritem",
						text: `📁 ${e.name}`,
						onclick: () => openRefPicker(e.path),
					}),
				);
			} else if (e.isImage) {
				const isPicked = app.gen.refs.includes(e.path);
				grid.append(
					el(
						"div",
						{
							class: `ig-pickitem${isPicked ? " on" : ""}`,
							onclick: () => {
								if (isPicked) app.gen.refs = app.gen.refs.filter((r) => r !== e.path);
								else if (app.gen.refs.length < 8) app.gen.refs.push(e.path);
								renderDock();
								renderPicker();
							},
						},
						el("img", { src: api.imageUrl(e.path), alt: "" }),
						el("span", { text: e.name }),
					),
				);
			}
		}
		modal.append(grid);
		fill(overlay, modal);
	}

	function addReference(path) {
		const p = String(path ?? "").trim();
		if (!p) return;
		if (!app.gen.refs.includes(p)) {
			if (app.gen.refs.length >= 8) app.gen.refs.shift();
			app.gen.refs.push(p);
		}
		renderDock();
	}

	function render() {
		renderTop();
		renderDock();
		renderFeed();
		if (app.tab === "svc") renderServices();
		if (app.tab === "cfg") renderConfig();
	}

	const offData = options.ctx?.onData?.((data) => {
		if (data?.kind === "config") {
			app.config = data.config;
			renderServices();
			renderDock();
		} else if (data?.kind === "jobs") {
			app.jobs = data.jobs ?? [];
			renderFeed();
		}
	});

	pollTimer = setInterval(() => {
		if ((app.jobs ?? []).some((j) => j.status === "running")) refreshJobs();
	}, 2500);

	load();

	return {
		rootEl,
		load,
		addReference,
		switchTab,
		refreshJobs,
		clearJobs: async () => {
			await api.clearJobs();
			app.jobs = [];
			renderFeed();
		},
		unmount() {
			clearInterval(pollTimer);
			clearTimeout(toastTimer);
			offData?.();
			rootEl.remove();
		},
	};
}
