import { desktopErrorScript } from "./desktop-errors.js";
import { desktopThemeScript } from "./desktop-theme.js";
import { desktopClipboardPageScript } from "./desktop-clipboard-page.js";

export function desktopPage(): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remote desktop</title>
<style>
:root{color-scheme:dark;--bg:#101318;--bg-elev:#191e25;--bg-elev2:#222a34;--border:#343d49;--text:#e6edf5;--text-dim:#a4afbf;--accent:#8bb9ff;--accent-contrast:#102039;--green:#74d6ae;--red:#ff9595;font-family:system-ui,sans-serif;background:var(--bg);color:var(--text)}
@media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#f5f7fa;--bg-elev:#fff;--bg-elev2:#e9eef5;--border:#d1dae5;--text:#253246;--text-dim:#58677c;--accent:#3268ac;--accent-contrast:#fff;--green:#207b58;--red:#b83143}}
*{box-sizing:border-box}body{margin:0}main{display:flex;flex-direction:column;min-width:0;min-height:0;max-width:100%;height:100dvh;overflow:hidden}p{margin:0;font-size:13px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
button,input,summary{font:inherit;color:var(--text)}button,summary{display:inline-flex;align-items:center;justify-content:center;gap:5px;border:1px solid transparent;border-radius:7px;background:transparent;padding:6px 9px;min-height:30px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s}button:hover:not(:disabled),summary:hover{background:var(--bg-elev2);border-color:var(--border)}button:disabled,input:disabled{opacity:.4;cursor:default}button:focus-visible,input:focus-visible,summary:focus-visible,canvas:focus-visible{outline:2px solid var(--accent);outline-offset:2px}button svg,summary svg{width:14px;height:14px;flex:none;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
#toolbar{display:flex;align-items:center;flex:none;gap:4px;padding:6px 8px;background:var(--bg-elev);border-bottom:1px solid var(--border);font-size:12px;min-width:0;max-width:100%;position:relative}#toolbar-scroll{display:flex;align-items:center;gap:4px;min-width:0;overflow-x:auto;scrollbar-width:thin}#controls{display:flex;align-items:center;gap:3px;flex:none}#connect:not(:disabled){background:var(--accent);color:var(--accent-contrast)}#connect:disabled{display:none}#disconnect:disabled{display:none}.view-options{display:flex;gap:2px;align-items:center;border-left:1px solid var(--border);border-right:1px solid var(--border);padding:0 5px;margin:0 3px}
#toolbar label:has(#display-source){padding:0 5px}#display-source{font:inherit;max-width:240px;min-width:0;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);padding:4px}#toolbar label{display:flex;align-items:center;gap:5px;white-space:nowrap;cursor:pointer;border-radius:7px;padding:6px 7px;min-height:30px}#toolbar label:has(input:checked){background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--text)}#toolbar label:hover{background:var(--bg-elev2)}input[type=checkbox]{accent-color:var(--accent);width:13px;height:13px;margin:0}details{flex:none}summary{list-style:none}summary::-webkit-details-marker{display:none}details[open]>summary{background:var(--bg-elev2);border-color:var(--border)}
#quality-form,#setup,#text-form,#statistics{position:absolute;z-index:2;top:calc(100% + 6px);left:8px;width:min(520px,calc(100vw - 16px));max-height:calc(100dvh - 64px);overflow:auto;overscroll-behavior:contain;background:var(--bg-elev);border:1px solid var(--border);border-radius:12px;padding:16px;box-shadow:0 12px 36px #0003;white-space:normal}#setup{display:grid;gap:12px}#quality-form{display:grid;gap:12px;width:min(360px,calc(100vw - 16px))}#quality-form label{display:grid;grid-template-columns:90px minmax(0,1fr);padding:0;cursor:default}#quality-form select{min-width:0;width:100%;padding:7px;border:1px solid var(--border);border-radius:7px;background:var(--bg);color:var(--text)}#quality-note{color:var(--text-dim);font-size:12px;line-height:1.5;margin:0}.actions{display:flex;gap:6px;flex-wrap:wrap}.actions button,#send-text{background:var(--bg-elev2);border-color:var(--border)}#hint,#statistics{color:var(--text-dim)}#text-form{display:flex;flex-wrap:wrap;gap:10px}#text-form label{width:100%;padding:0;min-height:0;cursor:default}input[type=text]{border:1px solid var(--border);border-radius:8px;background:var(--bg);padding:9px 10px;min-width:0;flex:1;width:160px}#send-text{flex:none}
#status{display:flex;align-items:center;gap:6px;margin-left:auto;padding:0 4px;font-size:11px;white-space:nowrap;flex:none;color:var(--text-dim)}#status:before{content:'';width:6px;height:6px;border-radius:50%;background:var(--text-dim);flex:none}#status[data-connected=true]:before{background:var(--green)}#status[data-error=true]{position:absolute;z-index:1;top:calc(100% + 6px);right:8px;max-width:min(520px,calc(100% - 16px));white-space:pre-wrap;background:var(--bg-elev);color:var(--red);border:1px solid var(--border);border-radius:10px;padding:10px 12px;box-shadow:0 8px 24px #0003}#status[data-error=true]:before{background:var(--red)}#status[data-error=true]{overflow-wrap:anywhere;word-break:break-word}
#screen{flex:1;min-width:0;min-height:0;overflow:auto;background:#000;position:relative}main:fullscreen{width:100%;height:100%;background:var(--bg)}canvas{display:block;width:100%;height:100%;object-fit:contain;touch-action:none;outline-offset:-3px}#screen.native canvas{width:auto;height:auto;max-width:none}@media(max-width:700px){#toolbar{flex-wrap:wrap;gap:2px}#toolbar-scroll{width:100%}#status{margin-left:4px;min-height:18px}#toolbar button,#toolbar summary,#toolbar label{min-height:34px}}
</style></head><body><main>
<header id="toolbar"><div id="toolbar-scroll"><nav id="controls"><button id="connect" disabled data-i18n="connect"></button><button id="disconnect" disabled data-i18n="disconnect"></button><div class="view-options"><label><input id="viewonly" type="checkbox"><span data-i18n="viewonly"></span></label><label><input id="scale" type="checkbox" checked><span data-i18n="scale"></span></label></div><label><span data-i18n="display"></span><select id="display-source" disabled><option value="" data-i18n="primaryDisplay"></option></select></label><button id="fullscreen" data-i18n="fullscreen"></button></nav>
<details id="settings"><summary data-i18n="setup"></summary><section id="setup" aria-label="Desktop setup"><p id="setup-status" role="status" aria-live="polite"></p><div class="actions"><button id="check" data-i18n="check"></button><button id="enable" disabled data-i18n="enable"></button><button id="disable" disabled data-i18n="disable"></button></div><aside id="mac-permission-guide" hidden aria-label="macOS permissions"><p data-i18n="macGuide"></p></aside><p id="hint" data-i18n="hint"></p></section></details>
<details id="quality-panel"><summary data-i18n="quality"></summary><section id="quality-form"><label><span data-i18n="quality"></span><select id="quality-mode"><option value="auto" data-i18n="qualityAuto"></option><option value="smooth" data-i18n="qualitySmooth"></option><option value="balanced" data-i18n="qualityBalanced"></option><option value="sharp" data-i18n="qualitySharp"></option></select></label><label><span data-i18n="resolution"></span><select id="quality-edge"><option value="0" data-i18n="resolutionAuto"></option><option value="960">960 px</option><option value="1280">1280 px</option><option value="1920">1920 px</option><option value="2560">2560 px</option></select></label><label><span data-i18n="frameRate"></span><select id="quality-fps"><option value="10">10 FPS</option><option value="15">15 FPS</option><option value="30">30 FPS</option><option value="60" selected>60 FPS</option><option value="120">120 FPS</option><option value="240">240 FPS</option></select></label><p id="quality-note" data-i18n="qualityNote"></p></section></details>
<details id="text-panel"><summary data-i18n="textToggle"></summary><form id="text-form"><label for="text" data-i18n="text"></label><input id="text" type="text" disabled autocomplete="off" maxlength="2048"><button id="send-text" type="submit" disabled data-i18n="send"></button></form></details>
<details id="diagnostics"><summary data-i18n="diagnostics"></summary><p id="statistics"></p></details></div><p id="status" role="status" aria-live="polite"></p></header>
<div id="screen"><canvas id="canvas" width="1" height="1" tabindex="0" aria-describedby="hint"></canvas></div>
</main><script type="module">
const appUrl = path => new URL(path, document.baseURI);
${desktopThemeScript()}
${desktopErrorScript()}
const $ = id => document.getElementById(id);
const zh = (navigator.language || 'en').toLowerCase().startsWith('zh');
const messages = {
 title:['设备远程桌面','Remote desktop'],connect:['连接','Connect'],disconnect:['断开','Disconnect'],
 check:['检查状态','Check status'],enable:['启用','Enable'],disable:['停用','Disable'],setup:['桌面设置','Desktop setup'],
 display:['显示器','Display'],primaryDisplay:['主屏','Primary display'],viewonly:['只读','View only'],scale:['适应窗口','Fit to window'],fullscreen:['全屏','Fullscreen'],
 textToggle:['文字输入','Text input'],text:['文字输入（支持中文）','Text input (including Chinese)'],send:['发送','Send'],
 hint:['控制模式：点击画面后使用键盘；触屏可拖动，中文请用顶部文字输入发送。只读模式由服务端强制执行。','Control mode: focus the image to use the keyboard; drag with touch. Use Text input in the toolbar for composed text. View only is enforced by the server.'],
 checking:['正在检查…','Checking…'],saving:['正在保存…','Saving…'],enabled:['已启用','Enabled'],disabled:['已停用','Disabled'],
 macGuide:['请在被控 Mac 本机打开 pi-web-ui → 设备中心 → 本机远程桌面，点击“授予屏幕录制权限”或“授予远程控制权限”，并在系统弹窗或设置中确认。仅查看只需屏幕录制，控制还需辅助功能。远端连接不会触发授权或打开系统设置。系统可能不重复弹窗；请授权 macOS 列出的实际启动宿主，授权后按系统提示重启服务，再连接。不要在“+”文件选择器中猜选应用。','On the controlled Mac itself, open pi-web-ui → Device Center → Local remote desktop, then click Grant screen recording permission or Grant remote control permission and confirm in the system prompt or Settings. Viewing needs screen recording; control also needs Accessibility. Remote connections never request permission or open Settings. macOS may suppress repeat prompts. Authorize the actual launch host listed by macOS, restart the service if requested, then reconnect. Do not guess an app in the “+” file picker.'],
 macScreenPermission:['被控 Mac 缺少屏幕录制权限。请在该 Mac 本机的设备中心 → 本机远程桌面点击“授予屏幕录制权限”，完成系统确认后重新连接。','Screen recording permission is required. On the controlled Mac itself, open Device Center → Local remote desktop and click Grant screen recording permission. Confirm in macOS, then reconnect.'],
 macAccessibilityPermission:['被控 Mac 缺少辅助功能权限。请在该 Mac 本机的设备中心 → 本机远程桌面点击“授予远程控制权限”并完成系统确认。仅查看可保持只读。','Accessibility permission is required. On the controlled Mac itself, open Device Center → Local remote desktop and click Grant remote control permission. Confirm in macOS. You can keep View only enabled to view without control.'],
 available:['后端可用（未验证系统权限）','Backend available (system permissions not verified)'],unavailable:['后端不可用','Backend unavailable'],unsupported:['此系统不支持桌面共享','Desktop sharing is unsupported on this system'],
 environment:['环境变量强制启用；需在设备本机修改环境变量并重启才能停用。','Enabled by the environment; change the environment on the device and restart to disable.'],
 ready:['可以连接。','Ready to connect.'],connecting:['正在连接…','Connecting…'],waiting:['已连接，等待画面…','Connected; waiting for an image…'],
 viewing:['已连接 · 只读','Connected · view only'],controlling:['已连接 · 可控制','Connected · control enabled'],
 quality:['画质','Quality'],qualityAuto:['自动','Automatic'],qualitySmooth:['流畅','Smooth'],qualityBalanced:['均衡','Balanced'],qualitySharp:['清晰','Sharp'],resolution:['分辨率上限','Resolution limit'],resolutionAuto:['跟随窗口','Match window'],frameRate:['帧率上限','Frame rate limit'],qualityNote:['调整传输画面长边，保持屏幕比例，不改变被控电脑的显示设置。自动模式会在网络变慢时降低画质。60 / 120 / 240 是目标，实际帧率取决于两端设备、画面变化及网络；降低分辨率有助于提高帧率。','Adjusts the transmitted image’s longest edge, preserving aspect ratio and the host’s display settings. Automatic mode reduces quality on slower connections. 60/120/240 are targets; actual FPS depends on both devices, screen changes and the connection. Lower resolution can help at high frame rates.'],qualityUnsupported:['此设备暂不支持动态画质。请更新被控端；Windows 系统桌面服务也需要更新。','This device does not support dynamic quality yet. Update the host, including the Windows desktop service if installed.'],
 diagnostics:['连接信息','Connection info'],stats:['目标：{target} FPS · 采集/发送：{captureFps}/{sendFps} FPS · 跳过旧帧：{replaced} · 确认等待：{ackMs} ms · 队列：{queued} B · 显示：{fps} FPS · 解码绘制：{decodeMs} ms','Target: {target} FPS · Capture/send: {captureFps}/{sendFps} FPS · Replaced: {replaced} · ACK: {ackMs} ms · Queue: {queued} B · Display: {fps} FPS · Decode/draw: {decodeMs} ms'],
 disconnected:['已断开。','Disconnected.'],closed:['连接已关闭','Connection closed'],connectionError:['桌面连接失败，请检查设备状态后重试。','Desktop connection failed. Check device status and retry.'],
 requestError:['状态或设置请求失败','Status or settings request failed'],decodeError:['画面解码失败','Image decoding failed'],
 fullscreenError:['无法进入全屏','Unable to enter fullscreen'],browserError:['浏览器不支持所需的桌面显示功能。','This browser does not support the required desktop display features.']
};
const t = key => messages[key][zh ? 0 : 1];
document.documentElement.lang = zh ? 'zh-CN' : 'en'; document.title = t('title');
const icons = {"quality":"M4 7h16M4 12h16M4 17h16M8 5v4m8 1v4m-5 1v4","connect":"M8 5l10 7-10 7z","disconnect":"M7 7h10v10H7z","fullscreen":"M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5","setup":"M4 7h16M4 17h16M8 4v6m8 4v6","textToggle":"M4 5h16M12 5v15M8 20h8","diagnostics":"M5 20v-5m7 5V9m7 11V4"};
for (const el of document.querySelectorAll('[data-i18n]')) { el.textContent = t(el.dataset.i18n); const path=icons[el.dataset.i18n];if(path && el.matches('button,summary')){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),shape=document.createElementNS(svg.namespaceURI,'path');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');shape.setAttribute('d',path);svg.append(shape);el.prepend(svg)} }
$('setup').setAttribute('aria-label', t('setup')); $('controls').setAttribute('aria-label', t('title')); $('canvas').setAttribute('aria-label', t('title'));
const canvas = $('canvas'), screen = $('screen'), context = canvas.getContext('2d');
let config = null, busy = false, disposed = false, socket = null, generation = 0;
let ready = false, hasFrame = false, connectionViewOnly = true, pendingFrame = null, decoding = false;
let activePointer = null, retryTimer, awaitingDesktop = false;
let rendered = 0, sampleAt = performance.now(), decodeMs = 0, lastCaptured = 0, lastSent = 0;
let selectedDisplay = '', captureBackend = '';
let dynamicQuality = false, qualityTimer, lastQuality = '';
${desktopClipboardPageScript()}
$('display-source').addEventListener('change',()=>{selectedDisplay=$('display-source').value;connect()});
addEventListener('message',event=>{if(event.source===parent&&event.data?.type==='desktop-select-display'&&typeof event.data.display==='string'&&event.data.display.length<=128&&[...$('display-source').options].some(option=>option.value===event.data.display)&&selectedDisplay!==event.data.display){selectedDisplay=event.data.display;$('display-source').value=selectedDisplay;connect()}});
function updateDisplays(message){
 if(['dxgi','gdi','screencapturekit'].includes(message.capture))captureBackend=message.capture;
 if(!Array.isArray(message.displays)||!message.displays.length||message.displays.length>32||typeof message.selected!=='string')return;
 const select=$('display-source'),signature=JSON.stringify(message.displays);
 if(select.dataset.displays!==signature){select.replaceChildren();message.displays.forEach((display,index)=>{const option=document.createElement('option');option.value=display.id;option.textContent=t('display')+' '+(index+1)+' · '+display.width+' × '+display.height+(display.primary?' · '+t('primaryDisplay'):'');select.append(option)});select.dataset.displays=signature}
 select.disabled=false;select.value=message.selected;selectedDisplay=message.selected;
 if(parent!==window)parent.postMessage({type:'desktop-displays',displays:message.displays,selected:message.selected},'*');
}

function updateQuality() {
 clearTimeout(qualityTimer);
 qualityTimer = setTimeout(() => {
  if (!dynamicQuality || !ready || socket?.readyState !== WebSocket.OPEN) return;
  const viewportEdge = Math.max(640, Math.min(2560, Math.round(Math.max(screen.clientWidth, screen.clientHeight) * Math.min(devicePixelRatio || 1, 2))));
  const message = {type:'configure', mode:$('quality-mode').value, maxEdge:Number($('quality-edge').value), viewportEdge, fps:Number($('quality-fps').value)};
  const text = JSON.stringify(message); if(text === lastQuality) return;
  try { socket.send(text); lastQuality = text; } catch { fail(t('connectionError')); }
 }, 300);
}
const qualityObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(updateQuality) : null; qualityObserver?.observe(screen);
window.addEventListener('resize', updateQuality);
for (const id of ['quality-mode','quality-edge','quality-fps']) $(id).addEventListener('change', updateQuality);
const browserSupported = !!context && typeof createImageBitmap === 'function' && typeof WebSocket === 'function';
function status(message, error = false) { $('status').textContent = message; $('status').dataset.error = String(error); $('status').dataset.connected = String(ready && hasFrame && !error); }
function desktopError(message) {
 if (typeof message !== 'string') return t('connectionError');
 const issue = desktopIssue(message, zh); if (issue) return issue.message;
 if (message.startsWith('MAC_SCREEN_PERMISSION_REQUIRED')) return t('macScreenPermission');
 if (message.startsWith('MAC_ACCESSIBILITY_PERMISSION_REQUIRED')) return t('macAccessibilityPermission');
 return message;
}
function canConnect() { return browserSupported && config?.enabled === true && config?.available === true && config?.supported === true; }
function canInput() { return ready && hasFrame && !connectionViewOnly && socket?.readyState === WebSocket.OPEN; }
function controls() {
 $('connect').disabled = busy || !canConnect() || !!socket;
 $('disconnect').disabled = !socket && !awaitingDesktop;
 $('check').disabled = busy;
 for (const id of ['quality-mode','quality-edge','quality-fps']) $(id).disabled = !dynamicQuality;
 $('quality-note').textContent = t(ready && !dynamicQuality ? 'qualityUnsupported' : 'qualityNote');
 $('enable').disabled = busy || !config || config.enabled || !config.supported;
 $('disable').disabled = busy || !config?.enabled || config.environmentEnabled;
 $('text').disabled = $('send-text').disabled = !canInput();
 $('fullscreen').disabled = !document.querySelector('main').requestFullscreen;
}
function send(message) {
 if (!canInput()) return false;
 try { socket.send(JSON.stringify(message)); return true; }
 catch { fail(t('connectionError')); return false; }
}
function release() {
 if (ready && !connectionViewOnly && socket?.readyState === WebSocket.OPEN) {
  try { socket.send(JSON.stringify({type:'release'})); } catch { /* Closing sockets cannot receive a release. */ }
 }
 const previous = activePointer; activePointer = null;
 if (previous !== null && canvas.hasPointerCapture(previous)) canvas.releasePointerCapture(previous);
}
function stop() {
 stopClipboard();
 clearTimeout(retryTimer); awaitingDesktop = false;
 release(); const previous = socket; socket = null; generation++;
 ready = false; hasFrame = false; pendingFrame = null; dynamicQuality = false; lastQuality = ""; clearTimeout(qualityTimer);
 rendered = 0; lastCaptured = lastSent = 0; sampleAt = performance.now(); $('statistics').textContent = '';
 if (previous) { previous.onmessage = previous.onopen = previous.onerror = previous.onclose = null; previous.close(); }
 context?.clearRect(0, 0, canvas.width, canvas.height); controls(); clipboardAvailable();
}
function scheduleRecovery() {
 clearTimeout(retryTimer);
 if (awaitingDesktop && !disposed && !document.hidden) retryTimer = setTimeout(() => { if (awaitingDesktop) connect(); }, 10000);
}
function fail(message, retry = false) {
 stop(); awaitingDesktop = retry; status(message, true); controls(); scheduleRecovery();
}
async function decodeFrames() {
 if (decoding) return;
 decoding = true;
 try {
  while (pendingFrame) {
   const frame = pendingFrame; pendingFrame = null;
   let bitmap;
   const decodeStarted = performance.now();
   try {
    bitmap = await createImageBitmap(frame.blob);
    if (disposed || frame.generation !== generation || frame.socket !== socket || socket.readyState !== WebSocket.OPEN) continue;
    if (!bitmap.width || !bitmap.height) throw new Error('Empty image');
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height; }
    await new Promise(resolve => { if(document.hidden) setTimeout(resolve,100); else requestAnimationFrame(resolve); });
    if(disposed || frame.generation !== generation || frame.socket !== socket) continue;
    const firstFrame = !hasFrame;
    context.drawImage(bitmap, 0, 0); hasFrame = true;
    rendered++; decodeMs = Math.round(performance.now() - decodeStarted);
    frame.socket.send(JSON.stringify({type:'ack'}));
    if(firstFrame) { status(t(connectionViewOnly ? 'viewing' : 'controlling')); controls(); }
   } catch (error) {
    if (!disposed && frame.generation === generation && frame.socket === socket && socket.readyState === WebSocket.OPEN) {
     try { frame.socket.send(JSON.stringify({type:'ack'})); } catch { /* Close below if the acknowledgement cannot be sent. */ }
     fail(t('decodeError') + ': ' + error.message);
    }
   } finally { bitmap?.close(); }
  }
 } finally { decoding = false; }
}
function connect() {
 stop(); if (!canConnect() || disposed) return;
 connectionViewOnly = $('viewonly').checked;
 const url = appUrl('desktop-ws'); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
 url.searchParams.set('viewOnly', connectionViewOnly ? '1' : '0');
 if(selectedDisplay) url.searchParams.set('display',selectedDisplay);
 const currentGeneration = generation;
 let current;
 try { current = new WebSocket(url); } catch (error) { fail(t('connectionError') + ': ' + error.message); return; }
 socket = current; current.binaryType = 'blob'; status(t('connecting')); controls();
 const isCurrent = () => !disposed && socket === current && generation === currentGeneration;
 current.onopen = () => { if (isCurrent()) status(t('waiting')); };
 current.onmessage = event => {
  if (!isCurrent()) return;
  if (typeof event.data === 'string') {
   try {
    const message = JSON.parse(event.data);
    if (message.type === 'error') fail(desktopError(message.message), typeof message.message === 'string' && desktopIssue(message.message, zh)?.retry === true);
    else if (message.type === 'ready') { ready = true; dynamicQuality = message.dynamicQuality === true; controls(); updateQuality(); clipboardAvailable(); }
    else if (message.type === 'displays') updateDisplays(message);
    else if (message.type === 'stats') {
     const now = performance.now(), values = {...message, fps:(rendered * 1000 / Math.max(1,now - sampleAt)).toFixed(1), decodeMs, target:$('quality-fps').value, captureFps:((message.captured-lastCaptured)*1000/Math.max(1,now-sampleAt)).toFixed(1), sendFps:((message.sent-lastSent)*1000/Math.max(1,now-sampleAt)).toFixed(1)};
     if (['captured','sent','replaced','ackMs','queued'].every(key => typeof message[key] === 'number' && Number.isFinite(message[key]))) {
      $('statistics').textContent = t('stats').replace(/\\{(\\w+)\\}/g, (_,key) => String(values[key])) + ' · ' + canvas.width + ' × ' + canvas.height;
      rendered = 0; sampleAt = now; lastCaptured = message.captured; lastSent = message.sent;
     }
    }
   } catch { fail(t('connectionError')); }
  } else if (event.data instanceof Blob) {
   pendingFrame = {blob:event.data, generation:currentGeneration, socket:current}; void decodeFrames();
  }
 };
 current.onerror = () => { if (isCurrent()) { fail(t('connectionError')); parent.postMessage({type:'device-portal-disconnected'}, '*'); } };
 current.onclose = event => { if (isCurrent()) { stop(); status(t('closed') + ' (' + event.code + ')' + (event.reason ? ': ' + event.reason : ''), true); parent.postMessage({type:'device-portal-disconnected'}, '*'); } };
}
async function request(path, options = {}) {
 const response = await fetch(appUrl(path), {...options, credentials:'same-origin', cache:'no-store'});
 if (!response.ok) throw new Error(t('requestError') + ' (HTTP ' + response.status + ')');
 return response.json();
}
function applyConfig(next) {
 if (!next || ['enabled','available','environmentEnabled','supported'].some(key => typeof next[key] !== 'boolean')) throw new Error(t('requestError'));
 config = next;
 $('mac-permission-guide').hidden = next.os !== 'darwin';
 const details = [t(next.enabled ? 'enabled' : 'disabled'),t(next.supported ? next.available ? 'available' : 'unavailable' : 'unsupported')];
 if (typeof next.os === 'string') details.push(next.os);
 if (typeof next.backend === 'string') details.push(next.backend);
 if (typeof next.reason === 'string' && next.reason) details.push(next.reason);
 if (next.environmentEnabled) details.push(t('environment'));
 $('setup-status').textContent = details.join(' · ');
 if (!canConnect() && socket) stop();
 if (!socket && !awaitingDesktop) status(t(!browserSupported ? 'browserError' : canConnect() ? 'ready' : 'unavailable'), !browserSupported);
}
async function update(enabled, autoConnect = false) {
 if (busy || disposed) return;
 busy = true; controls(); $('setup-status').textContent = t(enabled === undefined ? 'checking' : 'saving');
 try {
  if (enabled !== undefined) {
   if (!enabled) stop();
   await request('api/device-desktop/setup/enable', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({enabled})});
  }
  let next;
  try { next = await request('api/device-desktop/status'); }
  catch { next = await request('api/device-desktop/setup/status'); }
  if (!disposed) {
   applyConfig(next);
   if ((autoConnect || enabled === true) && canConnect()) connect();
   if (!canConnect()) $('settings').open = true;
  }
 } catch (error) {
  if (!disposed) { $('settings').open = true; $('setup-status').textContent = t('requestError') + ': ' + error.message; status(t('requestError'), true); }
 } finally { busy = false; if (!disposed) controls(); }
}
// object-fit: contain can letterbox the canvas; normalize only the visible image.
function point(event, clamp = false) {
 if (!hasFrame) return null;
 const rect = canvas.getBoundingClientRect();
 const ratio = $('scale').checked ? Math.min(rect.width / canvas.width, rect.height / canvas.height) : 1;
 const width = canvas.width * ratio, height = canvas.height * ratio;
 if (width <= 0 || height <= 0) return null;
 const x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
 const y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
 if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
 return {x:Math.max(0, Math.min(1,x)), y:Math.max(0, Math.min(1,y))};
}
function pointer(event, action) {
 if (!canInput() || (activePointer !== null && activePointer !== event.pointerId)) return;
 const position = point(event, action === 'up' && activePointer === event.pointerId);
 if (!position) return;
 event.preventDefault();
 if (action === 'down') {
  if (activePointer !== null) return;
  activePointer = event.pointerId; canvas.setPointerCapture(event.pointerId); canvas.focus({preventScroll:true});
 }
 if (action !== 'move' && ![0,1,2].includes(event.button)) return;
 send({type:'pointer', action, ...position, ...(action === 'move' ? {} : {button:event.button})});
 if (action === 'up' && activePointer === event.pointerId && event.buttons === 0) {
  activePointer = null; if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
 }
}
canvas.addEventListener('pointerdown', event => pointer(event, 'down'));
canvas.addEventListener('pointermove', event => pointer(event, 'move'));
canvas.addEventListener('pointerup', event => pointer(event, 'up'));
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('lostpointercapture', () => { if (activePointer !== null) release(); });
canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('wheel', event => {
 if (!canInput() || !point(event)) return;
 event.preventDefault();
 const deltaY = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? screen.clientHeight : 1);
 send({type:'wheel', deltaY:Math.max(-10000,Math.min(10000,deltaY))});
}, {passive:false});
for (const action of ['down','up']) canvas.addEventListener('key' + action, event => {
 if (!canInput() || event.isComposing || !event.code) return;
 event.preventDefault(); send({type:'key', action, code:event.code});
});
canvas.addEventListener('blur', release);
window.addEventListener('blur', release);
document.addEventListener('visibilitychange', () => { if (document.hidden) { release(); clearTimeout(retryTimer); } else scheduleRecovery(); });
$('text-form').addEventListener('submit', event => {
 event.preventDefault(); const input = $('text');
 if (input.value && send({type:'text', text:input.value})) input.value = '';
});
$('text').addEventListener('keydown', event => { if (event.key === 'Enter' && event.isComposing) event.preventDefault(); });
$('connect').onclick = connect;
$('disconnect').onclick = () => { stop(); status(t('disconnected')); };
$('check').onclick = () => void update();
$('enable').onclick = () => void update(true);
$('disable').onclick = () => void update(false);
$('viewonly').onchange = () => { if (socket) connect(); };
const panels=['settings','quality-panel','text-panel','diagnostics'];
for(const id of panels) $(id).addEventListener('toggle',()=>{if($(id).open)for(const other of panels)if(other!==id)$(other).open=false});
document.addEventListener('keydown',event=>{if(event.key==='Escape')for(const id of panels)$(id).open=false});
document.addEventListener('pointerdown',event=>{if(!event.target.closest('details'))for(const id of panels)$(id).open=false});
$('scale').onchange = () => screen.classList.toggle('native', !$('scale').checked);
$('fullscreen').onclick = async () => {
 try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.querySelector('main').requestFullscreen(); }
 catch (error) { status(t('fullscreenError') + ': ' + error.message, true); }
};
window.addEventListener('pagehide', () => { disposed = true; qualityObserver?.disconnect(); window.removeEventListener('resize', updateQuality); clearTimeout(qualityTimer); stop(); });
controls(); void update(undefined, true);
</script></body></html>`;
}
