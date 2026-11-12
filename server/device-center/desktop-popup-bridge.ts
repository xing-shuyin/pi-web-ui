/** Only the trusted outer portal may open a window; remote content supplies no URL. */
export function desktopPopupBridge(endpoint?: string): string {
	return String.raw`const desktopOpenPath=${JSON.stringify(endpoint ?? null)};let desktopOpening=false;
async function openDesktopTab(requestId){
 if(!desktopOpenPath||desktopOpening)return;
 desktopOpening=true;
 const reply=(ok,error)=>frame.contentWindow.postMessage({type:'device-desktop-open-result',requestId,ok,error},'*');
 const tab=window.open('about:blank','_blank');
 if(!tab){desktopOpening=false;reply(false,'popup');return}
 tab.opener=null;
 try{
  const response=await fetch(desktopOpenPath,{method:'POST',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw new Error('open');
  const data=await response.json(),url=new URL(data.url),endpoint=new URL(desktopOpenPath);
  const expected=endpoint.pathname.replace(/\/__relay\/[a-f0-9]{64}\/__desktop_open$/,'/__open');
  if(url.origin!==endpoint.origin||url.pathname!==expected||url.username||url.password||!(/^[a-f0-9]{64}$/).test(url.searchParams.get('ticket')||''))throw new Error('url');
  url.search='?ticket='+url.searchParams.get('ticket')+'&next=%2Fdesktop';url.hash='';
  if(tab.closed)throw new Error('closed');
  tab.location.replace(url.href);reply(true);
 }catch{tab.close();reply(false,'open')}finally{desktopOpening=false}
}
addEventListener('message',event=>{
 if(event.source!==frame.contentWindow||event.origin!=='null')return;
 const data=event.data;
 if(data?.type==='device-desktop-open'&&typeof data.requestId==='string'&&/^[a-f0-9-]{36}$/.test(data.requestId))void openDesktopTab(data.requestId);
});`;
}
