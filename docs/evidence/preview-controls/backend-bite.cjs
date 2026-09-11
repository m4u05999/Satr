'use strict';

// المصدر الإنتاجي يُقرأ فقط؛ الزرع في مصدر كامل مستقل داخل dist.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{spawnSync}=require('child_process');
const repo=path.resolve(__dirname,'../../..'),sourceFile=path.join(repo,'electron/preview.js');
const guard=path.join(repo,'scripts/preview-controls-backend-test.js'),self=__filename;
const mutations={
 cleanup:{original:"if (state.preset === 'net_online' && state.owned) { try { dbg.detach(); } catch {} }",mutant:"if (false) { try { dbg.detach(); } catch {} }",failure:'فشل أول تفعيل ترك debugger مملوكاً متصلاً'},
 cleanup_borrowed:{original:"if (state.preset === 'net_online' && state.owned) { try { dbg.detach(); } catch {} }",mutant:"if (state.preset === 'net_online') { try { dbg.detach(); } catch {} }",failure:'فشل الشبكة فصل debugger مستعاراً'},
 cleanup_previous:{original:"if (state.preset === 'net_online' && state.owned) { try { dbg.detach(); } catch {} }",mutant:"if (state.owned === true) { try { dbg.detach(); } catch {} }",failure:'فشل الاستعادة فصل debugger رغم بقاء المحاكاة'},
 reset:{original:'if (resetViewport === true) viewportOverride = null;',mutant:'if (false) viewportOverride = null;',failure:'اختيار الجهاز الصريح لم يلغ مقاس الوكيل'},
 zero:{original:'if (!viewportOverride || !bounds || bounds.width === 0 || bounds.height === 0) return bounds;',mutant:'if (!viewportOverride || !bounds) return bounds;',failure:'المقاس المخصص حوّل الحجب إلى مستطيل غير صفري'},
 enable:{original:"await dbg.sendCommand('Network.enable');",mutant:"dbg.sendCommand('Network.enable').catch(() => {});",failure:'أمر المحاكاة سبق اكتمال Network.enable'},
 emulate:{original:"await dbg.sendCommand('Network.emulateNetworkConditions', conditions);",mutant:"dbg.sendCommand('Network.emulateNetworkConditions', conditions).catch(() => {});",failure:'لم ينتظر أمر المحاكاة'},
 queue:{original:'const result = state.queue.then(run, run);',mutant:'const result = run();',failure:'طلبات الشبكة السريعة تداخلت'},
 ownership:{original:"if (preset === 'net_online' && state.owned) {",mutant:"if (preset === 'net_online') {",failure:'فصلت محاكاة الشبكة debugger مستعاراً'},
 stale:{original:'const isCurrent = () => currentWC() === wc;',mutant:'const isCurrent = () => true;',failure:'أحداث العرض القديم تسربت إلى واجهة الجديد'},
 closed:{original:"if (!externalWC()) emit({ type: 'closed' });",mutant:"if (false) emit({ type: 'closed' });",failure:'موت العرض لم يُبلّغ مرة واحدة'},
 action:{original:"} catch (e) { return { error: 'action_failed' }; }",mutant:'} catch (e) { return { ok: true }; }',failure:'فشل الزر أُعيد نجاحاً: reload'},
 storage:{original:'          await session.fromPartition(PARTITION).clearStorageData({',mutant:'          session.fromPartition(PARTITION).clearStorageData({',failure:'مسح التخزين لم ينتظر اكتماله'},
};
const count=(text,needle)=>text.split(needle).length-1;
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
function verifiedRoot(input){
 const target=path.resolve(input||''),base=path.join(repo,'dist')+path.sep;
 if(!target.startsWith(base)||!path.basename(target).startsWith('preview-controls-backend-bites-'))throw new Error('Unsafe bite root');
 return target;
}
const command=args=>['node',...args.map(value=>'"'+value+'"')].join(' ');
function run(args){
 const result=spawnSync(process.execPath,args,{cwd:repo,encoding:'utf8',timeout:20000,windowsHide:true});
 return {status:result.status,output:(result.stdout||'')+(result.stderr||''),error:result.error};
}
const mode=process.argv[2]||'all';
if(mode==='plant'||mode==='restore'){
 const name=process.argv[3],mutation=mutations[name],root=verifiedRoot(process.argv[4]);
 if(!mutation)throw new Error('Unknown mutation');
 const original=fs.readFileSync(path.join(root,'original.js'),'utf8'),output=path.join(root,name,'preview.js');
 if(mode==='plant'){
  if(count(original,mutation.original)!==1||count(original,mutation.mutant)!==0)throw new Error('Mutation not unique: '+name);
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.writeFileSync(output,original.replace(mutation.original,mutation.mutant));
  const actual=fs.readFileSync(output,'utf8');
  console.log('before: original='+count(original,mutation.original)+' mutant='+count(original,mutation.mutant));
  console.log('after: original='+count(actual,mutation.original)+' mutant='+count(actual,mutation.mutant));
  if(count(actual,mutation.original)!==0||count(actual,mutation.mutant)!==1)throw new Error('Mutation not planted');
 }else{
  fs.writeFileSync(output,original);
  const restored=fs.readFileSync(output,'utf8');
  console.log('restored: original='+count(restored,mutation.original)+' mutant='+count(restored,mutation.mutant)+' sha256='+hash(restored));
  if(restored!==original)throw new Error('Restore mismatch');
 }
}else if(mode==='all'){
 const original=fs.readFileSync(sourceFile,'utf8'),root=fs.mkdtempSync(path.join(repo,'dist/preview-controls-backend-bites-'));
 fs.writeFileSync(path.join(root,'original.js'),original);
 const fence=String.fromCharCode(96).repeat(3);
 let log='',report='# دليل حارس العملية الرئيسية لأزرار المعاينة\n\n';
 report+='الحارس يشغّل وحدة electron/preview.js كاملة، مع حدود Electron مضبوطة. لا يثبت هذا وحده سلوك Chromium الحقيقي؛ تجربته الحية مكملة. الزرع كله في نسخ مستقلة، ولم يتغير المصدر الإنتاجي.\n\n';
 report+='إعادة الإثبات من جذر المستودع:\n\n'+fence+'powershell\nnode docs/evidence/preview-controls/backend-bite.cjs all\n'+fence+'\n\n';
 report+='SHA-256 للمصدر المختبر: '+hash(original)+'.\n\n';
 for(const name of Object.keys(mutations)){
  const mutation=mutations[name];
  const plantArgs=[self,'plant',name,root],testArgs=[guard,path.join(root,name,'preview.js')],restoreArgs=[self,'restore',name,root];
  const planted=run(plantArgs);
  log+='\n$ '+command(plantArgs)+'\n'+planted.output;
  if(planted.status!==0)throw new Error(planted.output);
  const failed=run(testArgs);
  log+='\n$ '+command(testArgs)+'\nexit='+failed.status+'\n'+failed.output;
  const restored=run(restoreArgs);
  log+='\n$ '+command(restoreArgs)+'\n'+restored.output;
  if(restored.status!==0)throw new Error(restored.output);
  if(failed.status!==1||!failed.output.includes(mutation.failure))throw new Error('Wrong failure for '+name+'\n'+failed.output);
  const line=failed.output.split(/\r?\n/).find(line=>line.includes(mutation.failure));
  console.log(name+': original 1 -> 0; mutant 0 -> 1; exit=1; restored 1/0');
  console.log(line);
  report+='## '+name+'\n\n'+fence+'text\nزرع: '+command(plantArgs)+'\nقبل/بعد: الأصل 1 → 0 · المتحوّر 0 → 1\nاختبار: '+command(testArgs)+'\nرمز الخروج: '+failed.status+'\nفشل الحارس: '+line+'\nاستعادة: '+command(restoreArgs)+'\nبعد الاستعادة: الأصل 1 · المتحوّر 0\n'+fence+'\n\n';
 }
 if(fs.readFileSync(sourceFile,'utf8')!==original)throw new Error('Production changed during bites');
 const green=run([guard]);log+='\n$ '+command([guard])+'\n'+green.output;
 if(green.status!==0)throw new Error(green.output);
 report+='بعد الاستعادة: '+green.output.trim()+'، وبصمة المصدر الإنتاجي لم تتغير.\n\n';
 report+='السجل الحرفي في backend-bite.log. مسارات النسخ المؤقتة في الأوامر تخص هذه الجولة؛ أمر all أعلاه ينشئ نسخاً جديدة ويعيد جميع خطوات الزرع والعدّ والاختبار والاستعادة.\n';
 fs.writeFileSync(path.join(__dirname,'backend-bite.log'),log);
 fs.writeFileSync(path.join(__dirname,'backend-bite.md'),report);
 console.log(green.output.trim());
 console.log('BITE_ROOT='+root);
 console.log('PRODUCTION_SHA256='+hash(original));
}else throw new Error('Use all, plant, or restore');