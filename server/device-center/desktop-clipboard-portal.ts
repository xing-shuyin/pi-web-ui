import { clipboardBrowserBridge } from "./desktop-clipboard-bridge.js";
import { manualClipboardControls } from "./desktop-clipboard-manual.js";
import { clipboardDialog } from "./desktop-clipboard-dialog.js";

import { desktopPreferences } from "./desktop-preferences.js";
import { clipboardStatus } from "./desktop-clipboard-status.js";

export function desktopClipboardPortalScript(localPath?: string, scope?: string) {
	return String.raw`
const clipboardPreferences=(()=>{const __name=fn=>fn;return (${desktopPreferences.toString()})})()(${JSON.stringify(scope ?? "desktop")});
const clipboardStatusText=(()=>{const __name=fn=>fn;return (${clipboardStatus.toString()})})();
let clipboardWasConnected=false,clipboardWasReadOnly=true;
const clipboardLocalPath=${JSON.stringify(localPath ?? null)};
let clipboardBridge,clipboardSelect,clipboardNote,clipboardManual,clipboardPopup,clipboardLauncher;
let clipboardAvailability={type:'desktop-clipboard-available',connected:false,viewOnly:true};
const clipboardZh=(navigator.language||'en').startsWith('zh');
function showClipboard(){clipboardControls();clipboardPopup?.open();clipboardManual?.open()}
function clipboardControls(){
 if(clipboardSelect||clipboardManual||parent!==window)return;
 clipboardPopup=(()=>{const __name=fn=>fn;return (${clipboardDialog.toString()})})()(clipboardZh,()=>clipboardManual?.cancel());
 clipboardLauncher=document.createElement('button');clipboardLauncher.id='clipboard-launcher';clipboardLauncher.textContent=clipboardZh?'剪贴板':'Clipboard';clipboardLauncher.onclick=showClipboard;clipboardLauncher.hidden=!clipboardAvailability.connected||clipboardAvailability.toolbar;document.body.insertBefore(clipboardLauncher,frame);
 if(!clipboardLocalPath||!['localhost','127.0.0.1','[::1]'].includes(location.hostname)){
  clipboardManual=(()=>{const __name=fn=>fn;return (${manualClipboardControls.toString()})})()({host:clipboardPopup.host,post:data=>frame.contentWindow.postMessage(data,'*'),zh:clipboardZh,alwaysVisible:true});clipboardManual.receive(clipboardAvailability);return;
 }
 const bar=document.createElement('div');bar.id='clipboard-bar';
 const label=document.createElement('label');label.textContent=clipboardZh?'剪贴板 ':'Clipboard ';
 clipboardSelect=document.createElement('select');clipboardSelect.setAttribute('aria-label',label.textContent);
 for(const [value,zh,en] of [['off','关闭','Off'],['send','我方 → 对方','Local → remote'],['receive','对方 → 我方','Remote → local'],['both','双向同步','Both directions']]){const option=document.createElement('option');option.value=value;option.textContent=clipboardZh?zh:en;clipboardSelect.append(option)}
 clipboardNote=document.createElement('span');label.append(clipboardSelect);bar.append(label,clipboardNote);clipboardPopup.host.append(bar);
 clipboardSelect.disabled=!clipboardAvailability.connected;
 for(const option of clipboardSelect.options)option.disabled=clipboardAvailability.viewOnly&&['send','both'].includes(option.value);
 clipboardBridge=(()=>{const __name=fn=>fn;return (${clipboardBrowserBridge.toString()})})()({open:()=>{const url=new URL(clipboardLocalPath,location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';return new WebSocket(url)},id:()=>crypto.randomUUID(),post:data=>frame.contentWindow.postMessage(data,'*'),state:code=>{frame.contentWindow.postMessage({type:'desktop-clipboard-status',code},'*');if(code==='clipboard-ready')clipboardNote.textContent=clipboardZh?'文本、图片、文件 · 复制后同步':'Text, images, files · copy to sync';else if(code==='clipboard-off')clipboardNote.textContent='';else if(code==='clipboard-connecting')clipboardNote.textContent=clipboardZh?'正在连接…':'Connecting…';else{clipboardNote.textContent=clipboardStatusText(code,clipboardZh)||(clipboardZh?'连接暂不可用，已保留同步方向；请重新连接。':'Connection unavailable; direction is saved. Reconnect to retry.')}}});
 clipboardSelect.value=clipboardPreferences.read().clipboard||'off';
 clipboardSelect.onchange=()=>{clipboardPreferences.write({clipboard:clipboardSelect.value});clipboardBridge.set(clipboardSelect.value)};
}
addEventListener('pagehide',()=>{clipboardBridge?.close();clipboardManual?.close();clipboardPopup?.remove()});
addEventListener('message',event=>{
 const data=event.data;
 if(event.source===parent&&parent!==window&&['desktop-clipboard','desktop-clipboard-status'].includes(data?.type)){frame.contentWindow.postMessage(data,'*');return}
 if(event.source!==frame.contentWindow||event.origin!=='null'||!['desktop-clipboard','desktop-clipboard-available','desktop-clipboard-show'].includes(data?.type))return;
 if(parent!==window){parent.postMessage(data,'*');return}
 // A remote request only opens trusted UI; it cannot select a direction or enable native sync.
 if(data.type==='desktop-clipboard-show'){showClipboard();return}
 if(data.type==='desktop-clipboard-available'){
  clipboardAvailability={type:data.type,connected:data.connected===true,viewOnly:data.viewOnly!==false,toolbar:data.toolbar===true};
  if(data.connected)clipboardControls();
  if(clipboardLauncher)clipboardLauncher.hidden=!data.connected||clipboardAvailability.toolbar;
  if(!data.connected)clipboardPopup?.hide();
 }
 if(clipboardManual){clipboardManual.receive(data);return}
 if(data.type==='desktop-clipboard-available'){
  if(data.connected)clipboardControls();if(!clipboardSelect)return;
  clipboardSelect.disabled=!data.connected;
  for(const option of clipboardSelect.options)option.disabled=!!data.viewOnly&&['send','both'].includes(option.value);
  if(!data.connected){clipboardBridge.close();clipboardWasConnected=false}else if(!clipboardWasConnected||clipboardWasReadOnly!==(data.viewOnly!==false)){const desired=clipboardPreferences.read().clipboard||'off';clipboardSelect.value=data.viewOnly!==false?(desired==='both'?'receive':desired==='send'?'off':desired):desired;clipboardBridge.set(clipboardSelect.value);clipboardWasConnected=true}clipboardWasReadOnly=data.viewOnly!==false;
 }else clipboardBridge?.receive(data);
});`;
}
