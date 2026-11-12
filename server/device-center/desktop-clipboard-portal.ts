import { clipboardBrowserBridge } from "./desktop-clipboard-bridge.js";

export function desktopClipboardPortalScript(localPath?: string) {
	return String.raw`
const clipboardLocalPath=${JSON.stringify(localPath ?? null)};
let clipboardBridge,clipboardSelect,clipboardNote;
const clipboardZh=(navigator.language||'en').startsWith('zh');
function clipboardControls(){
 if(clipboardSelect||parent!==window||!clipboardLocalPath||!['localhost','127.0.0.1','[::1]'].includes(location.hostname))return;
 const bar=document.createElement('div');bar.id='clipboard-bar';
 const label=document.createElement('label');label.textContent=clipboardZh?'剪贴板 ':'Clipboard ';
 clipboardSelect=document.createElement('select');clipboardSelect.setAttribute('aria-label',label.textContent);
 for(const [value,zh,en] of [['off','关闭','Off'],['send','我方 → 对方','Local → remote'],['receive','对方 → 我方','Remote → local'],['both','双向同步','Both directions']]){const option=document.createElement('option');option.value=value;option.textContent=clipboardZh?zh:en;clipboardSelect.append(option)}
 clipboardNote=document.createElement('span');label.append(clipboardSelect);bar.append(label,clipboardNote);document.body.append(bar);
 clipboardBridge=(()=>{const __name=fn=>fn;return (${clipboardBrowserBridge.toString()})})()({open:()=>{const url=new URL(clipboardLocalPath,location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';return new WebSocket(url)},id:()=>crypto.randomUUID(),post:data=>frame.contentWindow.postMessage(data,'*'),state:code=>{if(code==='clipboard-ready')clipboardNote.textContent=clipboardZh?'文本、图片、文件 · 复制后同步':'Text, images, files · copy to sync';else if(code==='clipboard-off')clipboardNote.textContent='';else if(code==='clipboard-connecting')clipboardNote.textContent=clipboardZh?'正在连接…':'Connecting…';else{clipboardSelect.value='off';clipboardNote.textContent=clipboardZh?'同步已停止，请检查两端版本和本机权限':'Sync stopped. Check both versions and local permissions.'}}});
 clipboardSelect.onchange=()=>clipboardBridge.set(clipboardSelect.value);
}
addEventListener('pagehide',()=>clipboardBridge?.close());
addEventListener('message',event=>{
 const data=event.data;
 if(event.source===parent&&parent!==window&&data?.type==='desktop-clipboard'){frame.contentWindow.postMessage(data,'*');return}
 if(event.source!==frame.contentWindow||event.origin!=='null'||!['desktop-clipboard','desktop-clipboard-available'].includes(data?.type))return;
 if(parent!==window){parent.postMessage(data,'*');return}
 if(data.type==='desktop-clipboard-available'){
  if(data.connected)clipboardControls();if(!clipboardSelect)return;
  document.getElementById('clipboard-bar').hidden=!data.connected;
  for(const option of clipboardSelect.options)option.disabled=!!data.viewOnly&&['send','both'].includes(option.value);
  if(!data.connected){clipboardBridge.close();clipboardSelect.value='off'}
 }else clipboardBridge?.receive(data);
});`;
}
