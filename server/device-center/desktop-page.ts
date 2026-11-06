export function desktopPage(): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remote desktop</title>
<style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#101827;color:#e5edf8}*{box-sizing:border-box}body{margin:0}main{display:flex;flex-direction:column;gap:0;min-width:0;min-height:0;max-width:100%;height:100dvh;padding:0;overflow:hidden}header,nav,form,.actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;max-width:100%}p{margin:0;font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}button,input{font:inherit;border:1px solid #657287;border-radius:5px;background:#202f45;color:#fff}button{padding:8px 12px;min-height:40px;cursor:pointer}button:disabled,input:disabled{opacity:.5;cursor:default}label{display:flex;align-items:center;gap:6px}input[type=checkbox]{width:18px;height:18px}input[type=text]{padding:8px;min-width:0;flex:1;width:160px}button:focus-visible,input:focus-visible,canvas:focus-visible{outline:2px solid #8cc8ff;outline-offset:2px}#setup{display:grid;gap:8px;border:1px solid #657287;border-radius:6px;padding:10px}#screen{flex:1;min-width:0;min-height:0;overflow:auto;background:#000;position:relative}main:fullscreen{width:100%;height:100%;background:#101827}canvas{display:block;width:100%;height:100%;object-fit:contain;touch-action:none;outline-offset:-3px}#screen.native canvas{width:auto;height:auto;max-width:none}#status[data-error=true]{color:#ffb4b4}#text-form label{font-size:13px}#text-form button{flex:none}
#toolbar{flex:none;flex-wrap:nowrap;gap:6px;min-height:32px;padding:3px 6px;border-bottom:1px solid #35445a;font-size:12px;overflow-x:auto}#controls{flex:none;flex-wrap:nowrap;gap:6px}#toolbar button{min-height:24px;padding:2px 7px;font-size:12px}#toolbar label{gap:3px;white-space:nowrap}#toolbar input[type=checkbox]{width:14px;height:14px;margin:0}summary{cursor:pointer;white-space:nowrap;padding:3px 6px;border:1px solid #657287;border-radius:5px}details{flex:none}#setup,#text-form{position:absolute;z-index:2;top:36px;left:6px;width:min(640px,calc(100% - 12px));max-height:calc(100dvh - 44px);overflow:auto;overscroll-behavior:contain;background:#101827;border:1px solid #657287;border-radius:6px;padding:10px;box-shadow:0 8px 24px #0008}#text-form{display:flex}#text-form label{width:100%}#status{font-size:12px;white-space:nowrap;flex:1;min-width:120px}#status[data-error=true]{position:absolute;z-index:1;top:36px;right:6px;max-width:min(640px,calc(100% - 12px));white-space:pre-wrap;background:#101827;border:1px solid #ffb4b4;border-radius:5px;padding:8px}summary:focus-visible{outline:2px solid #8cc8ff;outline-offset:2px}
</style></head><body><main>
<header id="toolbar"><nav id="controls"><button id="connect" disabled data-i18n="connect"></button><button id="disconnect" disabled data-i18n="disconnect"></button><label><input id="viewonly" type="checkbox"><span data-i18n="viewonly"></span></label><label><input id="scale" type="checkbox" checked><span data-i18n="scale"></span></label><button id="fullscreen" data-i18n="fullscreen"></button></nav>
<details id="settings"><summary data-i18n="setup"></summary><section id="setup" aria-label="Desktop setup"><p id="setup-status" role="status" aria-live="polite"></p><div class="actions"><button id="check" data-i18n="check"></button><button id="enable" disabled data-i18n="enable"></button><button id="disable" disabled data-i18n="disable"></button></div><aside id="mac-permission-guide" hidden aria-label="macOS permissions"><p data-i18n="macGuide"></p></aside><p id="hint" data-i18n="hint"></p></section></details>
<details id="text-panel"><summary data-i18n="textToggle"></summary><form id="text-form"><label for="text" data-i18n="text"></label><input id="text" type="text" disabled autocomplete="off" maxlength="2048"><button id="send-text" type="submit" disabled data-i18n="send"></button></form></details>
<p id="status" role="status" aria-live="polite"></p></header>
<div id="screen"><canvas id="canvas" width="1" height="1" tabindex="0" aria-describedby="hint"></canvas></div>
</main><script type="module">
const appUrl = path => new URL(path, document.baseURI);
const $ = id => document.getElementById(id);
const zh = (navigator.language || 'en').toLowerCase().startsWith('zh');
const messages = {
 title:['设备远程桌面','Remote desktop'],connect:['连接','Connect'],disconnect:['断开','Disconnect'],
 check:['检查状态','Check status'],enable:['启用','Enable'],disable:['停用','Disable'],setup:['桌面设置','Desktop setup'],
 viewonly:['只读','View only'],scale:['适应窗口','Fit to window'],fullscreen:['全屏','Fullscreen'],
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
 disconnected:['已断开。','Disconnected.'],closed:['连接已关闭','Connection closed'],connectionError:['桌面连接失败，请检查设备状态后重试。','Desktop connection failed. Check device status and retry.'],
 requestError:['状态或设置请求失败','Status or settings request failed'],decodeError:['画面解码失败','Image decoding failed'],
 fullscreenError:['无法进入全屏','Unable to enter fullscreen'],browserError:['浏览器不支持所需的桌面显示功能。','This browser does not support the required desktop display features.']
};
const t = key => messages[key][zh ? 0 : 1];
document.documentElement.lang = zh ? 'zh-CN' : 'en'; document.title = t('title');
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
$('setup').setAttribute('aria-label', t('setup')); $('controls').setAttribute('aria-label', t('title')); $('canvas').setAttribute('aria-label', t('title'));
const canvas = $('canvas'), screen = $('screen'), context = canvas.getContext('2d');
let config = null, busy = false, disposed = false, socket = null, generation = 0;
let ready = false, hasFrame = false, connectionViewOnly = true, pendingFrame = null, decoding = false;
let activePointer = null;
const browserSupported = !!context && typeof createImageBitmap === 'function' && typeof WebSocket === 'function';
function status(message, error = false) { $('status').textContent = message; $('status').dataset.error = String(error); }
function desktopError(message) {
 if (typeof message !== 'string') return t('connectionError');
 if (message.startsWith('MAC_SCREEN_PERMISSION_REQUIRED')) return t('macScreenPermission');
 if (message.startsWith('MAC_ACCESSIBILITY_PERMISSION_REQUIRED')) return t('macAccessibilityPermission');
 return message;
}
function canConnect() { return browserSupported && config?.enabled === true && config?.available === true && config?.supported === true; }
function canInput() { return ready && hasFrame && !connectionViewOnly && socket?.readyState === WebSocket.OPEN; }
function controls() {
 $('connect').disabled = busy || !canConnect() || !!socket;
 $('disconnect').disabled = !socket;
 $('check').disabled = busy;
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
 release(); const previous = socket; socket = null; generation++;
 ready = false; hasFrame = false; pendingFrame = null;
 if (previous) { previous.onmessage = previous.onopen = previous.onerror = previous.onclose = null; previous.close(); }
 context?.clearRect(0, 0, canvas.width, canvas.height); controls();
}
function fail(message) { stop(); status(message, true); }
async function decodeFrames() {
 if (decoding) return;
 decoding = true;
 try {
  while (pendingFrame) {
   const frame = pendingFrame; pendingFrame = null;
   let bitmap;
   try {
    bitmap = await createImageBitmap(frame.blob);
    if (disposed || frame.generation !== generation || frame.socket !== socket || socket.readyState !== WebSocket.OPEN) continue;
    if (!bitmap.width || !bitmap.height) throw new Error('Empty image');
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height; }
    context.drawImage(bitmap, 0, 0); hasFrame = true;
    frame.socket.send(JSON.stringify({type:'ack'}));
    status(t(connectionViewOnly ? 'viewing' : 'controlling')); controls();
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
    if (message.type === 'error') fail(desktopError(message.message));
    else if (message.type === 'ready') { ready = true; controls(); }
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
 if (!socket) status(t(!browserSupported ? 'browserError' : canConnect() ? 'ready' : 'unavailable'), !browserSupported);
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
document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
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
for (const id of ['settings', 'text-panel']) $(id).addEventListener('toggle', () => {
 if ($(id).open) $(id === 'settings' ? 'text-panel' : 'settings').open = false;
});
$('scale').onchange = () => screen.classList.toggle('native', !$('scale').checked);
$('fullscreen').onclick = async () => {
 try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.querySelector('main').requestFullscreen(); }
 catch (error) { status(t('fullscreenError') + ': ' + error.message, true); }
};
window.addEventListener('pagehide', () => { disposed = true; stop(); });
controls(); void update(undefined, true);
</script></body></html>`;
}
