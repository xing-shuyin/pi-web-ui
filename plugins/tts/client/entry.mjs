import { detectLang, makeT } from "./i18n.mjs";

/** Follow the dingtalk pattern: static texts carry data-i18n and are refilled in place on locale change. */
function applyStaticTexts(root, t) {
	const scope = root ?? document;
	scope.querySelectorAll("[data-i18n]").forEach((n) => {
		const k = n.getAttribute("data-i18n");
		if (k) n.textContent = t(k);
	});
	scope.querySelectorAll("[data-i18n-ph]").forEach((n) => {
		const k = n.getAttribute("data-i18n-ph");
		if (k) n.setAttribute("placeholder", t(k));
	});
	scope.querySelectorAll("[data-i18n-title]").forEach((n) => {
		const k = n.getAttribute("data-i18n-title");
		if (k) n.setAttribute("title", t(k));
	});
}

export default {
	mount(el, ctx) {
		/** Panel copy: parsing / fallback / interpolation live in the SDK; read from the host locale here. */
		const t = makeT();
		/** 服务端引擎 / 音色自带 label 与 labelEn，非中文界面取后者（id 与协议不动）。 */
		const zh = detectLang() === "zh";
		const labelOf = (item) => (zh ? item?.label : item?.labelEn || item?.label) || "";

		el.innerHTML = `
      <div class="tts-container" style="max-width: 680px; margin: 0 auto; padding: 24px 16px; font-family: system-ui, -apple-system, sans-serif; color: var(--text, #e4e4e7); line-height: 1.5;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.08)); padding-bottom: 16px;">
          <div>
            <h2 data-i18n="app.title" style="margin: 0 0 4px 0; font-size: 20px; font-weight: 600; display: flex; align-items: center; gap: 8px;">
              <span>🔊</span> ${t("app.title")}
            </h2>
            <div data-i18n="app.subtitle" style="font-size: 13px; color: var(--text-dim, #a1a1aa);">
              ${t("app.subtitle")}
            </div>
          </div>
          <button id="btn-refresh-status" data-i18n="refresh" style="background: transparent; border: 1px solid var(--border-subtle, #3f3f46); color: inherit; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px;">
            🔄 ${t("refresh")}
          </button>
        </div>

        <!-- 1. Dual-engine credential status cards -->
        <div style="background: var(--bg-elev, rgba(255,255,255,0.03)); border: 1px solid var(--border-subtle, rgba(255,255,255,0.08)); border-radius: 10px; padding: 18px; margin-bottom: 20px;">
          <!-- Anti-ban notice and camouflage hardening card -->
          <div style="background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.25); border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; font-size: 12px; line-height: 1.6;">
            <div style="font-weight: 600; color: #fbbf24; display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
              <span>🛡️</span> <span data-i18n="risk.title">${t("risk.title")}</span>
            </div>
            <div style="color: var(--text-dim, #a1a1aa);">
              ${t("risk.bodyLead")}<b>${t("risk.bodySession")}</b>${t("risk.bodyMiddle")}<b>${t("risk.bodyDoubao")}</b>${t("risk.bodyTail")}
            </div>
          </div>

          <div data-i18n="creds.title" style="font-weight: 600; font-size: 14px; margin-bottom: 12px;">${t("creds.title")}</div>
          
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
            <!-- Doubao status -->
            <div style="background: rgba(0,0,0,0.2); border: 1px solid var(--border-subtle, #3f3f46); border-radius: 8px; padding: 12px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <span style="font-size: 13px; font-weight: 500;">${t("doubao.name")}</span>
                <span id="doubao-badge" style="font-size: 11px; padding: 2px 6px; border-radius: 9999px; background: rgba(234, 179, 8, 0.15); color: #eab308;">${t("checking")}</span>
              </div>
              <div id="doubao-detail" style="font-size: 11px; color: var(--text-dim, #71717a);">
                ${t("doubao.detail")}
              </div>
            </div>

            <!-- DeepSeek status -->
            <div style="background: rgba(0,0,0,0.2); border: 1px solid var(--border-subtle, #3f3f46); border-radius: 8px; padding: 12px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <span style="font-size: 13px; font-weight: 500;">${t("deepseek.name")}</span>
                <span id="deepseek-badge" style="font-size: 11px; padding: 2px 6px; border-radius: 9999px; background: rgba(234, 179, 8, 0.15); color: #eab308;">${t("checking")}</span>
              </div>
              <div id="deepseek-detail" style="font-size: 11px; color: var(--text-dim, #71717a);">
                ${t("deepseek.detail")}
              </div>
              <div style="font-size: 11px; color: #f59e0b; margin-top: 5px; display: flex; align-items: center; gap: 4px;">
                <span>⚠️</span> ${t("deepseek.warn")}
              </div>
            </div>
          </div>

          <!-- Companion extension install and locate section -->
          <div style="border-top: 1px dashed var(--border-subtle, rgba(255,255,255,0.08)); padding-top: 14px;">
            <div data-i18n="extension.title" style="font-weight: 500; font-size: 13px; margin-bottom: 8px;">📦 ${t("extension.title")}</div>
            <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px;">
              <button id="btn-open-dir" data-i18n="extension.openDir" style="background: var(--blue); color: var(--on-blue); border: none; padding: 7px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; display: flex; align-items: center; gap: 6px;">
                📂 ${t("extension.openDir")}
              </button>
              <button id="btn-download-zip" data-i18n="extension.downloadZip" style="background: rgba(255,255,255,0.08); color: inherit; border: 1px solid var(--border-subtle, #3f3f46); padding: 7px 14px; border-radius: 6px; cursor: pointer; font-size: 13px;">
                📥 ${t("extension.downloadZip")}
              </button>
              <button id="btn-reset-ds-session" data-i18n="extension.resetSession" style="background: transparent; color: #fbbf24; border: 1px solid rgba(251, 191, 36, 0.3); padding: 7px 12px; border-radius: 6px; cursor: pointer; font-size: 12px;">
                🔄 ${t("extension.resetSession")}
              </button>
              <button id="btn-clear-creds" data-i18n="extension.clearCreds" style="background: transparent; color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3); padding: 7px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; margin-left: auto;">
                ${t("extension.clearCreds")}
              </button>
            </div>

            <div style="background: rgba(0,0,0,0.25); border-radius: 6px; padding: 12px; font-size: 12px; color: var(--text-dim, #a1a1aa); line-height: 1.6;">
              <b>${t("guide.lead")}</b> ${t("guide.beforeCode")} <code>chrome://extensions</code> ${t("guide.afterCode")}
            </div>
          </div>
        </div>

        <!-- 2. Live preview test panel -->
        <div style="background: var(--bg-elev, rgba(255,255,255,0.03)); border: 1px solid var(--border-subtle, rgba(255,255,255,0.08)); border-radius: 10px; padding: 18px;">
          <h3 data-i18n="test.title" style="margin: 0 0 14px 0; font-size: 15px; font-weight: 600;">🎙️ ${t("test.title")}</h3>
          
          <div id="engine-risk-tip" style="display: none; background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.25); border-radius: 6px; padding: 8px 12px; margin-bottom: 12px; font-size: 12px; color: #fbbf24; line-height: 1.5;">
            🛡️ <b>${t("test.riskLabel")}</b>${t("test.riskBody")}
          </div>

          <div style="display: flex; gap: 12px; margin-bottom: 12px; flex-wrap: wrap;">
            <div style="flex: 1; min-width: 140px;">
              <label style="display: block; font-size: 12px; color: var(--text-dim, #a1a1aa); margin-bottom: 6px;">${t("test.engine")}</label>
              <select id="sel-engine" style="width: 100%; padding: 7px 10px; background: var(--bg-input, #27272a); border: 1px solid var(--border-subtle, #3f3f46); border-radius: 6px; color: inherit; font-size: 13px;">
                <option value="doubao">${t("engine.doubao")}</option>
                <option value="deepseek">${t("engine.deepseek")}</option>
              </select>
            </div>

            <div style="flex: 1; min-width: 180px;">
              <label style="display: block; font-size: 12px; color: var(--text-dim, #a1a1aa); margin-bottom: 6px;">${t("test.speaker")}</label>
              <select id="sel-speaker" style="width: 100%; padding: 7px 10px; background: var(--bg-input, #27272a); border: 1px solid var(--border-subtle, #3f3f46); border-radius: 6px; color: inherit; font-size: 13px;">
                <!-- filled dynamically -->
              </select>
            </div>
          </div>

          <div style="margin-bottom: 14px;">
            <label style="display: block; font-size: 12px; color: var(--text-dim, #a1a1aa); margin-bottom: 6px;">${t("test.text")}</label>
            <textarea id="inp-text" rows="3" style="width: 100%; padding: 10px; background: var(--bg-input, #27272a); border: 1px solid var(--border-subtle, #3f3f46); border-radius: 6px; color: inherit; font-size: 13px; box-sizing: border-box; resize: vertical;">${t("test.sample")}</textarea>
          </div>

          <div style="display: flex; align-items: center; gap: 12px;">
            <button id="btn-speak" style="background: var(--green); color: var(--on-green); border: none; padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600;">
              ▶️ ${t("test.speak")}
            </button>
            <span id="speak-status" style="font-size: 12px; color: var(--text-dim, #a1a1aa);"></span>
          </div>

          <div id="player-container" style="margin-top: 14px; display: none;">
            <audio id="audio-player" controls style="width: 100%; border-radius: 8px;"></audio>
          </div>
        </div>
      </div>
    `;

		const doubaoBadge = el.querySelector("#doubao-badge");
		const doubaoDetail = el.querySelector("#doubao-detail");
		const deepseekBadge = el.querySelector("#deepseek-badge");
		const deepseekDetail = el.querySelector("#deepseek-detail");

		const selEngine = el.querySelector("#sel-engine");
		const selSpeaker = el.querySelector("#sel-speaker");
		const engineRiskTip = el.querySelector("#engine-risk-tip");
		const btnSpeak = el.querySelector("#btn-speak");
		const speakStatus = el.querySelector("#speak-status");
		const audioPlayer = el.querySelector("#audio-player");
		const playerContainer = el.querySelector("#player-container");

		function updateSpeakerOptions() {
			selSpeaker.replaceChildren(new Option(t("defaultVoice"), ""));
			if (engineRiskTip) engineRiskTip.style.display = selEngine.value === "deepseek-tts" ? "block" : "none";
			ctx.send({ action: "get-voices", engine: selEngine.value });
		}
		selEngine.onchange = updateSpeakerOptions;

		function refreshStatus() {
			ctx.send({ action: "get-status" });
		}

		const off = ctx.onData((msg) => {
			if (!msg) return;
			if (msg.engines) {
				const previous = ["doubao", "deepseek"].includes(selEngine.value) ? `${selEngine.value}-tts` : selEngine.value;
				selEngine.replaceChildren(...msg.engines.map((engine) => new Option(labelOf(engine), engine.id)));
				if (msg.engines.some((engine) => engine.id === previous)) selEngine.value = previous;
				updateSpeakerOptions();
			}
			if (msg.type === "voices-response" && msg.engine === selEngine.value) {
				selSpeaker.replaceChildren(
					new Option(t("defaultVoice"), ""),
					...(msg.voices || []).map((voice) => new Option(labelOf(voice), voice.id)),
				);
				if (msg.error) speakStatus.textContent = msg.error;
			}

			if (msg.type === "status-response" || msg.type === "credentials-updated") {
				if (msg.hasDoubao || msg.hasDoubaoApiKey) {
					doubaoBadge.style.background = "rgba(34, 197, 94, 0.15)";
					doubaoBadge.style.color = "#22c55e";
					doubaoBadge.innerText = msg.hasDoubaoApiKey ? t("doubao.badgeApiKey") : t("doubao.badgeCookie");
					doubaoDetail.innerText = t("doubao.detailReady");
				} else {
					doubaoBadge.style.background = "rgba(234, 179, 8, 0.15)";
					doubaoBadge.style.color = "#eab308";
					doubaoBadge.innerText = t("badgeMissing");
					doubaoDetail.innerText = t("doubao.detailMissing");
				}

				if (msg.hasDeepseek) {
					deepseekBadge.style.background = "rgba(34, 197, 94, 0.15)";
					deepseekBadge.style.color = "#22c55e";
					deepseekBadge.innerText = t("deepseek.badgeReady");
					deepseekDetail.innerText = t("deepseek.detailReady");
				} else {
					deepseekBadge.style.background = "rgba(234, 179, 8, 0.15)";
					deepseekBadge.style.color = "#eab308";
					deepseekBadge.innerText = t("badgeMissing");
					deepseekDetail.innerText = t("deepseek.detailMissing");
				}
			}

			if (msg.type === "speak-result") {
				btnSpeak.disabled = false;
				if (msg.success && msg.audioBase64) {
					speakStatus.innerText = t("test.success");
					speakStatus.style.color = "#22c55e";
					const mime =
						{ wav: "audio/wav", mp3: "audio/mpeg", aac: "audio/aac", ogg: "audio/ogg" }[msg.format] || "audio/wav";
					audioPlayer.src = `data:${mime};base64,${msg.audioBase64}`;
					playerContainer.style.display = "block";
					audioPlayer.play().catch(() => {});
				} else {
					speakStatus.innerText = t("test.failed", { error: msg.error || t("unknownError") });
					speakStatus.style.color = "#ef4444";
				}
			}
		});

		el.querySelector("#btn-refresh-status").onclick = refreshStatus;
		el.querySelector("#btn-open-dir").onclick = () => fetch("/plugins-api/tts/open-folder", { method: "POST" });
		el.querySelector("#btn-download-zip").onclick = () => window.open("/plugins-api/tts/download-extension", "_blank");
		el.querySelector("#btn-reset-ds-session").onclick = () => {
			ctx.send({ action: "reset-deepseek-session" });
			alert(t("alert.sessionReset"));
		};
		el.querySelector("#btn-clear-creds").onclick = () => {
			if (confirm(t("confirm.clearCreds"))) ctx.send({ action: "clear-credentials" });
		};

		btnSpeak.onclick = () => {
			const text = el.querySelector("#inp-text").value.trim();
			if (!text) return;
			btnSpeak.disabled = true;
			speakStatus.textContent = t("test.synthRunning");
			ctx.send({ action: "test-speak", text, engine: selEngine.value, speaker: selSpeaker.value });
		};

		refreshStatus();

		// Host locale is the single source of truth: refill static texts and dynamic selects in place.
		let offLocale = null;
		let onLocaleEvent = null;
		const relabel = () => {
			try {
				applyStaticTexts(el, t);
			} catch {}
			try {
				updateSpeakerOptions();
			} catch {}
			try {
				refreshStatus();
			} catch {}
		};
		try {
			offLocale = globalThis.window?.__piWebUiHost?.locale?.onChange?.(() => relabel()) ?? null;
		} catch {
			offLocale = null;
		}
		try {
			onLocaleEvent = () => relabel();
			globalThis.window?.addEventListener("pi-web-ui:locale", onLocaleEvent);
		} catch {
			onLocaleEvent = null;
		}

		return () => {
			try {
				offLocale?.();
			} catch {}
			try {
				if (onLocaleEvent) globalThis.window?.removeEventListener("pi-web-ui:locale", onLocaleEvent);
			} catch {}
			off?.();
		};
	},
};
