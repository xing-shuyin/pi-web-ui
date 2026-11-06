export default {
	mount(el, ctx) {
		el.innerHTML = `
      <div class="tts-container" style="max-width: 680px; margin: 0 auto; padding: 24px 16px; font-family: system-ui, -apple-system, sans-serif; color: var(--text, #e4e4e7); line-height: 1.5;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.08)); padding-bottom: 16px;">
          <div>
            <h2 style="margin: 0 0 4px 0; font-size: 20px; font-weight: 600; display: flex; align-items: center; gap: 8px;">
              <span>🔊</span> 多源语音合成助手 (TTS)
            </h2>
            <div style="font-size: 13px; color: var(--text-dim, #a1a1aa);">
              聚合豆包大模型与 DeepSeek 官方语音，支持伴侣扩展一键同步与系统全功能流式朗读
            </div>
          </div>
          <button id="btn-refresh-status" style="background: transparent; border: 1px solid var(--border-subtle, #3f3f46); color: inherit; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px;">
            🔄 刷新状态
          </button>
        </div>

        <!-- 1. 双引擎凭据状态卡片 -->
        <div style="background: var(--bg-elev, rgba(255,255,255,0.03)); border: 1px solid var(--border-subtle, rgba(255,255,255,0.08)); border-radius: 10px; padding: 18px; margin-bottom: 20px;">
          <!-- 封号风控警示与伪装加固卡片 -->
          <div style="background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.25); border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; font-size: 12px; line-height: 1.6;">
            <div style="font-weight: 600; color: #fbbf24; display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
              <span>🛡️</span> <span>已启用防风控伪装模型（专属会话复用 + 浏览器真实标头对齐）</span>
            </div>
            <div style="color: var(--text-dim, #a1a1aa);">
              现已彻底移除脚本自曝特征，并采用<b>专属持久化会话复用</b>（杜绝频繁秒建秒删会话的高危特征）与人性化防抖排队。但因 DeepSeek 官方未开放独立 TTS 接口，长文本流式伴读仍存在被官方风控限制的可能，日常推荐优先使用<b>豆包语音</b>（正规 API Key 通道，稳定免封）。
            </div>
          </div>

          <div style="font-weight: 600; font-size: 14px; margin-bottom: 12px;">凭据就绪状态</div>
          
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
            <!-- 豆包状态 -->
            <div style="background: rgba(0,0,0,0.2); border: 1px solid var(--border-subtle, #3f3f46); border-radius: 8px; padding: 12px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <span style="font-size: 13px; font-weight: 500;">豆包语音</span>
                <span id="doubao-badge" style="font-size: 11px; padding: 2px 6px; border-radius: 9999px; background: rgba(234, 179, 8, 0.15); color: #eab308;">检测中...</span>
              </div>
              <div id="doubao-detail" style="font-size: 11px; color: var(--text-dim, #71717a);">
                支持网页 Cookie 或火山引擎 Key
              </div>
            </div>

            <!-- DeepSeek 状态 -->
            <div style="background: rgba(0,0,0,0.2); border: 1px solid var(--border-subtle, #3f3f46); border-radius: 8px; padding: 12px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <span style="font-size: 13px; font-weight: 500;">DeepSeek 语音</span>
                <span id="deepseek-badge" style="font-size: 11px; padding: 2px 6px; border-radius: 9999px; background: rgba(234, 179, 8, 0.15); color: #eab308;">检测中...</span>
              </div>
              <div id="deepseek-detail" style="font-size: 11px; color: var(--text-dim, #71717a);">
                支持 chat.deepseek.com 凭证
              </div>
              <div style="font-size: 11px; color: #f59e0b; margin-top: 5px; display: flex; align-items: center; gap: 4px;">
                <span>⚠️</span> 易触发网页封号风控，建议慎用
              </div>
            </div>
          </div>

          <!-- 伴侣扩展安装与定位操作区 -->
          <div style="border-top: 1px dashed var(--border-subtle, rgba(255,255,255,0.08)); padding-top: 14px;">
            <div style="font-weight: 500; font-size: 13px; margin-bottom: 8px;">📦 伴侣扩展（一键提取双平台凭证）</div>
            <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px;">
              <button id="btn-open-dir" style="background: var(--blue); color: var(--on-blue); border: none; padding: 7px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; display: flex; align-items: center; gap: 6px;">
                📂 在电脑中定位扩展目录
              </button>
              <button id="btn-download-zip" style="background: rgba(255,255,255,0.08); color: inherit; border: 1px solid var(--border-subtle, #3f3f46); padding: 7px 14px; border-radius: 6px; cursor: pointer; font-size: 13px;">
                📥 下载扩展压缩包 (.zip)
              </button>
              <button id="btn-reset-ds-session" style="background: transparent; color: #fbbf24; border: 1px solid rgba(251, 191, 36, 0.3); padding: 7px 12px; border-radius: 6px; cursor: pointer; font-size: 12px;">
                🔄 重置 DeepSeek 会话
              </button>
              <button id="btn-clear-creds" style="background: transparent; color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3); padding: 7px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; margin-left: auto;">
                清空本地凭证
              </button>
            </div>

            <div style="background: rgba(0,0,0,0.25); border-radius: 6px; padding: 12px; font-size: 12px; color: var(--text-dim, #a1a1aa); line-height: 1.6;">
              <b>极速加载指南：</b> 打开 <code>chrome://extensions</code> 开启开发者模式，点击上方【在电脑中定位扩展目录】把弹出的文件夹拖入浏览器即可。在豆包或 DeepSeek 网页点一下扩展图标秒级完成同步！
            </div>
          </div>
        </div>

        <!-- 2. 在线试听测试面板 -->
        <div style="background: var(--bg-elev, rgba(255,255,255,0.03)); border: 1px solid var(--border-subtle, rgba(255,255,255,0.08)); border-radius: 10px; padding: 18px;">
          <h3 style="margin: 0 0 14px 0; font-size: 15px; font-weight: 600;">🎙️ 在线试听测试</h3>
          
          <div id="engine-risk-tip" style="display: none; background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.25); border-radius: 6px; padding: 8px 12px; margin-bottom: 12px; font-size: 12px; color: #fbbf24; line-height: 1.5;">
            🛡️ <b>提示</b>：当前选择 DeepSeek 语音引擎。已启用专属会话长期复用与真实浏览器标头伪装，已避免秒建秒删与机器人特征。高频长文本伴读仍建议优先使用豆包语音。
          </div>

          <div style="display: flex; gap: 12px; margin-bottom: 12px; flex-wrap: wrap;">
            <div style="flex: 1; min-width: 140px;">
              <label style="display: block; font-size: 12px; color: var(--text-dim, #a1a1aa); margin-bottom: 6px;">语音引擎</label>
              <select id="sel-engine" style="width: 100%; padding: 7px 10px; background: var(--bg-input, #27272a); border: 1px solid var(--border-subtle, #3f3f46); border-radius: 6px; color: inherit; font-size: 13px;">
                <option value="doubao">豆包大模型语音 (Doubao)</option>
                <option value="deepseek">DeepSeek 官方语音</option>
              </select>
            </div>

            <div style="flex: 1; min-width: 180px;">
              <label style="display: block; font-size: 12px; color: var(--text-dim, #a1a1aa); margin-bottom: 6px;">发音角色</label>
              <select id="sel-speaker" style="width: 100%; padding: 7px 10px; background: var(--bg-input, #27272a); border: 1px solid var(--border-subtle, #3f3f46); border-radius: 6px; color: inherit; font-size: 13px;">
                <!-- 动态填充 -->
              </select>
            </div>
          </div>

          <div style="margin-bottom: 14px;">
            <label style="display: block; font-size: 12px; color: var(--text-dim, #a1a1aa); margin-bottom: 6px;">测试文本</label>
            <textarea id="inp-text" rows="3" style="width: 100%; padding: 10px; background: var(--bg-input, #27272a); border: 1px solid var(--border-subtle, #3f3f46); border-radius: 6px; color: inherit; font-size: 13px; box-sizing: border-box; resize: vertical;">煮栗子前可以用刀在背部划一道口，水开后煮二十分钟即可轻松剥壳。</textarea>
          </div>

          <div style="display: flex; align-items: center; gap: 12px;">
            <button id="btn-speak" style="background: var(--green); color: var(--on-green); border: none; padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600;">
              ▶️ 开始试听合成
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
			selSpeaker.replaceChildren(new Option("默认音色", ""));
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
				selEngine.replaceChildren(...msg.engines.map((engine) => new Option(engine.label, engine.id)));
				if (msg.engines.some((engine) => engine.id === previous)) selEngine.value = previous;
				updateSpeakerOptions();
			}
			if (msg.type === "voices-response" && msg.engine === selEngine.value) {
				selSpeaker.replaceChildren(
					new Option("默认音色", ""),
					...(msg.voices || []).map((voice) => new Option(voice.label, voice.id)),
				);
				if (msg.error) speakStatus.textContent = msg.error;
			}

			if (msg.type === "status-response" || msg.type === "credentials-updated") {
				if (msg.hasDoubao || msg.hasDoubaoApiKey) {
					doubaoBadge.style.background = "rgba(34, 197, 94, 0.15)";
					doubaoBadge.style.color = "#22c55e";
					doubaoBadge.innerText = msg.hasDoubaoApiKey ? "🟢 官方 Key 就绪" : "🟢 网页 Cookie 就绪";
					doubaoDetail.innerText = "凭据有效，可正常合成";
				} else {
					doubaoBadge.style.background = "rgba(234, 179, 8, 0.15)";
					doubaoBadge.style.color = "#eab308";
					doubaoBadge.innerText = "🟡 暂未配置";
					doubaoDetail.innerText = "请通过扩展同步或填入 API Key";
				}

				if (msg.hasDeepseek) {
					deepseekBadge.style.background = "rgba(34, 197, 94, 0.15)";
					deepseekBadge.style.color = "#22c55e";
					deepseekBadge.innerText = "🟢 userToken 就绪";
					deepseekDetail.innerText = "已获取 DeepSeek 网页登录态";
				} else {
					deepseekBadge.style.background = "rgba(234, 179, 8, 0.15)";
					deepseekBadge.style.color = "#eab308";
					deepseekBadge.innerText = "🟡 暂未配置";
					deepseekDetail.innerText = "请在扩展或设置中填入 userToken";
				}
			}

			if (msg.type === "speak-result") {
				btnSpeak.disabled = false;
				if (msg.success && msg.audioBase64) {
					speakStatus.innerText = "合成成功！";
					speakStatus.style.color = "#22c55e";
					const mime =
						{ wav: "audio/wav", mp3: "audio/mpeg", aac: "audio/aac", ogg: "audio/ogg" }[msg.format] || "audio/wav";
					audioPlayer.src = `data:${mime};base64,${msg.audioBase64}`;
					playerContainer.style.display = "block";
					audioPlayer.play().catch(() => {});
				} else {
					speakStatus.innerText = `合成失败: ${msg.error || "未知错误"}`;
					speakStatus.style.color = "#ef4444";
				}
			}
		});

		el.querySelector("#btn-refresh-status").onclick = refreshStatus;
		el.querySelector("#btn-open-dir").onclick = () => fetch("/plugins-api/tts/open-folder", { method: "POST" });
		el.querySelector("#btn-download-zip").onclick = () => window.open("/plugins-api/tts/download-extension", "_blank");
		el.querySelector("#btn-reset-ds-session").onclick = () => {
			ctx.send({ action: "reset-deepseek-session" });
			alert("已重置 DeepSeek 专属语音会话，下次发音将自动创建并长期复用新会话。");
		};
		el.querySelector("#btn-clear-creds").onclick = () => {
			if (confirm("确定清空本地保存的凭据吗？")) ctx.send({ action: "clear-credentials" });
		};

		btnSpeak.onclick = () => {
			const text = el.querySelector("#inp-text").value.trim();
			if (!text) return;
			btnSpeak.disabled = true;
			speakStatus.textContent = "正在合成…";
			ctx.send({ action: "test-speak", text, engine: selEngine.value, speaker: selSpeaker.value });
		};

		refreshStatus();

		return () => {
			off?.();
		};
	},
};
