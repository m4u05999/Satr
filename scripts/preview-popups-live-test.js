'use strict';
// صفحات محلية بأصلين: اختبار وحدة المعاينة الإنتاجية بلا حسابات ولا تبديل معالج window.open.
const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.join(process.env.SATR_POPUP_TEST_HOME, 'profile'));
const preview = require('../electron/preview');
const codexmcp = require('../electron/codexmcp');
const report = { scope:'production-preview-module', cases:[], passed:false, electron:process.versions.electron };
const servers=[], windows=[], children=[];
let parentOrigin, childOrigin, checks=0;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function check(value,label){assert(value,label);checks++;console.log('PASS '+label);}
async function until(fn,label,ms=5000){const end=Date.now()+ms;while(Date.now()<end){const r=await fn();if(r)return r;await delay(20);}throw Error('TIMEOUT '+label);}
function page(body,script=''){return '<!doctype html><html lang="en" dir="ltr"><meta charset="utf-8"><title>Popup test</title><body>'+body+'<script>'+script+'</script></body></html>';}
function parentPage(){
  return page('<p id="parent">Parent retained</p><button id="launch">Open</button>',
    'window.marker="parent-retained";window.messages=[];window.popup=null;'+
    'addEventListener("message",e=>{if(e.origin==='+JSON.stringify(childOrigin)+')messages.push({source:e.source===popup,data:e.data,origin:e.origin});});'+
    'window.launch=function(kind){var url='+JSON.stringify(childOrigin+'/child')+';if(kind==="coop")url+="?coop=1";if(kind==="deny")url="file:///satr-popup-forbidden";'+
    'popup=window.open(kind==="blank"?"about:blank":url,"popup_"+Math.random(),"width=500,height=650"+(kind==="noopener"?",noopener":""));'+
    'if(kind==="blank"&&popup)popup.location=url;return !!popup;};'+
    'document.getElementById("launch").onclick=()=>launch("normal");');
}
async function serve(){
 const s=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  const h={'content-type':'text/html; charset=utf-8','cache-control':'no-store'};
  if(url.searchParams.has('coop'))h['Cross-Origin-Opener-Policy']='same-origin';
  if(url.pathname==='/parent')h['Set-Cookie']='popup_fixture=synthetic; Path=/; SameSite=Lax';
  if(url.pathname==='/long-redirect'){res.writeHead(302,{...h,Location:childOrigin+'/parent?redirectflow='+'x'.repeat(3200)});return res.end();}
  res.writeHead(200,h);
  if(url.pathname==='/empty')return res.end(page(''));
  if(url.pathname==='/child')return res.end(page('<p id="child">Child active</p><button id="done">Done</button>',
    'window.facts={opener:!!opener,cookie:document.cookie.includes("popup_fixture=synthetic"),node:typeof require!=="undefined"||typeof process!=="undefined",bridge:typeof satr!=="undefined"};'+
    'document.getElementById("done").onclick=()=>{if(opener)opener.postMessage(facts,'+JSON.stringify(parentOrigin)+');window.close();};'));
  res.end(parentPage());
 });
 servers.push(s);await new Promise(r=>s.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+s.address().port;
}
async function fixture(){
 const win=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 windows.push(win);
 const events=[];preview.setBounds({x:20,y:40,width:900,height:700});
 preview.open(win,e=>events.push(e),parentOrigin+'/parent');
 await until(()=>win.contentView.children.length,'parent view');
 const parent=win.contentView.children[0].webContents;
 await until(async()=>{try{return await parent.executeJavaScript('!!document.getElementById("parent")');}catch{return false;}},'parent ready');
 return {win,parent,events};
}
async function childOf(win){
 await until(()=>preview.popupState().active,'active child');
 const v=win.contentView.children.at(-1),wc=v.webContents;children.push(wc);
 await until(async()=>{try{return await wc.executeJavaScript('!!window.facts');}catch{return false;}},'child ready');
 return {v,wc};
}
async function finishChild(wc){await wc.executeJavaScript('document.getElementById("done").click()').catch(()=>{});await until(()=>wc.isDestroyed(),'child closed');}
async function normalCase(kind){
 const {win,parent,events}=await fixture(), before=preview.targetToken();
 const snap=await preview.snapshot();
 const returned=await parent.executeJavaScript('launch('+JSON.stringify(kind)+')',true);
 if(kind==='deny'){
   await delay(120);check(!returned&&!preview.popupState().active,'denied popup creates no child');
 }else{
   const {v,wc}=await childOf(win), detached=kind==='noopener'||kind==='coop';
   const facts=await wc.executeJavaScript('facts'), prefs=wc.getLastWebPreferences();
   check(facts.opener===!detached,kind+' opener policy');
   check(wc.session===parent.session&&facts.cookie,kind+' shared session and cookie');
   check(prefs.sandbox&&prefs.contextIsolation&&!prefs.nodeIntegration&&!prefs.preload&&!facts.node&&!facts.bridge,kind+' isolation');
   check(v.getBounds().width===500&&v.getBounds().height===650,kind+' dimensions');
   check((await preview.readPage()).page.bodyText.includes('Child active'),kind+' tools target child');
   check(preview.targetToken()!==before,kind+' target ticket changes');
   check(preview.browserInputError('browser_click',{ref:'s'+snap.snap.generation+':e1'})==='stale_ref',kind+' parent refs rejected');
   if(kind==='normal'){
     preview.setBounds({x:0,y:0,width:0,height:0});
     check(win.contentView.children.every(x=>x.getBounds().width===0),'shield hides all views');
     preview.setBounds({x:20,y:40,width:900,height:700});
     check(win.contentView.children[0].getBounds().width===0&&v.getBounds().width===500,'only child visible');
   }
   await finishChild(wc);
   const result=await parent.executeJavaScript('({messages,closed:popup?popup.closed:null,marker})');
   check(result.messages.length===(detached?0:1),kind+' postMessage count');
   if(!detached)check(returned&&result.closed&&result.messages[0].source&&result.messages[0].origin===childOrigin,kind+' message source and handle close');
   if(kind==='noopener')check(!returned,'noopener returns null');
   if(kind==='coop')check(result.closed,'COOP severs handle');
   check(!preview.popupState().active&&win.contentView.children.length===1,kind+' child detached');
   check(preview.targetToken()!==before,'return to parent does not reuse ticket');
 }
 check(!parent.isDestroyed()&&await parent.executeJavaScript('marker==="parent-retained"'),'parent survives '+kind);
 check(!events.some(e=>e.type==='closed'),'no panel closed event '+kind);
 report.cases.push({kind,passed:true});preview.close();win.destroy();
}
async function moreCases(){
 const {win,parent}=await fixture();
 await parent.executeJavaScript('launch("normal")',true);
 let {wc}=await childOf(win);
 preview.startHandoff();
 preview.action('popup_close');
 await until(()=>wc.isDestroyed(),'manual close');
 check(preview.isHandoffActive(),'closing child preserves human handoff');
 preview.endHandoff();
 check((await preview.readPage()).page.bodyText.includes('Parent retained'),'tools return to parent');
 for(let i=0;i<3;i++){
   await (i?wc:parent).executeJavaScript('window.open('+JSON.stringify(childOrigin+'/child')+',"nested_"+Math.random(),"width=420,height=500")!==null',true);
   ({wc}=await childOf(win));
 }
 check(preview.popupState().count===3,'three children allowed');
 check(await wc.executeJavaScript('window.open('+JSON.stringify(childOrigin+'/child')+')===null',true),'fourth child denied');
 check(preview.popupState().count===3&&!parent.isDestroyed(),'limit preserves parent and children');
 const owned=children.filter(c=>!c.isDestroyed());
 preview.close();
 await until(()=>owned.every(c=>c.isDestroyed()),'tree destroyed');
 check(owned.every(c=>c.isDestroyed())&&win.contentView.children.length===0,'panel close destroys whole popup tree');
 win.destroy();report.cases.push({kind:'handoff-limit-cleanup',passed:true});
 const f=await fixture();
 preview.navigate(parentOrigin+'/empty?code=synthetic');
 await until(()=>preview.popupState().warning.includes('فارغة'),'blank callback warning',7000);
 check(!JSON.stringify(preview.popupState()).includes('synthetic'),'diagnostic contains no callback code');
 preview.close();f.win.destroy();report.cases.push({kind:'blank-callback',passed:true});
}
async function permissionCase(){
 const {win,parent}=await fixture();
 let approve;
 const mcp=await codexmcp.start({preview,requestPermission:()=>new Promise(r=>{approve=r;})});
 try {
   const pending=fetch(mcp.url,{method:'POST',headers:{Authorization:'Bearer '+mcp.token,'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'browser_navigate',arguments:{url:parentOrigin+'/empty'}}})}).then(r=>r.json());
   await until(()=>approve,'permission prompt');
   await parent.executeJavaScript('window.open('+JSON.stringify(parentOrigin+'/child')+',"same_origin")!==null',true);
   const {wc}=await childOf(win);
   approve(true);
   const response=await pending;
   check(response.result.isError&&response.result.content[0].text.includes('تغيّرت'),'pending permission cannot transfer to same-origin child');
   check(wc.getURL()===parentOrigin+'/child','rejected permission did not navigate child');
   const annotated=preview.annotateBrowserResult({content:[{type:'text',text:'result'}]});
   check(annotated.content.length===2&&annotated.content[1].text.includes('نافذة منبثقة'),'tool result identifies popup target');
 } finally {await mcp.stop();preview.close();win.destroy();}
 report.cases.push({kind:'permission-target',passed:true});
}

// عنوان عودة حقيقي طويل: نفحص تنقّل renderer وتحويل HTTP وطفلاً جديداً، لا loadURL بديلة.
async function longNavigationCases(){
 const {win,parent}=await fixture(), longUrl=childOrigin+'/parent?flow='+'x'.repeat(3200);
 const redirectedUrl=childOrigin+'/parent?redirectflow='+'x'.repeat(3200);
 check(preview.navigate(longUrl).error==='bad_url','tool URL input limit remains 2048');
 await parent.executeJavaScript('(()=>{const a=document.createElement("a");a.href='+JSON.stringify(longUrl)+';a.id="long-link";a.textContent="Long link";document.body.append(a);a.focus()})()');
 check(await preview.browserTarget('browser_click',{ref:'#long-link'})===longUrl,'long cross-origin link retains permission target');
 await parent.executeJavaScript('location.href='+JSON.stringify(longUrl)).catch(()=>{});
 await until(()=>parent.getURL()===longUrl,'long renderer navigation');
 check(parent.getURL()===longUrl,'long renderer navigation reaches destination');
 await parent.executeJavaScript('location.href='+JSON.stringify(parentOrigin+'/long-redirect')).catch(()=>{});
 await until(()=>!parent.isLoading()&&parent.getURL()===redirectedUrl,'long HTTP redirect');
 check(parent.getURL()===redirectedUrl,'long HTTP redirect reaches destination');
 const childUrl=childOrigin+'/child?flow='+'x'.repeat(3200);
 check(await parent.executeJavaScript('window.open('+JSON.stringify(childUrl)+',"long_popup","width=500,height=650")!==null',true),'long popup URL allowed');
 const {wc}=await childOf(win);
 check(wc.getURL()===childUrl&&await wc.executeJavaScript('!!opener'),'long popup keeps destination and opener');
 check(preview.popupState().origin===childOrigin,'long popup still exposes origin');
 await finishChild(wc);
 for(const url of ['file:///satr-navigation-forbidden','data:text/html,forbidden']){
  await parent.executeJavaScript('location.href='+JSON.stringify(url)).catch(()=>{});
  await delay(80);check(parent.getURL()===redirectedUrl,'non-web navigation still blocked '+url.split(':')[0]);
 }
 preview.close();win.destroy();report.cases.push({kind:'long-navigation',passed:true});
}

async function main(){
 await app.whenReady();parentOrigin=await serve();childOrigin=await serve();
 await longNavigationCases();
 for(const k of ['normal','blank','noopener','coop','deny'])await normalCase(k);
 await moreCases();await permissionCase();report.passed=true;
}
let finishing=false;
async function finish(err){
 if(finishing)return;finishing=true;clearTimeout(timer);
 if(err){report.error=err.stack;console.error('FAIL '+err.message);}
 preview.destroy();for(const w of windows)if(!w.isDestroyed())w.destroy();
 for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}
 report.checks=checks;report.cleanup=windows.every(w=>w.isDestroyed())&&children.every(w=>w.isDestroyed());
 fs.writeFileSync(process.env.SATR_POPUP_TEST_RESULT,JSON.stringify(report,null,2));
 console.log('popup-live: '+checks+' checks; '+(report.passed?'PASS':'FAIL'));app.exit(err?1:0);
}
app.on('window-all-closed',()=>{});
const timer=setTimeout(()=>finish(Error('live guard timeout')),45000);
main().then(()=>finish(),finish);
