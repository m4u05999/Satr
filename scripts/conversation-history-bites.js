'use strict';
const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'dist','session-history-bites.log');
const cases=[
 {name:'phase',file:'electron/conversation-bridge.js',from:'runId, phase, toolId, isError, steer,\n          status:',to:'runId, phase: undefined, toolId, isError, steer,\n          status:'},
 {name:'grouping',file:'src/ui/lib/conversation-history.js',from:'    if (block && key !== nextKey) finish();',to:'    if (block) finish();'},
 {name:'draft',file:'electron/conversations.js',from:'saveDraft(handle, runId); return { ok: true };',to:'/* مسودة معطلة للاختبار */ return { ok: true };'},
 {name:'selection',file:'electron/conversations.js',from:"atomicWrite(path.join(directory(normalized), '_latest.json'), { id, engine });",to:"/* تعطيل حفظ اختيار المحادثة لاختبار الحارس */"},
];
const records=[];
for(const bite of cases){
 const file=path.join(root,bite.file),original=fs.readFileSync(file);
 const nl=original.toString().includes('\r\n')?'\r\n':'\n';
 const source=original.toString().replace(/\r\n/g,'\n');
 const count=(s,x)=>s.split(x).length-1;
 assert.equal(count(source,bite.from),1,'ambiguous mutation '+bite.name);
 const mutated=source.replace(bite.from,bite.to);
 records.push('زرع: node scripts/conversation-history-bites.js '+bite.name+' | '+bite.file+' | '+JSON.stringify(bite.from)+' => '+JSON.stringify(bite.to));
 records.push('قبل/بعد: الأصل '+count(source,bite.from)+' → '+count(mutated,bite.from)+' · المتحوّر '+count(source,bite.to)+' → '+count(mutated,bite.to));
 try{
  fs.writeFileSync(file,mutated.replace(/\n/g,nl));
  assert.equal(count(fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n'),bite.to),1);
  const run=spawnSync(process.execPath,['scripts/conversation-history-test.js'],{cwd:root,encoding:'utf8',timeout:30000,windowsHide:true});
  assert.notEqual(run.status,0,'mutation did not fail '+bite.name);
  assert.equal(run.error,undefined,'test did not finish');
  records.push('فشل الحارس:\n'+run.stdout+run.stderr);
 }finally{
  fs.writeFileSync(file,original);
  assert(fs.readFileSync(file).equals(original));
  records.push('استعادة: fs.writeFileSync('+JSON.stringify(bite.file)+', original) — verified byte equality\n');
  fs.writeFileSync(output,records.join('\n'));
 }
}
const final=spawnSync(process.execPath,['scripts/conversation-history-test.js'],{cwd:root,encoding:'utf8',timeout:30000,windowsHide:true});
assert.equal(final.status,0,final.stderr);
fs.appendFileSync(output,'\nبعد الاستعادة:\n'+final.stdout);
console.log('PASS 4 mutations rejected; exact sources restored; '+output);
