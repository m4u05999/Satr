'use strict';
// عزل المنزل والبيئة؛ ينتهي Electron قبل إزالة ملف التجربة الشخصي.
const fs=require('fs'), path=require('path'), os=require('os'), assert=require('assert');
const {spawnSync}=require('child_process');
const {popupHint,callbackHint,createPopupManager}=require('../electron/preview-popups');
assert(popupHint('https://example.test/?display=popup'));
assert(popupHint('https://example.test/oauth/oidc/path'));
assert(!popupHint('https://example.test/normal'));
assert(callbackHint('https://example.test/?code=synthetic'));
let timer, retired=false;
const wc={isDestroyed:()=>retired,once(){},close(){retired=true;},session:{}};
const parent={isDestroyed:()=>false,session:{}};
const manager=createPopupManager({WebContentsView:class{constructor(){this.webContents=wc;}},
 host:()=>({isDestroyed:()=>false,contentView:{addChildView(){},removeChildView(){}}}),
 root:()=>parent,changed(){},wire(){},allowed:()=>true,warn(){},
 setTimer:fn=>{timer=fn;return 1;},clearTimer(){}});
const response=manager.handler(parent,{url:'https://example.test/'});
assert.strictEqual(response.action,'allow');response.createWindow({webPreferences:{}});
assert.strictEqual(manager.count(),1);timer();assert(retired);assert.strictEqual(manager.count(),0);
console.log('PASS abandoned popup timer');
const root=path.resolve(__dirname,'..'), evidence=path.join(root,'dist/popup-implementation');
fs.mkdirSync(evidence,{recursive:true});
const home=fs.mkdtempSync(path.join(os.tmpdir(),'satr-popups-'));
for(const dir of ['profile','AppData/Roaming','AppData/Local','Downloads','codex','claude'])fs.mkdirSync(path.join(home,dir),{recursive:true});
const env={};
// شاشة xvfb واعتماد اتصالها لازمان على لينكس؛ عزل منزل المحرك لا يعني فصل شاشة الاختبار.
for(const key of ['SystemRoot','WINDIR','ComSpec','PATH','PATHEXT','TEMP','TMP','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE','DISPLAY','XAUTHORITY'])if(process.env[key])env[key]=process.env[key];
const result=path.join(evidence,'live-'+Date.now()+'.json');
Object.assign(env,{HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local'),
 CODEX_HOME:path.join(home,'codex'),CLAUDE_CONFIG_DIR:path.join(home,'claude'),SATR_POPUP_TEST_HOME:home,SATR_POPUP_TEST_RESULT:result});
const child=spawnSync(require('electron'),[path.join(__dirname,'preview-popups-live-test.js')],{cwd:root,env,encoding:'utf8',timeout:55000,killSignal:'SIGKILL',windowsHide:true});
process.stdout.write(child.stdout||'');process.stderr.write(child.stderr||'');
if(!child.error&&child.status!==null){
 const resolved=path.resolve(home);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('satr-popups-'))throw Error('unsafe cleanup path');
 fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
console.log('EVIDENCE '+result);
if(child.error)console.error(child.error.message);
process.exitCode=child.status===0?0:1;
