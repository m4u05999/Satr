'use strict';
const {app,BrowserWindow}=require('electron');
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'satr-history-ui-'));
app.setPath('userData',profile);
const timer=setTimeout(()=>{console.error('history-ui timeout');app.exit(1);},30000);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
 const errors=[];win.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message);});
 const fixture=path.join(__dirname,'fixtures','conversation-history.html');
 await win.loadFile(fixture);
 await win.webContents.executeJavaScript("customElements.whenDefined('satr-chat').then(()=>document.fonts.ready).then(()=>true)");
 const result=await win.webContents.executeJavaScript('('+String(async function(){
  const chat=document.querySelector('satr-chat');
  const records=[];
  for(let i=0;i<24;i++){
   records.push({role:'user',engine:'codex',runId:'r'+i,text:'رسالة المستخدم رقم '+i});
   records.push({role:'assistant',engine:'codex',runId:'r'+i,status:'completed',phase:'commentary',text:'مراجعة التفاصيل الأصلية '+i});
   records.push({role:'assistant',engine:'codex',runId:'r'+i,status:'completed',phase:'final_answer',text:'الإجابة النهائية الكاملة '+i});
  }
  // نقارن محتوى الأسطح الحية والمستعادة باستعمال المكوّن نفسه.
  function surfaces(){return [...document.querySelectorAll('.msg')].map(el=>({
   user:el.classList.contains('user'),text:el.querySelector('.bubble')?.textContent||'',
   commentary:el.querySelector('.commentary-md')?.textContent||'',
   answer:el.querySelector('.answer-wrap .md')?.textContent||'',
  }));}
  for(let i=0;i<records.length;i+=3){
   chat.addUserMsg(records[i].text);
   const block=chat.newAssistantBlock('Codex');
   block.addText(records[i+1].text,null,'commentary');
   block.addText(records[i+2].text,null,'final_answer');block.finish();
  }
  const before=surfaces();
  chat.clearThread();chat.addConversationHistory(records);
  const after=surfaces();
  const id='conv-11111111-1111-4111-8111-111111111111';
  chat.rememberConversationView(id);
  const main=document.querySelector('main');
  main.scrollTop=400;
  main.dispatchEvent(new Event('scroll'));
  window.dispatchEvent(new Event('beforeunload'));
  const saved=JSON.parse(localStorage.getItem('satr_conversation_views'))[id];
  chat.clearThread();chat.addConversationHistory(records);chat.scrollToEnd(true);
  chat.rememberConversationView(id,true);
  await new Promise(requestAnimationFrame);
  return {before,after,saved,top:main.scrollTop,working:document.querySelectorAll('.worklog.working').length,
   users:document.querySelectorAll('.msg.user').length,assistants:document.querySelectorAll('.msg.assistant').length};
 })+')()');
 assert.deepEqual(result.after,result.before,'visible transcript changed after restoration');
 assert.equal(result.users,24);assert.equal(result.assistants,24);assert.equal(result.working,0);
 assert.equal(result.saved.pinned,false);assert(Math.abs(result.top-result.saved.top)<2,'reading position was lost');
 assert.deepEqual(errors,[]);
 // إعادة تحميل الوثيقة تختبر بقاء العرض المخزن بعد دورة واجهة كاملة.
 await win.reload();
 await win.webContents.executeJavaScript("customElements.whenDefined('satr-chat').then(()=>true)");
 const persisted=await win.webContents.executeJavaScript("JSON.parse(localStorage.getItem('satr_conversation_views'))['conv-11111111-1111-4111-8111-111111111111'].top");
 assert.equal(persisted,result.saved.top);
 console.log('PASS history UI: live/restored surfaces identical, 24 users, 24 turns, reading position, reload, no renderer errors');
 win.destroy();clearTimeout(timer);app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(timer);app.exit(1);});
