export function desktopDisplayPortalScript(scope?: string) {
	const key = scope ? "pi-web-ui:desktop-display:" + encodeURIComponent(scope) : null;
	return String.raw`
const displayStorageKey=${JSON.stringify(key)};let displayInitial=true,displayWaiting=false;
addEventListener('message',event=>{
 if(parent!==window||event.source!==frame.contentWindow||event.origin!=='null'||event.data?.type!=='desktop-displays'||!displayStorageKey)return;
 const {displays,selected}=event.data;
 if(!Array.isArray(displays)||displays.length>32||typeof selected!=='string'||selected.length>128||!displays.some(d=>d?.id===selected))return;
 let saved;try{saved=localStorage.getItem(displayStorageKey)}catch{}
 if(displayInitial&&saved&&saved!==selected&&displays.some(d=>d?.id===saved)){
  if(!displayWaiting){displayWaiting=true;frame.contentWindow.postMessage({type:'desktop-select-display',display:saved},'*')}return;
 }
 displayInitial=false;try{localStorage.setItem(displayStorageKey,selected)}catch{}
});`;
}
