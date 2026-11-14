/** Only the trusted outer portal may open a window; remote content supplies no URL. */
export function desktopPopupBridge(endpoint?: string, hubOrigin?: string): string {
	return String.raw`const desktopOpenPath=${JSON.stringify(endpoint ?? null)};let desktopOpening=false;
async function openDesktopTab(requestId,deviceId){
 if(!desktopOpenPath||desktopOpening)return;
 desktopOpening=true;
 const reply=(ok,error)=>frame.contentWindow.postMessage({type:'device-desktop-open-result',requestId,ok,error},'*');
 const tab=window.open('about:blank','_blank');
 if(!tab){desktopOpening=false;reply(false,'popup');return}
 tab.opener=null;
 try{
  const request=new URL(desktopOpenPath);if(deviceId)request.searchParams.set('device',deviceId);
  const response=await fetch(request,{method:'POST',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw new Error('open');
  const data=await response.json(),url=new URL(data.url),endpoint=new URL(desktopOpenPath);
  const current=endpoint.pathname.match(/\/(?:device|device-lan)\/([^/]+)\/__relay\//)?.[1],target=deviceId||current;
  const expected=endpoint.pathname.replace(/\/(device|device-lan)\/[^/]+\/__relay\/[a-f0-9]{64}\/__desktop_open$/,(_,kind)=>'/'+kind+'/'+target+'/__open');
  const allowed=(url.origin===endpoint.origin&&url.pathname===expected)||(url.origin===${JSON.stringify(hubOrigin ?? null)}&&url.pathname==='/device/'+target+'/__open');
  if(!allowed||url.username||url.password||!(/^[a-f0-9]{64}$/).test(url.searchParams.get('ticket')||''))throw new Error('url');
  url.search='?ticket='+url.searchParams.get('ticket')+'&next=%2Fdesktop';url.hash='';
  if(tab.closed)throw new Error('closed');
  tab.location.replace(url.href);reply(true);
 }catch{tab.close();reply(false,'open')}finally{desktopOpening=false}
}
addEventListener('message',event=>{
 if(event.source!==frame.contentWindow||event.origin!=='null')return;
 const data=event.data;
 if(data?.type==='device-desktop-open'&&typeof data.requestId==='string'&&/^[a-f0-9-]{36}$/.test(data.requestId)&&(data.deviceId===undefined||typeof data.deviceId==='string'&&/^[a-z0-9][a-z0-9-]{0,62}$/.test(data.deviceId)))void openDesktopTab(data.requestId,data.deviceId);
});`;
}
