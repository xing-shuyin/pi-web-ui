export type DesktopPreferences = {
	quality?: string;
	edge?: number;
	fps?: number;
	scale?: boolean;
	viewOnly?: boolean;
	clipboard?: "off" | "send" | "receive" | "both";
};
/** Self-contained validation/storage for React and trusted standalone portals. */
export function desktopPreferences(scope: string) {
	const key = "pi-web-ui:desktop-preferences:" + encodeURIComponent(scope);
	function clean(value: unknown): DesktopPreferences {
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		const v = value as DesktopPreferences,
			out: DesktopPreferences = {};
		if (["auto", "smooth", "balanced", "sharp"].includes(v.quality!)) out.quality = v.quality;
		if ([0, 960, 1280, 1920, 2560].includes(v.edge!)) out.edge = v.edge;
		if ([10, 15, 30, 60, 120, 240].includes(v.fps!)) out.fps = v.fps;
		if (typeof v.scale === "boolean") out.scale = v.scale;
		if (typeof v.viewOnly === "boolean") out.viewOnly = v.viewOnly;
		if (["off", "send", "receive", "both"].includes(v.clipboard!)) out.clipboard = v.clipboard;
		return out;
	}
	let fallback: DesktopPreferences = {};
	function read() {
		try {
			return clean(JSON.parse(localStorage.getItem(key) ?? "{}"));
		} catch {
			return fallback;
		}
	}
	return {
		clean,
		read,
		write(value: unknown) {
			const next = { ...read(), ...clean(value) };
			fallback = next;
			try {
				localStorage.setItem(key, JSON.stringify(next));
			} catch {}
			return next;
		},
	};
}

/** Preferences contain no credentials; nested pages can only address this bounded namespace. */
export function desktopPreferencesPortalScript(scope?: string) {
	return String.raw`
const desktopPreferenceStore=(()=>{const __name=fn=>fn;return (${desktopPreferences.toString()})})()(${JSON.stringify(scope ?? "desktop")});
const desktopPreferenceScope=${JSON.stringify(scope ?? "desktop")};
addEventListener('message',event=>{
 const data=event.data;if(!data||!['desktop-preferences-read','desktop-preferences-write','desktop-preferences-value'].includes(data.type))return;
 if(event.source===parent&&parent!==window&&data.type==='desktop-preferences-value'){frame.contentWindow.postMessage(data,'*');return}
 if(event.source!==frame.contentWindow||event.origin!=='null'||data.type==='desktop-preferences-value')return;
 if(parent!==window){parent.postMessage(data,'*');return}
 const target=typeof data.target==='string'&&/^[a-z0-9][a-z0-9-]{0,62}$/.test(data.target)?data.target:'';
 let targetScope=desktopPreferenceScope;try{const identity=JSON.parse(desktopPreferenceScope);if(target&&Array.isArray(identity)&&identity.length===2&&typeof identity[0]==='string')targetScope=JSON.stringify([identity[0],target])}catch{}
 const store=target?(()=>{const __name=fn=>fn;return (${desktopPreferences.toString()})})()(targetScope):desktopPreferenceStore;
 if(data.type==='desktop-preferences-write'){const value=store.clean(data.value);delete value.clipboard;store.write(value)}
 else frame.contentWindow.postMessage({type:'desktop-preferences-value',target,value:store.read()},'*');
});`;
}

export function desktopPreferencesPageScript() {
	return String.raw`
const desktopPrefs=(()=>{const __name=fn=>fn;return (${desktopPreferences.toString()})})()('local-desktop');
let preferencesApplied=false;
function saveDesktopPreferences(){
 const value={quality:$('quality-mode').value,edge:Number($('quality-edge').value),fps:Number($('quality-fps').value),scale:$('scale').checked,viewOnly:$('viewonly').checked};
 if(parent===window)desktopPrefs.write(value);else parent.postMessage({type:'desktop-preferences-write',value},'*');
}
function applyDesktopPreferences(value){
 if(preferencesApplied)return;preferencesApplied=true;
 const v=desktopPrefs.clean(value),oldViewOnly=$('viewonly').checked;
 for(const [key,id] of [['quality','quality-mode'],['edge','quality-edge'],['fps','quality-fps']])if(v[key]!==undefined)$(id).value=String(v[key]);
 if(v.scale!==undefined){$('scale').checked=v.scale;screen.classList.toggle('native',!v.scale)}
 if(v.viewOnly!==undefined)$('viewonly').checked=v.viewOnly;
 updateQuality();if(socket&&oldViewOnly!==$('viewonly').checked)connect();
}
for(const id of ['quality-mode','quality-edge','quality-fps','scale','viewonly'])$(id).addEventListener('change',saveDesktopPreferences);
addEventListener('message',event=>{if(event.source===parent&&parent!==window&&event.data?.type==='desktop-preferences-value')applyDesktopPreferences(event.data.value)});
if(parent===window)applyDesktopPreferences(desktopPrefs.read());else parent.postMessage({type:'desktop-preferences-read'},'*');
`;
}
