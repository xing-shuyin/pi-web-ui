import { desktopErrorScript } from "./desktop-errors.js";
import { desktopThemeScript } from "./desktop-theme.js";

export function desktopPreviewPage(): string {
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Desktop preview</title><style>html,body{margin:0;width:100%;height:100%;background:var(--bg,#101827)}img{display:block;width:100%;height:100%;object-fit:contain}img:not([src]){visibility:hidden}</style></head><body><img alt=""><script type="module">
const image = document.querySelector('img');
${desktopThemeScript()}
${desktopErrorScript()}
const zh = (navigator.language || 'en').toLowerCase().startsWith('zh');
let display = '';
let active = parent === window, disposed = false, timer, controller, objectUrl;
const report = data => parent.postMessage({type:'desktop-preview-state',...data}, '*');
function cancel() { clearTimeout(timer); controller?.abort(); }
async function refresh() {
 if (!active || disposed || document.hidden || controller) return;
 const current = new AbortController(); controller = current;
 const timeout = setTimeout(() => current.abort(), 65000);
 const requestedDisplay=display;
 let retry = 3000, receivedResponse = false;
 try {
  const url = new URL('api/device-desktop/preview', document.baseURI); if(display) url.searchParams.set('display',display);
  const response = await fetch(url, {credentials:'same-origin', cache:'no-store', signal:current.signal});
  receivedResponse = true;
  if (!response.ok) {
   const unsupported = response.status === 404;
   let error = 'Desktop preview unavailable (HTTP ' + response.status + ')';
   try { const data = await response.json(); if (typeof data.error === 'string') error = data.error.slice(0,2048); } catch {}
   const issue = desktopIssue(error, zh);
   report({error:issue?.message || error,unsupported});
   if (issue) { retry = 10000; if (!issue.retry) active = false; return; }
   if (unsupported || response.status === 403 || response.status === 503) { active = false; return; }
   throw new Error(error);
  }
  if (!response.headers.get('content-type')?.startsWith('image/jpeg')) throw new Error('Invalid desktop preview response');
  const blob = await response.blob();
  if (!blob.size || blob.size > 4194304) throw new Error('Invalid desktop preview size');
  if (!active || disposed || current.signal.aborted || requestedDisplay !== display) return;
  const next = URL.createObjectURL(blob), previous = objectUrl;
  image.src = next; objectUrl = next;
  if (previous) URL.revokeObjectURL(previous);
  await image.decode();
  if (!active || disposed || current.signal.aborted) return;
  report({updatedAt:Date.now()});
 } catch (error) {
  if (active && !disposed && requestedDisplay === display) {
   report({error:current.signal.aborted ? 'Desktop preview timed out.' : String(error.message).slice(0,2048)});
   if (!receivedResponse && !current.signal.aborted) parent.postMessage({type:'device-portal-disconnected'}, '*');
  }
  retry = 10000;
 } finally {
  clearTimeout(timeout); controller = null;
  if (active && !disposed && !document.hidden) timer = setTimeout(refresh, requestedDisplay === display ? retry : 0);
 }
}
addEventListener('message', event => {
 if (event.source !== parent || event.data?.type !== 'desktop-preview-active' || typeof event.data.active !== 'boolean') return;
 const nextDisplay=typeof event.data.display==='string'&&event.data.display.length<=128?event.data.display:'';
 if (active === event.data.active && display === nextDisplay) return;
 display=nextDisplay;active = event.data.active;cancel();if(active&&!controller)void refresh();
});
document.addEventListener('visibilitychange', () => { cancel(); if (!document.hidden) void refresh(); });
addEventListener('pagehide', () => { disposed = true; active = false; cancel(); if (objectUrl) URL.revokeObjectURL(objectUrl); });
report({ready:true}); void refresh();
</script></body></html>`;
}
