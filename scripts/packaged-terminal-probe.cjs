'use strict';
const fs = require('fs'), path = require('path'), assert = require('node:assert/strict');
const { spawn } = require('child_process');
// مسبار حزمة ويندوز: عزل البيئة وملف المستخدم دون إيقاف العملية الرئيسية بالمصحح.
const root = path.resolve(__dirname, '..');
const core = require(path.join(root, 'scripts/lib/live-test-run'));
const run = core.prepareRun(root, {});
const exe = path.resolve(process.argv[2] || path.join(root, 'dist/gate-recovery-build/win-unpacked/Satr.exe'));
assert(exe.startsWith(path.join(root, 'dist') + path.sep), 'build_must_be_under_dist');
const out = run.paths.root;
const closeMode = process.argv[3] || 'exit';
assert(['exit','kill'].includes(closeMode), 'bad_close_mode');
const stages = [];
function stage(name) { stages.push({name,time:new Date().toISOString()}); save('stages.json', {closeMode,stages}); console.log('STAGE '+name); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2), 'utf8');
async function waitFor(fn, label) {
 const until = Date.now() + 30000;
 while (Date.now() < until) { const value = await fn(); if (value) return value; await delay(100); }
 throw Error('timeout_' + label);
}
function connect(url) {
 return new Promise((resolve, reject) => {
  const ws = new WebSocket(url), pending = new Map(); let next = 0;
  const opening=setTimeout(()=>{ws.close();reject(Error('debug_open_timeout'));},10000);
  const send = (method, params = {}) => new Promise((yes, no) => {
   const id = ++next, timer = setTimeout(() => { pending.delete(id); no(Error('debug_timeout')); }, 10000);
   pending.set(id, { yes, no, timer, method }); ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onopen = () => {clearTimeout(opening);resolve({ send, close: () => ws.close() });};
  ws.onerror = () => {clearTimeout(opening);reject(Error('debug_connection_failed'));};
  ws.onclose = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.no(Error('debug_closed')); } pending.clear(); };
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) {
   const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer);
   m.error ? p.no(Error(p.method + ': ' + m.error.message)) : p.yes(m.result);
  } };
 });
}
let child, client, deadline, exited = false;
(async () => {
 assert(fs.existsSync(exe));
 assert(!fs.existsSync(path.join(out, 'package-state.json')), 'fresh_run_required');
 const archive = path.join(path.dirname(exe), 'resources/app.asar');
 const files = ['electron/main.js','electron/conversations.js','electron/term.js','electron/preload.js','src/ui/app.js','src/ui/components/gate.js','src/ui/components/terminal-panel.js'];
 const hashes = files.map(file => {
  const bytes = require('@electron/asar').extractFile(archive, path.normalize(file));
  assert(bytes.equals(fs.readFileSync(path.join(root,file))), 'source_package_mismatch:'+file);
  return {file,sha256:require('crypto').createHash('sha256').update(bytes).digest('hex')};
 });
 save('verified-files.json', hashes);
 const env = core.buildChildEnv(process.env, run);
 let stderr = '';
 child = spawn(exe, ['--user-data-dir='+run.paths.profile, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], {
  cwd: run.paths.workspace, env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe']
 });
 child.stdout.resume(); deadline=setTimeout(()=>{process.exitCode=1;save('deadline.json',{pid:child.pid});child.kill();},120000);
 child.stderr.on('data', b => { if (stderr.length < 16000) stderr += b.toString(); });
 child.on('error', () => { console.error('PACKAGE_PROCESS_ERROR'); process.exitCode = 1; });
 child.on('exit', code => {
  exited = true; clearTimeout(deadline); if (client) client.close();
  save('package-exit.json', { pid: child.pid, code, time: new Date().toISOString() });
  console.log('PACKAGE_EXIT ' + code); process.exitCode = process.exitCode || code || 0;
 });
 const portFile = path.join(run.paths.profile, 'DevToolsActivePort');
 await waitFor(() => fs.existsSync(portFile), 'renderer');
 const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
 const target = await waitFor(async () => {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list',{signal:AbortSignal.timeout(2500)})).json();
  return list.find(t => t.type === 'page' && t.url.startsWith('file:') && t.url.includes('/resources/app.asar/src/index.html'));
 }, 'main_page');
 client = await connect(target.webSocketDebuggerUrl);
 await waitFor(async () => {
  try {
   const probe = await client.send('Runtime.evaluate', { expression: 'document.readyState === "complete" && typeof window.satr?.permissionMetrics === "function"', returnByValue: true });
   return probe.result?.value === true;
  } catch { return false; }
 }, 'preload_ready');

 async function evaluate(expression) {
  const r=await client.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  assert(!r.exceptionDetails, r.exceptionDetails?.text || 'evaluation_failed');return r.result.value;
 }
 await waitFor(async()=>{try{return await evaluate('!!document.querySelector("satr-gate")?._btn && !document.querySelector("satr-gate")._btn.disabled');}catch{return false;}},'gate_settled');
 save('package-state.json',{id:run.id,mode:'packaged',exe,pid:child.pid,port,targetId:target.id,profile:run.paths.profile,workspace:run.paths.workspace,isolation:'home-profile-environment',osSandbox:false,engineRequests:0});
 const before=await evaluate('({visible:!document.querySelector("satr-gate").hidden,unavailable:document.querySelector("satr-gate").engineUnavailable("sdk")})');
 assert(before.visible && before.unavailable, 'expected_clean_logged_out_profile');
 await evaluate('document.querySelector("satr-gate").shadowRoot.querySelector(".defer").click(); true');
 assert(await evaluate('document.querySelector("satr-gate").hidden'),'dismiss_failed');
 await evaluate('document.getElementById("cwd").value='+JSON.stringify(run.paths.workspace)+';document.getElementById("cwd").dispatchEvent(new Event("change"));true');
 await evaluate('document.getElementById("termToggle").click(); true');
 await waitFor(()=>evaluate('document.getElementById("termToggle").classList.contains("active")'),'terminal_open');
 await waitFor(async()=> (await evaluate('window.satr.termList()')).length===1,'first_terminal');
 await delay(1200);
 await evaluate('document.getElementById("termNew").click(); true');
 await waitFor(async()=> (await evaluate('window.satr.termList()')).length===2,'second_terminal');
 const terms = await evaluate('window.satr.termList()');
 for (let index=0; index<terms.length; index++) {
  assert.equal(path.resolve(terms[index].cwd), run.paths.workspace, 'terminal_cwd_not_isolated');
  const id=JSON.stringify(terms[index].id), marker='SATR_PTY_READY_'+index;
  const command="Write-Output ('SATR_' + 'PTY_READY_"+index+"')\r";
  assert((await evaluate('window.satr.termInput('+id+','+JSON.stringify(command)+')')).ok);
  await waitFor(()=>evaluate('window.satr.termReadBuffer('+id+',4096).then(r=>r.ok && r.data.includes('+JSON.stringify(marker)+'))'), 'terminal_output_'+index);
 }

 assert(await evaluate('document.readyState === "complete"'),'renderer_unresponsive');
 save('two-terminals.json',{creationAndOutput:true,cleanup:'pending',scope:'packaged',engineRequests:0,time:new Date().toISOString()});
 console.log('TERMINAL_OUTPUT_PASS '+run.id);
 for (let index=0; index<terms.length; index++) {
  const id=JSON.stringify(terms[index].id);
  stage(closeMode+'_request_'+index);
  const result = await evaluate(closeMode==='exit'
   ? 'window.satr.termInput('+id+','+JSON.stringify('exit\r')+')'
   : 'window.satr.termKill('+id+')');
  assert(result.ok, 'close_request_rejected');
  stage(closeMode+'_ack_'+index);
  await waitFor(async()=> !(await evaluate('window.satr.termList()')).some(t=>t.id===terms[index].id), 'terminal_cleanup_'+index);
  stage(closeMode+'_removed_'+index);
  await delay(2000);
  assert(await evaluate('document.readyState === "complete"'),'renderer_unresponsive_after_close');
  stage(closeMode+'_responsive_'+index);
 }
 stage('application_close');
 try { await evaluate('window.close(); true'); } catch(error) {
  if(!['debug_closed','debug_timeout'].includes(error.message)) throw error;
 }
 await waitFor(()=>exited,'application_exit');
 assert.equal(process.exitCode,0,'application_exit_failed');
 stage('application_closed');
 save('completion.json',{pass:true,cleanup:'closed',time:new Date().toISOString()});
 console.log('PACKAGED_TERMINAL_PASS '+run.id);
})().catch(error=>{
 if(client)client.close();save('completion.json',{pass:false,time:new Date().toISOString()});save('failure.json',{message:error.message,time:new Date().toISOString()});
 console.error('PACKAGED_TERMINAL_FAILED '+error.message);if(child&&!exited)child.kill();process.exitCode=1;
});
