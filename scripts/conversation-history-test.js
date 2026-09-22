'use strict';
// فحص مخزن الإنتاج والمصيّر نفسه ببيانات اصطناعية؛ لا يقرأ منزل المالك.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createStore } = require('../electron/conversations');
const { createBridge } = require('../electron/conversation-bridge');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-history-'));
const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
const disk = path.join(root, 'store');
function ok(value) { assert.equal(value.ok, true, JSON.stringify(value)); return value; }
(async () => {
 const store = createStore({root:disk}), bridge = createBridge({store});
 const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1cAAAAASUVORK5CYII=';
 const first = ok(store.prepare({cwd, engine:'codex', prompt:'السؤال الأول كاملاً', images:[png]}));
 ok(store.acceptEvent(first.runId,{type:'system',subtype:'init',session_id:'native-first'}));
 for(let i=0;i<14;i++) ok(store.acceptEvent(first.runId,{type:'assistant',phase:'commentary',message:{content:[{type:'text',text:'سرد مرحلي '+i}]}}));
 ok(store.acceptEvent(first.runId,{type:'assistant',message:{content:[{type:'tool_use',id:'tool-one',name:'Read',input:{secret:'do-not-archive-input'}}]}}));
 ok(store.acceptEvent(first.runId,{type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-one',content:'done'}]}}));
 ok(store.acceptEvent(first.runId,{type:'assistant',message:{content:[{type:'text',phase:'final_answer',text:'الإجابة النهائية كاملة'}]}}));
 ok(store.acceptEvent(first.runId,{type:'result'}));
 const second = ok(store.prepare({cwd,engine:'codex',conversationId:first.id,prompt:'السؤال الثاني كاملاً'}));
 ok(store.acceptEvent(second.runId,{type:'stream_text',phase:'commentary',text:'نص قبل انقطاع العملية'}));
 const reopened = createStore({root:disk}), reopenedBridge = createBridge({store:reopened});
 const snapshot = ok(reopenedBridge.read(first.id,cwd)).conversation;
 assert.equal(snapshot.messages.filter(m=>m.role==='user').length,2,'lost user messages');
 assert.equal(snapshot.messages.filter(m=>m.phase==='commentary').length,15,'lost phase or durable stream');
 assert.equal(snapshot.messages[0].images[0].dataUrl,png,'attachment was not restored');
 assert.equal(snapshot.messages.filter(m=>m.role==='tool_use').length,1,'lost tool identity');
 assert(snapshot.messages.some(m=>m.text==='نص قبل انقطاع العملية'),'draft was not persisted');
 assert(!JSON.stringify(snapshot).includes('do-not-archive-input'));
 const third = ok(store.create({cwd,engine:'sdk',messages:[{role:'user',text:'محادثة أخرى'}]}));
 ok(reopened.select(first.id,cwd,'codex'));
 assert.equal(ok(reopenedBridge.current(cwd)).conversation.id,first.id,'opening did not remember selected conversation');
 assert.equal(ok(reopened.list()).conversations.length,2,'catalog lost a conversation');
 const moduleFile = path.join(root,'history.mjs');
 fs.copyFileSync(path.join(__dirname,'../src/ui/lib/conversation-history.js'),moduleFile);
 const {renderConversationHistory} = await import(pathToFileURL(moduleFile));
 const users=[], blocks=[];
 const chat = {
   addUserMsg(text,images) {users.push({text,images});},
   addNotice() {},
   newAssistantBlock(label,options) {
     assert.equal(options.history,true);
     const item={text:[],tools:[],finish(){this.finished=true;},stopped(){this.interrupted=true;},
       addText(text,parent,phase){this.text.push({text,phase});},
       addTool(id,name){this.tools.push({id,name});},toolDone(id,error){this.tools.find(t=>t.id===id).error=error;}};
     blocks.push(item);return item;
   },
 };
 renderConversationHistory(chat,snapshot.messages);
 assert.equal(users.length,2);
 assert.equal(blocks.length,2,'commentary became separate assistant replies');
 assert.equal(blocks[0].text.filter(m=>m.phase==='commentary').length,14);
 assert.equal(blocks[0].text.at(-1).text,'الإجابة النهائية كاملة');
 assert.equal(blocks[0].tools[0].error,false);
 assert.equal(blocks[1].interrupted,true);
 assert.equal(users[0].images[0],png);
 // الضغط حدث تشغيلي؛ لا يستبدل الرسائل الأصلية.
 ok(store.acceptEvent(second.runId,{type:'system',subtype:'compact_summary',compact_summary:'ملخص لا يستبدل الحوار'}));
 assert.equal(ok(bridge.read(first.id,cwd)).conversation.messages.filter(m=>m.role==='user').length,2);
 // فشل حفظ المسودة بعد نجاح السجل لا يفقد النص الذي حُفظ سابقاً.
 const rename=fs.renameSync;
 fs.renameSync=(from,to)=>{if(String(to).endsWith('.draft.json')) throw Object.assign(new Error('fault_injected'),{code:'EIO'});return rename(from,to);};
 try { assert.equal(store.recordUser(second.runId,'توجيه محفوظ').ok,false); } finally { fs.renameSync=rename; }
 const faultSnapshot=ok(createBridge({store:createStore({root:disk})}).read(first.id,cwd)).conversation;
 assert(faultSnapshot.messages.some(m=>m.text==='نص قبل انقطاع العملية'),'committed stream lost between record and sidecar');
 ok(store.stop(second.runId));
 assert.equal(ok(bridge.read(first.id,cwd)).conversation.messages.filter(m=>m.text==='نص قبل انقطاع العملية').length,1,'draft duplicated on stop');
 // بيانات العرض لا تتسرب إلى سياق النقل ولا تتحول إلى سر من مدخلات أداة.
 const transfer = ok(store.prepare({cwd,engine:'sdk',conversationId:first.id,prompt:'تابع'}));
 assert(!transfer.context.includes('data:image/'));
 assert(!transfer.context.includes('do-not-archive-input'));
 ok(store.stop(transfer.runId));
 const restored = ok(await bridge.prepare({cwd,engine:'codex',sessionId:'native-first',prompt:'رسالة بعد إعادة الفتح'}));
 assert.equal(restored.snapshot.messages[0].images[0].dataUrl,png,'prepared snapshot lost an archived image');
 ok(store.stop(restored.runId));
 const messageId='11111111-1111-4111-8111-111111111111', sessionId='22222222-2222-4222-8222-222222222222';
 const legacyBridge=createBridge({store,readers:{sdk:async()=>({cwd,coverage:{complete:true},messages:Array.from({length:60},(_,i)=>({role:i%2?'assistant':'user',text:'قديم '+i,...(i%2?{}:{messageId,sessionId})}))})}});
 const imported=ok(await legacyBridge.openSession(cwd,'sdk',sessionId)).conversation;
 assert.equal(imported.messages.length,60,'legacy history truncated to forty');
 assert.equal(imported.messages[0].messageId,messageId,'SDK user identity lost during import');
 assert.equal(imported.messages[0].sessionId,sessionId);
 // نتيجة الأداة تبقى مرتبطة بكتلتها حتى إن وجّه المستخدم الدور في المنتصف.
 users.length=0;blocks.length=0;
 renderConversationHistory(chat,[
  {role:'user',text:'ابدأ',engine:'codex',runId:'steer'},
  {role:'tool_use',text:'',toolId:'steered-tool',name:'Read',engine:'codex',runId:'steer'},
  {role:'user',text:'صحح المسار',steer:true,engine:'codex',runId:'steer'},
  {role:'tool_result',text:'ok',toolId:'steered-tool',engine:'codex',runId:'steer'},
  {role:'assistant',text:'تم',engine:'codex',runId:'steer'},
 ]);
 assert.equal(blocks[0].tools[0].error,false,'steer lost the tool result');
 assert.equal(blocks.length,2,'tool result created an empty block');
 const large = ok(store.prepare({cwd,engine:'sdk',prompt:'صورة كبيرة',images:[{media_type:'image/png',data:'A'.repeat(9*1024*1024)}]}));
 assert.equal(ok(bridge.read(large.id,cwd)).conversation.messages[0].images[0].dataUrl.length,9*1024*1024+22,'accepted large image was lost');
 ok(store.stop(large.runId));
 const secret = ok(store.prepare({cwd,engine:'codex',prompt:'اختبار نص محجوب'}));
 ok(store.acceptEvent(secret.runId,{type:'stream_text',text:'sk-'+'a'.repeat(48)}));
 const hash=require('crypto').createHash('sha256').update(require('../electron/conversations').normalizeCwd(cwd)).digest('hex');
 const file=path.join(disk,hash,secret.id+'.json');
 const orphan=JSON.parse(fs.readFileSync(file,'utf8'));orphan.runs.at(-1).pid=2147483647;fs.writeFileSync(file,JSON.stringify(orphan));
 const afterCrash=createStore({root:disk});
 const rejected=afterCrash.prepare({cwd,conversationId:secret.id,engine:'sdk',prompt:'تابع'});
 assert.equal(rejected.error,'transfer_incomplete','draft lost its redaction coverage after crash');
 console.log('PASS history: phases, users, grouping, tools, images, durable stream, selection, catalog, compaction, context separation');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
 // الجذر ثابت من mkdtemp حصراً.
 fs.rmSync(root,{recursive:true,force:true});
});
