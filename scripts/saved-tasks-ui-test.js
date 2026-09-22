#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const harness = require('../electron/testspriteharness');

const TIMEOUT = 20000;
const watchdog = setTimeout(() => { console.error('saved-tasks-ui: timeout'); app.exit(1); }, 60000);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = async (win, code) => { try { return await win.webContents.executeJavaScript(code, true); } catch (error) { throw new Error('renderer step failed: ' + String(code).slice(0, 240) + '\\n' + (error && error.message || error)); } };
async function waitFor(win, expression, label) {
  const end = Date.now() + TIMEOUT;
  while (Date.now() < end) {
    if (await evaluate(win, 'Boolean(' + expression + ')')) return;
    await pause(30);
  }
  throw new Error('انتهت مهلة ' + label);
}

const fixture = String.raw`
(() => {
  const TASK = 'task_' + 'a'.repeat(32);
  const TASK_B = 'task_' + 'c'.repeat(32);
  const PROJECT = 'project_' + 'b'.repeat(64);
  const PROJECT_PATH = 'D:/مشروع-موثوق';
  const RUN_A = 'run_' + '1'.repeat(32);
  const RUN_B = 'run_' + '2'.repeat(32);
  const RUN_C = 'run_' + '3'.repeat(32);
  const state = {
    entitled: true, savedListener: null, permission: [], generalPermission: 0,
    updateConflict: false, calls: [], deleteCalls:[], prepareCalls:[], codexModelCalls:0, listCalls:0, emptyList:false, holdList:false, resolveList:null,
    delayedTask:null, resolveTaskGet:null, holdConfirm:false, resolveConfirm:null, pendingGet:null, resolvePending:null, task: {
      schema_version:1, task_id:TASK, project_id:PROJECT, revision:1, title:'مهمة عربية',
      instructions:'نفّذ التعليمات كما كُتبت.', engine:'codex', model:'gpt-5.6-sol', effort:'medium',
      criteria:[{criterion_id:'criterion_human',description:'يراجع المستخدم الناتج',verification_source:'human'}],
      archived:false, created_at:1, updated_at:1
    }
  };
  state.taskB={...state.task,task_id:TASK_B,title:'مهمة باء',revision:7};
  function run(id, stateName) {
    return {
      schema_version:1, run_id:id, project_id:PROJECT, task_id:TASK, revision:3, state:stateName,
      runtime_state:stateName, recovery_action:'none', started_at:10, ended_at:stateName==='finished'?20:null,
      definition_snapshot:state.task, criteria_results:stateName==='finished'
        ? [{criterion_id:'criterion_human',verdict:'needs_review',evidence_refs:[],reason:'بانتظار المراجعة البشرية.',verification_source:'human'}] : [],
      reviews:[]
    };
  }
  Object.assign(window.satr, {
    codexModels: async () => { state.codexModelCalls+=1; return []; },
    savedTasksAvailability: async () => ({ok:true,available:true,entitled:state.entitled,project:{project_id:PROJECT,path:PROJECT_PATH}}),
    savedTasksVerificationCatalog: async () => ({ok:true,config_fingerprint:'f'.repeat(64),checks:[{id:'lint',label:'فحص الشفرة',timeout_seconds:60}]}),
    savedTasksList: async () => { state.listCalls+=1; if(state.holdList)return new Promise((resolve)=>{state.resolveList=resolve;}); return {ok:true,items:state.emptyList?[]:[state.task],next_cursor:null}; },
    savedTasksGet: async ({task_id}) => { const task=task_id===TASK_B?state.taskB:state.task; if(state.delayedTask===task_id)return new Promise((resolve)=>{state.resolveTaskGet=()=>resolve({ok:true,task:{...task}});}); return {ok:true,task:{...task}}; },
    savedTasksCreate: async (definition) => { state.calls.push(['create',definition]); return {ok:true,task:{...state.task,...definition}}; },
    savedTasksUpdate: async (payload) => {
      state.calls.push(['update',payload]);
      if(state.updateConflict) return {ok:false,error:'revision_conflict'};
      state.task={...state.task,...payload.definition,revision:state.task.revision+1}; return {ok:true,task:{...state.task}};
    },
    savedTasksArchive: async () => ({ok:true,task:{...state.task,archived:true,revision:2}}),
    savedTasksPrepareStart: async (payload) => { state.prepareCalls.push(payload); return {ok:true,approval_token:'token',expires_at:Date.now()+60000,project:{project_id:PROJECT,path:PROJECT_PATH},task:{...state.task},
      verification_snapshot:{schema_version:1,fingerprint:'e'.repeat(64),expected_ids:[],checks:[]},
      execution:{permission_mode:'default',browser_control:'prompt_each_run',continuity:false,session_id:null}}; },
    savedTasksConfirmStart: async () => { if(state.holdConfirm)return new Promise((resolve)=>{state.resolveConfirm=()=>resolve({ok:true,run:run(RUN_C,'running')});}); return {ok:true,run:run(RUN_A,'running')}; },
    savedTasksPermission: async (payload) => { state.permission.push(payload); return state.permission.length===1?{ok:true}:{ok:false,error:'not_pending'}; },
    savedTasksAnswerQuestion: async () => ({ok:true}),
    savedTasksHandoffDone: async () => ({ok:true}),
    savedTasksStop: async () => ({ok:true,status:'stop_requested'}),
    savedTasksRetryFinish: async () => ({ok:true}),
    savedTaskRunsList: async () => ({ok:true,items:[run(RUN_A,'finished')],next_cursor:null}),
    savedTaskRunsGet: async () => { if(state.pendingGet)return new Promise((resolve)=>{state.resolvePending=resolve;}); return {ok:true,run:run(RUN_A,'finished')}; },
    savedTaskRunsReadReport: async () => ({ok:true,report:state.report||{schema_version:1,source:'codex',project_id:PROJECT,task_id:TASK,run_id:RUN_A,
      captured_at:30,session_id:null,redacted:false,truncated:true,events:[{type:'assistant',text:'تقرير عربي آمن'}]}}),
    savedTaskRunsReview: async ({decision}) => ({ok:true,run:{...run(RUN_A,'finished'),revision:4,reviews:[{run_id:RUN_A,revision:4,decision,decided_at:40,source:'user'}]}}),
    savedTaskRunsDelete: async (payload) => { state.deleteCalls.push(payload); return {ok:true}; },
    onSavedTaskEvent: (callback) => { state.savedListener=callback; return () => {state.savedListener=null;}; },
    permission: async () => { state.generalPermission += 1; return {ok:true}; }
  });
  window.__savedFixture = {
    state, TASK, TASK_B, PROJECT, PROJECT_PATH, RUN_A, RUN_B, RUN_C, run,
    emit(owner,event){ state.savedListener({owner,event}); }
  };
})();
`;

function createServer() {
  const server = harness.createHarnessServer();
  const original = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    if (req.url === '/__testsprite__/mock-satr.js') {
      const body = harness.harnessClient() + '\n' + fixture;
      res.writeHead(200, {'Content-Type':'text/javascript; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store'});
      res.end(body);
    } else original(req,res);
  });
  return server;
}

async function main() {
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,harness.HOST,resolve);});
  await app.whenReady();
  const errors=[];
  const win=new BrowserWindow({show:false,width:1280,height:850,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false,partition:'saved-tasks-'+Date.now()}});
  win.webContents.on('console-message',(_e,_l,message)=>{if(/uncaught|unhandled|syntaxerror/i.test(String(message)))errors.push(String(message));});
  try {
    await win.loadURL('http://'+harness.HOST+':'+server.address().port+'/');
    await waitFor(win,"customElements.get('satr-saved-tasks-panel') && customElements.get('satr-chat') && !document.getElementById('savedTasksToggle').hidden && window.__savedFixture.state.savedListener",'إقلاع سطح المهام');
    await evaluate(win,"window.__savedFixture.state.emptyList=true;document.getElementById('savedTasksToggle').click()");
    await waitFor(win,"document.querySelector('satr-saved-tasks-panel').hasAttribute('open') && document.querySelector('satr-saved-tasks-panel').shadowRoot.querySelector('.task-list .empty')",'فتح مخزن فارغ من الزر الحقيقي');
    const firstCreate=await evaluate(win,`(async()=>{const p=document.querySelector('satr-saved-tasks-panel'),s=__savedFixture.state,r=p.shadowRoot;
      r.querySelector('.new').click();const initial=!r.querySelector('.save').disabled,model=r.querySelector('.model').value,effort=r.querySelector('.effort').value,effortLabel=r.querySelector('.effort').selectedOptions[0].textContent,engine=document.getElementById('engine').value;
      p._fillModels('removed-model','medium');const unavailable=r.querySelector('.save').disabled;p._fillModels('gpt-5.6-sol','medium');const restored=!r.querySelector('.save').disabled&&r.querySelector('.model').value==='gpt-5.6-sol'&&r.querySelector('.effort').value==='medium';
      s.delayedTask=__savedFixture.TASK;const stale=p._selectTask(__savedFixture.TASK);while(!s.resolveTaskGet)await new Promise(x=>setTimeout(x,5));p._newTask();s.resolveTaskGet();await stale;
      const stayedNew=p._task===null&&r.querySelector('.title').value==='';s.delayedTask=null;s.resolveTaskGet=null;return {initial,unavailable,restored,stayedNew,model,effort,effortLabel,engine,codexCalls:s.codexModelCalls};})()`);
    assert.equal(firstCreate.engine,'sdk','فتح المهام بدّل المحرك الحالي');assert.equal(firstCreate.initial&&firstCreate.unavailable&&firstCreate.restored&&firstCreate.stayedNew,true,JSON.stringify(firstCreate));
    assert.equal(firstCreate.model,'gpt-5.6-sol');assert(firstCreate.effort,'لم يعلن adapter جهد fallback');assert.notEqual(firstCreate.effortLabel,firstCreate.effort,'اسم الجهد بقي خاماً');assert(firstCreate.codexCalls>0,'لم تُجلب قائمة Codex عند كون المحرك SDK');
    await evaluate(win,"window.__savedFixture.state.emptyList=false;document.querySelector('satr-saved-tasks-panel').shadowRoot.querySelector('.refresh').click()");
    await waitFor(win,"document.querySelector('satr-saved-tasks-panel').shadowRoot.querySelector('.task')",'تحديث القائمة بعد الإنشاء الأول');
    const trustedProject=await evaluate(win,`(() => {const p=document.querySelector('satr-saved-tasks-panel'),cwd=document.getElementById('cwd'),r=p.shadowRoot;const path=r.querySelector('.project-label .project-path'),old=cwd.value;
      const direction=path&&path.getAttribute('dir'),label=r.querySelector('.project-label').textContent;r.querySelector('.approval').hidden=false;cwd.value='D:/مسار-مكتوب-مزور';cwd.dispatchEvent(new Event('input',{bubbles:true}));const invalidated=!p.hasAttribute('open')&&r.querySelector('.approval').hidden;cwd.value=old;return {label,direction,invalidated};})()`);
    assert.match(trustedProject.label,/D:\/مشروع-موثوق/);assert.equal(trustedProject.direction,'ltr');assert.equal(trustedProject.invalidated,true,'تغير cwd لم يبطل اللوحة/الموافقة');
    await evaluate(win,"document.getElementById('savedTasksToggle').click()");
    await waitFor(win,"document.querySelector('satr-saved-tasks-panel').hasAttribute('open') && document.querySelector('satr-saved-tasks-panel').shadowRoot.querySelector('.task')",'إعادة فتح المشروع الموثوق');
    await evaluate(win,`(() => {
      const p=document.querySelector('satr-saved-tasks-panel'), r=p.shadowRoot;
      r.querySelector('.task').click();
    })()`);
    await waitFor(win,"!document.querySelector('satr-saved-tasks-panel').shadowRoot.querySelector('.editor').hidden",'تحميل المهمة');
    const savedChoice=await evaluate(win,`(() => {const r=document.querySelector('satr-saved-tasks-panel').shadowRoot;return {model:r.querySelector('.model').value,effort:r.querySelector('.effort').value,save:r.querySelector('.save').disabled};})()`);
    assert.deepEqual(savedChoice,{model:'gpt-5.6-sol',effort:'medium',save:false},'غيّر adapter النموذج/الجهد المحفوظين أو عطّل الحفظ');

    const draft = await evaluate(win,`(async()=>{const p=document.querySelector('satr-saved-tasks-panel'),r=p.shadowRoot;
      r.querySelector('.title').value='مسودة لا تضيع'; window.__savedFixture.state.updateConflict=true;
      r.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      await new Promise(x=>setTimeout(x,60)); return {value:r.querySelector('.title').value,message:r.querySelector('.message').textContent};})()`);
    assert.equal(draft.value,'مسودة لا تضيع','تعارض revision أسقط المسودة المحلية');
    assert.match(draft.message,/تغيّرت النسخة/);
    const staleSelection=await evaluate(win,`(async()=>{const p=document.querySelector('satr-saved-tasks-panel'),s=__savedFixture.state;
      s.updateConflict=false;s.delayedTask=__savedFixture.TASK;const stale=p._selectTask(__savedFixture.TASK);
      while(!s.resolveTaskGet)await new Promise(x=>setTimeout(x,5));await p._selectTask(__savedFixture.TASK_B);s.resolveTaskGet();await stale;
      const selected=p._task.task_id;s.delayedTask=null;s.resolveTaskGet=null;await p._selectTask(__savedFixture.TASK);return selected;})()`);
    assert.equal(staleSelection,await evaluate(win,'__savedFixture.TASK_B'),'استجابة اختيار A المتأخرة طمست المهمة B');

    const pageRace=await evaluate(win,`(async()=>{const p=document.querySelector('satr-saved-tasks-panel'),s=__savedFixture.state,before=s.listCalls;
      p._taskCursor='next';s.holdList=true;const first=p._loadTasks(false),second=p._loadTasks(false);
      while(!s.resolveList)await new Promise(x=>setTimeout(x,5));const during=s.listCalls-before;s.resolveList({ok:true,items:[],next_cursor:null});await Promise.all([first,second]);s.holdList=false;s.resolveList=null;return during;})()`);
    assert.equal(pageRace,1,'النقر المزدوج على المزيد أطلق طلبي صفحات متنافسين');

    const lateConfirm=await evaluate(win,`(async()=>{const p=document.querySelector('satr-saved-tasks-panel'),s=__savedFixture.state,f=__savedFixture;
      s.holdConfirm=true;await p._prepare();const projectDir=p.shadowRoot.querySelector('.approval .project-path').getAttribute('dir'),settings=p.shadowRoot.querySelector('.approval .setting-line').textContent,modelDir=p.shadowRoot.querySelector('.approval .setting-model').getAttribute('dir');p.shadowRoot.querySelector('.approval .primary').click();while(!s.resolveConfirm)await new Promise(x=>setTimeout(x,5));
      const owner={project_id:f.PROJECT,task_id:f.TASK,run_id:f.RUN_C};f.emit(owner,{type:'saved_task_started',run:f.run(f.RUN_C,'running')});f.emit(owner,{type:'saved_task_finished',run:f.run(f.RUN_C,'finished')});
      s.resolveConfirm();await new Promise(x=>setTimeout(x,30));s.holdConfirm=false;s.resolveConfirm=null;const entry=p._runs.get(f.RUN_C);return {state:entry.state.textContent,done:entry.block.done,projectDir,modelDir,settings};})()`);
    assert.match(lateConfirm.state,/انتهى التنفيذ/,'استجابة confirm المتأخرة أعادت محاولة منتهية إلى جارية');assert.equal(lateConfirm.done,true);assert.equal(lateConfirm.projectDir,'ltr');assert.equal(lateConfirm.modelDir,'ltr');assert.match(lateConfirm.settings,/الجهد: متوسط/);
    assert.deepEqual(await evaluate(win,'__savedFixture.state.prepareCalls[0]'),{task_id:await evaluate(win,'__savedFixture.TASK'),revision:1},'prepare سرّب path غير الموثوق إلى المضيف');

    const ownerA=await evaluate(win,'({project_id:__savedFixture.PROJECT,task_id:__savedFixture.TASK,run_id:__savedFixture.RUN_A})');
    const ownerB=await evaluate(win,'({project_id:__savedFixture.PROJECT,task_id:__savedFixture.TASK,run_id:__savedFixture.RUN_B})');
    await evaluate(win,`(() => {
      const f=__savedFixture, a={project_id:f.PROJECT,task_id:f.TASK,run_id:f.RUN_A}, b={project_id:f.PROJECT,task_id:f.TASK,run_id:f.RUN_B};
      f.emit(a,{type:'saved_task_started',run:f.run(f.RUN_A,'running')});
      f.emit(b,{type:'saved_task_started',run:f.run(f.RUN_B,'running')});
      f.emit(a,{type:'assistant',message:{content:[{type:'text',text:'نص المحاولة أ'}]}});
      f.emit(a,{type:'file_edit',id:'edit_a',rel:'src/a.js',added:1,removed:0,lines:[{type:'add',text:'+const a = 1;'}]});
      f.emit(a,{type:'system',subtype:'compact_boundary',compact_metadata:{pre_tokens:100,post_tokens:50}});
      f.emit(a,{type:'desktop_activity',text:'نقر زر الاختبار',stamp:'10:30'});
      f.emit(a,{type:'screenshot',dataUrl:'data:image/png;base64,iVBORw0KGgo=',kind:'element'});
      f.emit(a,{type:'saved_task_finished',run:f.run(f.RUN_A,'finished')});
      f.emit(b,{type:'assistant',message:{content:[{type:'text',text:'نص المحاولة ب'}]}});
    })()`);
    const isolated=await evaluate(win,`(() => {try {const p=document.querySelector('satr-saved-tasks-panel');
      const a=p._runs.get(__savedFixture.RUN_A),b=p._runs.get(__savedFixture.RUN_B);
      const main=document.querySelector('satr-chat');
      return {hasA:!!a,hasB:!!b,aRoot:!!(a&&a.transcript.querySelector('.msg.assistant')),bRoot:!!(b&&b.transcript.querySelector('.msg.assistant')),
        a:a?a.transcript.textContent:'',b:b?b.transcript.textContent:'',noUndo:a?!!a.transcript.querySelector('.diff-undo[hidden]'):false,hasDesktop:a?!!a.transcript.querySelector('.desktop-line'):false,hasCompact:a?!!a.transcript.querySelector('.compact-card'):false,hasShot:a?!!a.transcript.querySelector('.browser-shot'):false,
        bState:b&&b.state.textContent,mainCount:main.querySelectorAll('.msg.assistant').length};}catch(error){return {evalError:error.stack||String(error)};}})()`);
    assert.equal(isolated.evalError,undefined,JSON.stringify(isolated));
    assert.equal(isolated.hasA&&isolated.hasB&&isolated.aRoot&&isolated.bRoot,true,JSON.stringify(isolated));
    assert.match(isolated.a,/نص المحاولة أ/); assert.match(isolated.b,/نص المحاولة ب/);
    assert.equal(isolated.noUndo&&isolated.hasDesktop&&isolated.hasCompact&&isolated.hasShot,true,'المصيّر لم يعرض diff بلا تراجع أو نشاط السطح أو الضغط');
    assert.match(isolated.bState,/جارية/,'اكتمال A المتأخر مسّ B');
    assert.equal(isolated.mainCount,0,'أحداث المهمة دخلت خيط currentBlock العام');

    await evaluate(win,`(() => {const f=__savedFixture,a={project_id:f.PROJECT,task_id:f.TASK,run_id:f.RUN_B};
      f.emit(a,{type:'permission_request',id:'perm_b',tool:'Bash',detail:'npm test'});
    })()`);
    await waitFor(win,"document.querySelector('satr-perm-dialog').hasAttribute('open')",'ظهور إذن المهمة');
    await evaluate(win,"window.__SATR_TESTSPRITE_HARNESS__.emitEvent({type:'mobile_decision',decision:'deny'})");
    assert.equal(await evaluate(win,"document.querySelector('satr-perm-dialog').hasAttribute('open')"),true,'تنظيف محادثة عام سحب إذن المهمة المملوك');
    await evaluate(win,`(() => {const f=__savedFixture,a={project_id:f.PROJECT,task_id:f.TASK,run_id:f.RUN_A};
      f.emit(a,{type:'saved_task_finished',run:f.run(f.RUN_A,'finished')});
    })()`);
    assert.equal(await evaluate(win,"document.querySelector('satr-perm-dialog').hasAttribute('open')"),true,'نهاية A المتأخرة سحبت إذن B');
    await evaluate(win,"document.querySelector('satr-perm-dialog').shadowRoot.querySelector('.allow').click()");
    await waitFor(win,"window.__savedFixture.state.permission.length===1",'حسم الإذن');
    const permission=await evaluate(win,'({saved:__savedFixture.state.permission,general:__savedFixture.state.generalPermission})');
    assert.equal(permission.saved[0].run_id,ownerB.run_id); assert.equal(permission.saved[0].id,'perm_b');
    assert.equal(permission.general,0,'responder المهمة تسرب إلى إذن المحادثة العامة');
    await evaluate(win,`(() => {const f=__savedFixture,b={project_id:f.PROJECT,task_id:f.TASK,run_id:f.RUN_B};f.emit(b,{type:'handoff_request',id:'hand_b',reason:'أكمل الخطوة',mode:'step'});})()`);
    await waitFor(win,"document.querySelector('satr-preview-panel').shadowRoot.querySelector('#pvHandoff').classList.contains('show')",'ظهور تسليم المهمة');
    await evaluate(win,"window.__SATR_TESTSPRITE_HARNESS__.emitEvent({type:'handoff_end'})");
    assert.equal(await evaluate(win,"document.querySelector('satr-preview-panel').shadowRoot.querySelector('#pvHandoff').classList.contains('show')"),true,'handoff_end عام سحب تسليم المهمة المملوك');
    await evaluate(win,`(() => {const f=__savedFixture,b={project_id:f.PROJECT,task_id:f.TASK,run_id:f.RUN_B};f.emit(b,{type:'handoff_end'});})()`);
    assert.equal(await evaluate(win,"document.querySelector('satr-preview-panel').shadowRoot.querySelector('#pvHandoff').classList.contains('show')"),false);
    await evaluate(win,`(() => {const f=__savedFixture,b={project_id:f.PROJECT,task_id:f.TASK,run_id:f.RUN_B};
      f.emit(b,{type:'permission_request',id:'perm_b',tool:'Bash',detail:'npm test'});
    })()`);
    await pause(40);
    assert.equal(await evaluate(win,"document.querySelector('satr-perm-dialog').hasAttribute('open')"),false,'إعادة بث control مستهلك أعادت فتح الحوار');
    const responderReset=await evaluate(win,`(async()=>{const d=document.querySelector('satr-perm-dialog');window.__newPermission=0;
      d.request({id:'old',tool:'Bash',detail:'old',respond:()=>new Promise(resolve=>{window.__resolveOld=resolve;})});d.shadowRoot.querySelector('.allow').click();
      await new Promise(x=>setTimeout(x,10));d.closeAll();d.request({id:'new',tool:'Read',detail:'new',respond:async()=>{window.__newPermission+=1;return {ok:true};}});
      window.__resolveOld({ok:true});await new Promise(x=>setTimeout(x,10));const enabled=!d.shadowRoot.querySelector('.allow').disabled;const open=d.hasAttribute('open');d.shadowRoot.querySelector('.allow').click();
      await new Promise(x=>setTimeout(x,20));return {enabled,open,newCalls:window.__newPermission,closed:!d.hasAttribute('open')};})()`);
    assert.deepEqual(responderReset,{enabled:true,open:true,newCalls:1,closed:true},'رد إذن قديم عطّل الطلب التالي أو أغلقه');
    await evaluate(win,`document.querySelector('satr-perm-dialog').request({id:'general',tool:'Read',detail:'file'})`);
    await waitFor(win,"document.querySelector('satr-perm-dialog').hasAttribute('open')",'إذن المحادثة الافتراضي');
    await evaluate(win,"document.querySelector('satr-perm-dialog').shadowRoot.querySelector('.allow').click()");
    await waitFor(win,"window.__savedFixture.state.generalPermission===1",'responder المحادثة الافتراضي');

    const previewOwner = await evaluate(win,`(() => {const p=document.querySelector('satr-preview-panel');window.__savedPreview=[];p.openWith=(url,opts)=>__savedPreview.push({url,opts});
      const f=__savedFixture,b={project_id:f.PROJECT,task_id:f.TASK,run_id:f.RUN_B};
      f.emit(b,{type:'preview_open',url:'http://127.0.0.1:4173/result'});return __savedPreview;})()`);
    assert.equal(previewOwner.length,1); assert.equal(previewOwner[0].opts.agent,true);
    const pendingRace=await evaluate(win,`(async()=>{const p=document.querySelector('satr-saved-tasks-panel'),s=__savedFixture.state,f=__savedFixture;
      const owner={project_id:f.PROJECT,task_id:f.TASK,run_id:f.RUN_B};s.pendingGet=true;f.emit(owner,{type:'saved_task_storage_pending',error:'storage_pending'});
      while(!s.resolvePending)await new Promise(x=>setTimeout(x,5));f.emit(owner,{type:'saved_task_finished',run:f.run(f.RUN_B,'finished')});
      s.resolvePending({ok:true,run:{...f.run(f.RUN_B,'finished'),recovery_action:'retry_finish'}});await new Promise(x=>setTimeout(x,30));s.pendingGet=false;s.resolvePending=null;
      const entry=p._runs.get(f.RUN_B);return {state:entry.state.textContent,retry:!!entry.card.querySelector('.retry-finish'),done:entry.block.done};})()`);
    assert.match(pendingRace.state,/انتهى التنفيذ/);assert.equal(pendingRace.retry,false,'getRun المتأخر أعاد retry بعد نهاية المحاولة');assert.equal(pendingRace.done,true);

    const evidenceDirection=await evaluate(win,`(async()=>{const p=document.querySelector('satr-saved-tasks-panel'),f=__savedFixture,target=p.shadowRoot.querySelector('.run-detail');await p._showRun(f.RUN_A);
      let evidence=target.querySelector('.check > div:last-child');const empty={className:evidence.className,dir:evidence.getAttribute('dir'),direction:getComputedStyle(evidence).direction,text:evidence.textContent};
      const referenced={...f.run(f.RUN_A,'finished'),criteria_results:[{criterion_id:'criterion_human',verdict:'needs_review',evidence_refs:['src/check.js:7'],reason:'بانتظار المراجعة البشرية.',verification_source:'human'}]};p._renderRun(referenced,target);evidence=target.querySelector('.check > div:last-child');const full={className:evidence.className,direction:getComputedStyle(evidence).direction,text:evidence.textContent};await p._showRun(f.RUN_A);return {empty,full};})()`);
    assert.deepEqual(evidenceDirection.empty,{className:'meta',dir:'rtl',direction:'rtl',text:'لا دليل محفوظ'},'الدليل الفارغ لم يرسُ RTL بخط النص العربي');
    assert.deepEqual(evidenceDirection.full,{className:'meta tech',direction:'ltr',text:'src/check.js:7'},'مرجع الدليل التقني لم يبقَ LTR');
    await evaluate(win,`(async()=>{const p=document.querySelector('satr-saved-tasks-panel');await p._showRun(__savedFixture.RUN_A);
      p.shadowRoot.querySelector('.run-detail .run-card > button:last-child').click();await new Promise(x=>setTimeout(x,40));})()`);
    const report=await evaluate(win,"document.querySelector('satr-saved-tasks-panel').shadowRoot.querySelector('.report').textContent");
    assert.match(report,/التقرير مقتطع/); assert.match(report,/تقرير عربي آمن/);
    const reportCases=await evaluate(win,`(async()=>{const p=document.querySelector('satr-saved-tasks-panel'),s=__savedFixture.state,card=p.shadowRoot.querySelector('.run-detail .run-card');
      const read=async(events,meta={})=>{s.report={schema_version:1,source:'codex',project_id:__savedFixture.PROJECT,task_id:__savedFixture.TASK,run_id:__savedFixture.RUN_A,captured_at:31,session_id:'session-kept',redacted:!!meta.redacted,truncated:!!meta.truncated,events};await p._readReport(__savedFixture.RUN_A,card);const report=card.querySelector('.report');return {rows:[...report.querySelectorAll('.report-event')].map(x=>x.textContent),meta:report.querySelector('.meta').textContent};};
      return {
        replaced:await read([{type:'stream_text',phase:'final_answer',text:'نص نهائي واحد'},{type:'assistant',message:{content:[{type:'text',phase:'final_answer',text:'نص نهائي واحد'}]}}]),
        deltas:await read([{type:'stream_text',phase:'final_answer',text:'نص '},{type:'stream_text',phase:'final_answer',text:'مجزأ'},{type:'assistant',message:{content:[{type:'text',phase:'final_answer',text:'نص مجزأ'}]}}]),
        incomplete:await read([{type:'stream_text',phase:'final_answer',text:'بث غير '},{type:'stderr',text:'تنبيه بيني'},{type:'stream_text',phase:'final_answer',text:'مكتمل'},{type:'result',is_error:true}],{truncated:true}),
        redacted:await read([],{redacted:true}),
        phases:await read([{type:'stream_text',phase:'commentary',text:'سرد باق'},{type:'stream_text',phase:'final_answer',text:'جواب مبثوث'},{type:'assistant',message:{content:[{type:'text',phase:'final_answer',text:'جواب نهائي'}]}}]),
        repeated:await read([{type:'assistant',message:{content:[{type:'text',phase:'final_answer',text:'تكرار مقصود'}]}},{type:'assistant',message:{content:[{type:'text',phase:'final_answer',text:'تكرار مقصود'}]}}]),
        cycles:await read([{type:'stream_text',phase:'final_answer',text:'دورة'},{type:'assistant',message:{content:[{type:'text',phase:'final_answer',text:'دورة'}]}},{type:'stream_text',phase:'final_answer',text:'دورة'},{type:'assistant',message:{content:[{type:'text',phase:'final_answer',text:'دورة'}]}}])
      };})()`);
    assert.deepEqual(reportCases.replaced.rows,['نص نهائي واحد'],'البث والنص النهائي ظهرا مرتين');
    assert.deepEqual(reportCases.deltas.rows,['نص مجزأ'],'لم تُجمع deltas قبل استبدالها بالنص النهائي');
    assert.deepEqual(reportCases.incomplete.rows,['بث غير مكتمل','تنبيه بيني','انتهى المحرك بخطأ.'],'ضاع بث غير مكتمل أو اختل ترتيب stderr/result');
    assert.match(reportCases.incomplete.meta,/التقرير مقتطع/);
    assert.deepEqual(reportCases.redacted.rows,[]);assert.match(reportCases.redacted.meta,/حُجب التقرير/);
    assert.deepEqual(reportCases.phases.rows,['سرد باق','جواب نهائي'],'نص مرحلة أخرى سقط مع استبدال الإجابة النهائية');
    assert.deepEqual(reportCases.repeated.rows,['تكرار مقصود','تكرار مقصود'],'أزيل تكرار حقيقي بين رسالتين مستقلتين');
    assert.deepEqual(reportCases.cycles.rows,['دورة','دورة'],'لم تُمسح دورة pending بعد النص النهائي');
    const failureReason=await evaluate(win,`(async()=>{const p=document.querySelector('satr-saved-tasks-panel'),f=__savedFixture;
      p._renderRun({...f.run(f.RUN_A,'failed'),technical_reason:'انقطع الاتصال بالمحرك.'},p.shadowRoot.querySelector('.run-detail'));
      const text=p.shadowRoot.querySelector('.run-detail').textContent;await p._showRun(f.RUN_A);return text;})()`);
    assert.match(failureReason,/سبب الفشل: انقطع الاتصال بالمحرك/);
    const deleted=await evaluate(win,`(async()=>{const p=document.querySelector('satr-saved-tasks-panel'),s=__savedFixture.state;
      p._options.confirm=async()=>true;const button=[...p.shadowRoot.querySelectorAll('.run-detail button.danger')].find(x=>x.textContent.includes('حذف'));
      button.click();for(let i=0;i<50&&!s.deleteCalls.length;i++)await new Promise(x=>setTimeout(x,5));await new Promise(x=>setTimeout(x,30));
      return {payload:s.deleteCalls[0],detail:p.shadowRoot.querySelector('.run-detail').textContent,live:p._runs.has(__savedFixture.RUN_A)};})()`);
    assert.deepEqual(deleted.payload,{run_id:ownerA.run_id,revision:3,confirmed:true});assert.equal(deleted.live,false,'نجاح الحذف أبقى بطاقة المحاولة الحية');

    await evaluate(win,`(async()=>{const p=document.querySelector('satr-saved-tasks-panel');__savedFixture.state.entitled=false;await p.open({models:[{value:'gpt-5.6-sol',label:'Sol',efforts:['medium']}]});p.shadowRoot.querySelector('.task').click();await new Promise(x=>setTimeout(x,40));})()`);
    const expired=await evaluate(win,`(() => {const r=document.querySelector('satr-saved-tasks-panel').shadowRoot;
      return {save:r.querySelector('.save').disabled,run:r.querySelector('.run').disabled,readText:r.querySelector('.entitlement').textContent,history:r.querySelectorAll('.history-item').length};})()`);
    assert.equal(expired.save,true); assert.equal(expired.run,true); assert.match(expired.readText,/القراءة/); assert(expired.history>0,'انتهاء الترخيص أخفى التاريخ');
    assert.deepEqual(errors,[]);
    console.log('saved-tasks-ui: ownership, async races, isolated transcript, delete, report, and expired read passed');
  } finally {
    if(!win.isDestroyed())win.destroy();
    await new Promise((resolve)=>server.close(resolve));
    clearTimeout(watchdog); app.quit();
  }
}
main().catch((error)=>{console.error(error&&error.stack||error);clearTimeout(watchdog);app.exit(1);});