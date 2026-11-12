/** The remote document never gets a local clipboard URL or authority to enable it. */
export function desktopClipboardPageScript() {
	return String.raw`
let clipboardSocket=null,clipboardChannel='',clipboardActive=false;
function clipboardPost(payload){if(parent!==window)parent.postMessage({type:'desktop-clipboard',channel:clipboardChannel,payload},'*')}
function stopClipboard(){const previous=clipboardSocket;clipboardSocket=null;if(previous){previous.onmessage=previous.onclose=previous.onerror=null;previous.close()}if(clipboardActive)clipboardPost({type:'clipboard-stopped'});clipboardActive=false;clipboardChannel=''}
function clipboardAvailable(){if(parent!==window)parent.postMessage({type:'desktop-clipboard-available',viewOnly:connectionViewOnly,connected:ready},'*')}
addEventListener('message',event=>{
 if(event.source!==parent||parent===window)return;
 const data=event.data;
 if(data?.type!=='desktop-clipboard'||typeof data.channel!=='string'||!/^[a-f0-9-]{36}$/.test(data.channel))return;
 const value=data.payload;if(!value||typeof value!=='object')return;
 if(value.type==='bridge-start'){
  stopClipboard();if(!ready||!['send','receive','both'].includes(value.mode))return;
  clipboardChannel=data.channel;clipboardActive=true;
  if(connectionViewOnly&&value.mode!=='receive'){clipboardPost({type:'clipboard-error',code:'clipboard-readonly'});return}
  const url=appUrl('desktop-clipboard-ws');url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('viewOnly',connectionViewOnly?'1':'0');
  const current=new WebSocket(url);clipboardSocket=current;
  current.onmessage=event=>{if(current!==clipboardSocket||typeof event.data!=='string'||event.data.length>49152)return;try{const packet=JSON.parse(event.data);if(packet.type==='clipboard-capabilities'){current.send(JSON.stringify({type:'start',read:value.mode!=='send',write:value.mode!=='receive'}));return}clipboardPost(packet)}catch{stopClipboard()}};
  current.onclose=()=>{if(current===clipboardSocket)stopClipboard()};current.onerror=()=>{if(current===clipboardSocket){clipboardPost({type:'clipboard-error',code:'clipboard-unavailable'});stopClipboard()}};return;
 }
 if(data.channel!==clipboardChannel)return;
 if(value.type==='bridge-stop'){stopClipboard();return}
 if(!['offer','chunk','commit','ack'].includes(value.type))return;
 const packet=JSON.stringify(value);if(packet.length<=49152&&clipboardSocket?.readyState===WebSocket.OPEN)clipboardSocket.send(packet);
});
`;
}
