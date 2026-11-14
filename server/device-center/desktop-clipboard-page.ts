import { manualClipboardControls } from "./desktop-clipboard-manual.js";
import { clipboardDialog } from "./desktop-clipboard-dialog.js";
import { clipboardStatus } from "./desktop-clipboard-status.js";

/** The remote document never gets a local clipboard URL or authority to enable it. */
export function desktopClipboardPageScript() {
	return String.raw`
let clipboardSocket=null,clipboardChannel='',clipboardActive=false;
let standaloneClipboard,standaloneClipboardPopup;
function clipboardPost(payload){const data={type:'desktop-clipboard',channel:clipboardChannel,payload};if(parent!==window)parent.postMessage(data,'*');else queueMicrotask(()=>standaloneClipboard?.receive(data))}
function stopClipboard(){const previous=clipboardSocket;clipboardSocket=null;if(previous){previous.onmessage=previous.onclose=previous.onerror=null;previous.close()}if(clipboardActive)clipboardPost({type:'clipboard-stopped'});clipboardActive=false;clipboardChannel=''}
function clipboardAvailable(){const data={type:'desktop-clipboard-available',viewOnly:connectionViewOnly,connected:ready,toolbar:true};if(parent!==window)parent.postMessage(data,'*');else standaloneClipboard?.receive(data)}
$('clipboard').onclick=()=>{
 if(parent!==window){parent.postMessage({type:'desktop-clipboard-show'},'*');return}
 if(!standaloneClipboard){
  standaloneClipboardPopup=(()=>{const __name=fn=>fn;return (${clipboardDialog.toString()})})()(zh,()=>standaloneClipboard?.cancel());
  standaloneClipboard=(()=>{const __name=fn=>fn;return (${manualClipboardControls.toString()})})()({host:standaloneClipboardPopup.host,post:data=>receiveClipboard(data),zh,alwaysVisible:true});
 }
 clipboardAvailable();standaloneClipboardPopup.open();standaloneClipboard.open();
};
addEventListener('message',event=>{if(event.source===parent&&parent!==window)receiveClipboard(event.data)});
function receiveClipboard(data){
 if(data?.type==='desktop-clipboard-status'&&typeof data.code==='string'&&data.code.length<160){let banner=$('clipboard-transfer-status');if(!banner){banner=document.createElement('p');banner.id='clipboard-transfer-status';banner.setAttribute('role','status');banner.style.cssText='padding:6px 12px;background:var(--bg-elev);color:var(--text);border-bottom:1px solid var(--border);flex:none';$('toolbar').after(banner)}const text=(()=>{const __name=fn=>fn;return (${clipboardStatus.toString()})})()(data.code,zh);banner.textContent=text||'';banner.hidden=!text;return}
 if(data?.type!=='desktop-clipboard'||typeof data.channel!=='string'||!/^[a-f0-9-]{36}$/.test(data.channel))return;
 const value=data.payload;if(!value||typeof value!=='object')return;
 if(value.type==='bridge-start'||value.type==='bridge-text-start'){
  stopClipboard();if(!ready||!['send','receive','both'].includes(value.mode))return;
  clipboardChannel=data.channel;clipboardActive=true;
  if(connectionViewOnly&&value.mode!=='receive'){clipboardPost({type:'clipboard-error',code:'clipboard-readonly'});return}
  const url=appUrl('desktop-clipboard-ws');url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('viewOnly',connectionViewOnly?'1':'0');
  const current=new WebSocket(url);clipboardSocket=current;
  current.onmessage=event=>{if(current!==clipboardSocket||typeof event.data!=='string'||event.data.length>49152)return;try{const packet=JSON.parse(event.data);if(packet.type==='clipboard-capabilities'){if(value.type==='bridge-text-start'&&packet.manualText!==true){clipboardPost({type:'clipboard-error',code:'clipboard-update'});stopClipboard();return}clipboardPost(packet);const stream=value.type==='bridge-start'&&value.capabilities?.streamFiles===true&&packet.streamFiles===true;current.send(JSON.stringify({type:'start',read:value.mode!=='send',write:value.mode!=='receive',...(value.type==='bridge-text-start'?{manual:true}:stream?{streamFiles:true,maxBytes:Math.min(Number(value.capabilities.maxFileBytes)||33554432,17179869184)}:{})}));return}clipboardPost(packet)}catch{stopClipboard()}};
  current.onclose=()=>{if(current===clipboardSocket)stopClipboard()};current.onerror=()=>{if(current===clipboardSocket){clipboardPost({type:'clipboard-error',code:'clipboard-unavailable'});stopClipboard()}};return;
 }
 if(data.channel!==clipboardChannel)return;
 if(value.type==='bridge-stop'){stopClipboard();return}
 if(!['offer','chunk','commit','ack','abort','text-read','text-write'].includes(value.type))return;
 const packet=JSON.stringify(value);if(packet.length<=49152&&clipboardSocket?.readyState===WebSocket.OPEN)clipboardSocket.send(packet);
}
`;
}
