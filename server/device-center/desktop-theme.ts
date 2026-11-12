export const DESKTOP_THEME_TOKENS = [
	"--bg",
	"--bg-elev",
	"--bg-elev2",
	"--border",
	"--text",
	"--text-dim",
	"--accent",
	"--accent-contrast",
	"--green",
	"--red",
] as const;

export function desktopThemeScript() {
	return `addEventListener('message',event=>{if(event.source!==parent||event.data?.type!=='desktop-theme')return;const theme=event.data.theme;if(!theme||typeof theme!=='object')return;for(const key of ${JSON.stringify(DESKTOP_THEME_TOKENS)}){const value=theme[key];if(typeof value==='string'&&value.length<=128&&CSS.supports('color',value))document.documentElement.style.setProperty(key,value)}if(['dark','light'].includes(event.data.scheme))document.documentElement.style.colorScheme=event.data.scheme});if(parent!==window)parent.postMessage({type:'desktop-theme-request'},'*');`;
}
