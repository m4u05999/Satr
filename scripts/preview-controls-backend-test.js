'use strict';

// يشغّل وحدة الإنتاج كاملة في VM؛ حدود Electron وحدها مضبوطة لفرض التأخر/الفشل.
// لا يفتح متصفحاً ولا يمس تخزين المالك. قياس CDP الحقيقي مكمل في التجربة الحية.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const sourcePath = process.argv[2] || path.join(__dirname, '../electron/preview.js');
const source = fs.readFileSync(sourcePath, 'utf8');
let checks = 0;
const plain = value => JSON.parse(JSON.stringify(value));
function equal(actual, expected, label) { assert.deepStrictEqual(plain(actual), expected, label); checks += 1; }
function ok(value, label) { assert(value, label); checks += 1; }
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  let nextId = 0;
  const allViews = [], events = [], webRequest = {};
  const ses = new EventEmitter();
  ses.setPermissionRequestHandler = () => {};
  ses.webRequest = {
    onCompleted: listener => { webRequest.completed = listener; },
    onErrorOccurred: listener => { webRequest.failed = listener; },
  };
  ses.clearStorageData = async () => {};
  class Debugger extends EventEmitter {
    constructor() { super(); this.attached = false; this.commands = []; this.detaches = 0; this.attaches = 0; this.offline = false; }
    isAttached() { return this.attached; }
    attach() { this.attached = true; this.attaches += 1; }
    detach() { this.attached = false; this.offline = false; this.detaches += 1; this.emit('detach', {}, 'test'); }
    async sendCommand(method, params) {
      this.commands.push({ method, params });
      if (this.commandHook) await this.commandHook(method, params);
      if (method === 'Network.emulateNetworkConditions') this.offline = params.offline;
      return {};
    }
  }
  class WC extends EventEmitter {
    constructor(owner) {
      super(); this.id = ++nextId; this.owner = owner; this.debugger = new Debugger();
      this.destroyed = false; this.reloads = 0; this.url = ''; this.devtools = false;
      this.navigationHistory = { canGoBack: () => true, canGoForward: () => true, goBack: () => {}, goForward: () => {} };
    }
    isDestroyed() { return this.destroyed; }
    getURL() { return this.url; }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    reload() { this.reloads += 1; }
    isDevToolsOpened() { return this.devtools; }
    openDevTools() { this.devtools = true; this.emit('devtools-opened'); }
    closeDevTools() { this.devtools = false; this.emit('devtools-closed'); }
    setWindowOpenHandler(handler) { this.windowOpen = handler; }
    executeJavaScript() { return Promise.resolve({ width: this.owner.bounds.width, height: this.owner.bounds.height, dpr: 1 }); }
    close() {
      if (this.deferClose) return;
      this.destroyed = true;
      this.emit('destroyed');
      if (this.debugger.attached) this.debugger.detach();
    }
  }
  class View {
    constructor() { this.bounds = {x:0,y:0,width:0,height:0}; this.webContents = new WC(this); allViews.push(this); }
    setBounds(bounds) { this.bounds = plain(bounds); }
    setBackgroundColor() {}
  }
  const app = new EventEmitter();
  app.getLocale = () => 'en-US';
  const win = new EventEmitter();
  win.isDestroyed = () => false;
  win.getContentBounds = () => ({width:1000,height:800});
  win.contentView = {
    children: [],
    addChildView(v) { this.children.push(v); },
    removeChildView(v) { this.children = this.children.filter(child => child !== v); },
  };
  const module = {exports:{}};
  const context = {
    module, exports:module.exports, console, URL, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
    performance, process, __dirname: path.join(__dirname, '../electron'),
    require(name) {
      if (name === 'electron') return {WebContentsView:View,session:{fromPartition:()=>ses},app,nativeImage:{}};
      if (name === './memory') return {hasSecret:()=>false};
      if (name === './browserorigin') return require('../electron/browserorigin');
      return require(name);
    },
  };
  vm.runInNewContext(source,context,{filename:sourcePath});
  const preview = module.exports;
  const open = () => {
    const result = preview.open(win,event=>events.push(plain(event)),'http://127.0.0.1/fixture');
    assert.strictEqual(result.ok,true);
    return allViews[allViews.length-1].webContents;
  };
  preview.setBounds({x:10,y:20,width:900,height:700});
  const wc = open();
  return {preview,wc,open,events,win,ses,webRequest,allViews};
}

async function main() {
  {
    const h = harness(), p = h.preview, box = {x:10,y:20,width:900,height:700};
    await p.setViewport(360,480);
    equal(h.wc.owner.bounds,{x:280,y:20,width:360,height:480},'مقاس الوكيل لم يطبق');
    p.setBounds({...box,width:850},null);
    equal(h.wc.owner.bounds.width,360,'القياس الدوري محا مقاس الوكيل');
    for (const reset of [undefined,false,1,'true']) {
      p.setBounds(box,'mobile',reset);
      equal(h.wc.owner.bounds.width,360,'resetViewport غير true محا المقاس');
    }
    for (const zero of [{...box,width:0},{...box,height:0},{x:0,y:0,width:0,height:0}]) {
      p.setBounds(zero);
      equal(h.wc.owner.bounds,zero,'المقاس المخصص حوّل الحجب إلى مستطيل غير صفري');
    }
    p.setBounds(box);
    equal(h.wc.owner.bounds.width,360,'إعادة العرض بعد الحجب أضاعت المقاس المخصص');
    p.setBounds(box,null,true);
    equal(h.wc.owner.bounds,box,'اختيار الجهاز الصريح لم يلغ مقاس الوكيل');
    p.destroy();
  }
  {
    const h = harness(), d = h.wc.debugger, enable = deferred(), emulate = deferred();
    d.commandHook = method => method === 'Network.enable' ? enable.promise : emulate.promise;
    let finished = false;
    const pending = Promise.resolve(h.preview.action('net_slow')).then(r=>{finished=true;return r;});
    await tick();
    equal(d.commands.map(x=>x.method),['Network.enable'],'أمر المحاكاة سبق اكتمال Network.enable');
    equal(finished,false,'أُعلن نجاح الشبكة قبل إتمام CDP');
    equal(h.events.filter(e=>e.type==='network'),[],'بُثّت حالة شبكة قبل تأكيدها');
    enable.resolve(); await tick();
    equal(d.commands.map(x=>x.method),['Network.enable','Network.emulateNetworkConditions'],'لم يبدأ أمر المحاكاة بعد enable');
    equal(finished,false,'لم ينتظر أمر المحاكاة');
    emulate.resolve();
    equal(await pending,{ok:true,preset:'net_slow'},'فشل نجاح الشبكة المؤكد');
    equal(h.events.filter(e=>e.type==='network'),[{type:'network',preset:'net_slow'}],'حالة الشبكة المؤكدة لا تطابق التنفيذ');
    h.preview.destroy();
  }
  for (const failedMethod of ['Network.enable','Network.emulateNetworkConditions']) {
    const h = harness(), d = h.wc.debugger;
    d.commandHook = method => { if(method===failedMethod) throw new Error('PRIVATE_UPSTREAM'); };
    equal(await h.preview.action('net_offline'),{error:'throttle_unavailable'},'فشل CDP أُعيد نجاحاً أو سرّب upstream: '+failedMethod);
    equal(h.events.filter(e=>e.type==='network'),[],'فشل CDP بدّل حالة الشبكة');
    equal(d.isAttached(),false,'فشل أول تفعيل ترك debugger مملوكاً متصلاً');
    equal(d.detaches,1,'لم يُحرَّر debugger بعد فشل أول تفعيل');
    d.commandHook = null;
    equal(await h.preview.action('net_fast'),{ok:true,preset:'net_fast'},'الطابور بقي عالقاً بعد فشل CDP');
    h.preview.destroy();
  }
  {
    const h = harness(), d = h.wc.debugger;
    await h.preview.action('net_offline');
    const restoring = deferred();
    d.commandHook = (method,params) => method==='Network.emulateNetworkConditions' && !params.offline ? restoring.promise : undefined;
    const pending = h.preview.action('net_online');
    await tick();
    equal(d.detaches,0,'فصل debugger سبق استعادة الشبكة');
    equal(d.offline,true,'تغيرت الشبكة قبل تأكيد الاستعادة');
    restoring.resolve();
    equal(await pending,{ok:true,preset:'net_online'},'فشلت استعادة الشبكة');
    equal(d.offline,false,'بقيت المحاكاة غير المتصلة بعد نجاح online');
    equal(d.detaches,1,'لم يفصل الاتصال الذي يملكه بعد الاستعادة');
    h.preview.destroy();
  }
  {
    const h = harness(), d = h.wc.debugger;
    await h.preview.action('net_offline');
    const before = h.events.length;
    d.commandHook = (method,params) => { if(method==='Network.emulateNetworkConditions'&&!params.offline) throw new Error('restore failed'); };
    equal(await h.preview.action('net_online'),{error:'throttle_unavailable'},'استعادة فاشلة أُعلنت نجاحاً');
    equal(d.detaches,0,'فشل الاستعادة فصل debugger رغم بقاء المحاكاة');
    equal(h.events.length,before,'فشل الاستعادة أعلن حالة جديدة');
    h.preview.destroy();
  }
  {
    const h = harness(), d = h.wc.debugger, first = deferred();
    d.commandHook = (method,params) => method==='Network.emulateNetworkConditions'&&params.latency===400 ? first.promise : undefined;
    const slow=h.preview.action('net_slow'), offline=h.preview.action('net_offline'), online=h.preview.action('net_online');
    await tick();
    equal(d.commands.filter(c=>c.method==='Network.emulateNetworkConditions').map(c=>c.params.latency),[400],'طلبات الشبكة السريعة تداخلت');
    first.resolve();
    equal((await Promise.all([slow,offline,online])).map(r=>r.preset),['net_slow','net_offline','net_online'],'ترتيب إقرارات الشبكة انقلب');
    equal(d.commands.filter(c=>c.method==='Network.emulateNetworkConditions').map(c=>c.params.offline),[false,true,false],'أوامر الشبكة لم تتسلسل حسب النقر');
    h.preview.destroy();
  }
  {
    const h = harness(), d = h.wc.debugger;
    d.attach();
    await h.preview.action('net_slow');
    await h.preview.action('net_online');
    equal(d.attaches,1,'فُتح debugger إضافي رغم وجود اتصال');
    equal(d.detaches,0,'فصلت محاكاة الشبكة debugger مستعاراً');
    equal(d.isAttached(),true,'فقد مالك debugger اتصاله');
    h.preview.destroy();
  }
  {
    const h = harness(), d = h.wc.debugger, pendingCommand = deferred();
    d.commandHook = method=>method==='Network.emulateNetworkConditions'?pendingCommand.promise:undefined;
    const pending = h.preview.action('net_offline');
    await tick();
    d.detach();
    pendingCommand.resolve();
    equal(await pending,{error:'throttle_unavailable'},'فصل debugger أثناء الطلب تبعه نجاح متأخر');
    equal(h.events.filter(e=>e.type==='network'),[],'طلب لم يُطبّق بث حالة شبكة جديدة بعد الفصل');
    d.commandHook=null;
    equal(await h.preview.action('net_fast'),{ok:true,preset:'net_fast'},'الشبكة لم تتعاف بعد فصل debugger');
    h.preview.destroy();
  }
  {
    const h = harness(), old = h.wc, blocked = deferred();
    old.debugger.commandHook = method=>method==='Network.emulateNetworkConditions'?blocked.promise:undefined;
    const running=h.preview.action('net_slow'), queued=h.preview.action('net_offline');
    await tick();
    old.deferClose=true;
    h.preview.close();
    const fresh=h.open();
    await h.preview.action('net_fast');
    const before=h.events.length;
    blocked.resolve();
    equal(await running,{error:'closed'},'أُقر طلب الشبكة الخاص بالعرض المغلق');
    equal(await queued,{error:'closed'},'طابور العرض القديم نُفّذ على عرض جديد');
    equal(fresh.debugger.commands.filter(c=>c.method==='Network.emulateNetworkConditions').length,1,'طلبات العرض القديم وصلت debugger الجديد');
    old.debugger.detach();
    equal(h.events.length,before,'فصل debugger القديم بدّل واجهة العرض الجديد');
    h.preview.destroy();
  }
  {
    const h=harness(),d=h.wc.debugger;
    d.attach();
    d.commandHook=()=>{throw new Error('borrowed failure');};
    equal(await h.preview.action('net_slow'),{error:'throttle_unavailable'},'فشل اتصال مستعار أُقر نجاحاً');
    equal(d.isAttached(),true,'فشل الشبكة فصل debugger مستعاراً');
    equal(d.detaches,0,'تنظيف أول فشل مسّ المرفق المستعار');
    h.preview.destroy();
  }
  {
    const h=harness(),d=h.wc.debugger;
    await h.preview.action('net_slow');
    const before=h.events.length;
    d.commandHook=()=>{throw new Error('later failure');};
    equal(await h.preview.action('net_fast'),{error:'throttle_unavailable'},'فشل تغيير محاكاة قائمة أُقر نجاحاً');
    equal(d.isAttached(),true,'فشل التغيير أزال محاكاة قائمة');
    equal(d.detaches,0,'تنظيف فشل التغيير فصل المحاكاة السابقة');
    equal(h.events.length,before,'فشل التغيير بدّل الحالة المؤكدة');
    h.preview.destroy();
  }
  {
    const h=harness(),d=h.wc.debugger;
    await h.preview.action('net_offline');
    d.detach();
    equal(h.events.filter(e=>e.type==='network'),[{type:'network',preset:'net_offline'},{type:'network',preset:'net_online'}],'فصل محاكاة مؤكدة لم يصفّر حالة الشبكة');
    h.preview.destroy();
  }
  for (const name of ['reload','back','forward','devtools']) {
    const h=harness();
    const fail=()=>{throw new Error('PRIVATE_ACTION');};
    if(name==='reload')h.wc.reload=fail;
    else if(name==='back')h.wc.navigationHistory.goBack=fail;
    else if(name==='forward')h.wc.navigationHistory.goForward=fail;
    else h.wc.openDevTools=fail;
    equal(await h.preview.action(name),{error:'action_failed'},'فشل الزر أُعيد نجاحاً: '+name);
    h.preview.destroy();
  }
  {
    const h=harness(), cleared=deferred();
    let storages;
    h.ses.clearStorageData=options=>{storages=plain(options.storages);return cleared.promise;};
    let finished=false;
    const pending=Promise.resolve(h.preview.action('clear_storage')).then(r=>{finished=true;return r;});
    await tick();
    equal(finished,false,'مسح التخزين لم ينتظر اكتماله');
    equal(h.wc.reloads,0,'إعادة التحميل سبقت مسح التخزين');
    equal(storages,['cookies','localstorage','indexdb','websql','serviceworkers','cachestorage','shadercache'],'اتسع نطاق التخزين الممسوح');
    cleared.resolve();
    equal(await pending,{ok:true},'مسح التخزين لم ينجح بعد اكتماله');
    equal(h.wc.reloads,1,'لم يُعد التحميل بعد نجاح المسح');
    h.ses.clearStorageData=async()=>{throw new Error('PRIVATE_STORAGE');};
    equal(await h.preview.action('clear_storage'),{error:'action_failed'},'فشل مسح التخزين أُعيد نجاحاً');
    equal(h.wc.reloads,1,'أُعيد التحميل بعد فشل مسح التخزين');
    h.preview.destroy();
  }
  {
    const h=harness(), cleared=deferred();
    h.ses.clearStorageData=()=>cleared.promise;
    const pending=h.preview.action('clear_storage');
    h.preview.close();
    const fresh=h.open();
    cleared.resolve();
    equal(await pending,{error:'closed'},'مسح عرض قديم أُقر بعد إعادة الفتح');
    equal(fresh.reloads,0,'إعادة تحميل مسح قديم وصلت العرض الجديد');
    h.preview.destroy();
  }
  {
    const h=harness(), old=h.wc;
    await h.preview.setViewport(360,480);
    old.close();
    equal(h.events.filter(e=>e.type==='closed').length,1,'موت العرض لم يُبلّغ مرة واحدة');
    equal(h.win.contentView.children.length,0,'بقي العرض الميت في شجرة العرض');
    equal(h.preview.action('reload').error,'closed','زر العرض الميت لم يعلن الإغلاق');
    const fresh=h.open();
    equal(fresh.owner.bounds.width,900,'مقاس العرض الميت انتقل إلى الجديد');
    fresh.emit('console-message',{},1,'fresh',1,'http://127.0.0.1/fresh.js');
    const before=h.events.length, revision=h.preview._internals.leaseState().userInputCounter;
    for(const args of [
      ['page-title-updated',{},'old'],['did-start-loading'],['did-stop-loading'],
      ['did-navigate'],['did-navigate-in-page'],['devtools-opened'],['devtools-closed'],
      ['did-fail-load',{},-105,'old','http://127.0.0.1/old',true],
      ['console-message',{},3,'old error',1,'http://127.0.0.1/old.js'],
      ['did-start-navigation',{},'http://127.0.0.1/old',false,true],
      ['input-event',{}, {type:'mouseDown'}],['destroyed'],['render-process-gone',{},{}],
    ]) old.emit(...args);
    h.webRequest.completed({webContentsId:old.id,url:'http://127.0.0.1/old',statusCode:200});
    h.webRequest.failed({webContentsId:old.id,url:'http://127.0.0.1/old',error:'net::ERR_FAILED'});
    equal(h.events.length,before,'أحداث العرض القديم تسربت إلى واجهة الجديد');
    equal(h.preview._internals.leaseState().userInputCounter,revision,'إدخال قديم أفسد عقد اللقطة الجديدة');
    const logs=h.preview.getConsole();
    ok(logs.logs.some(e=>e.message==='fresh'),'تنقل قديم محا سجل العرض الجديد');
    equal(h.win.contentView.children.length,1,'حدث قديم أزال العرض الجديد');
    fresh.emit('render-process-gone',{}, {reason:'crashed'});
    equal(h.events.filter(e=>e.type==='closed').length,2,'انهيار renderer لم يُبلّغ مرة واحدة');
    equal(h.preview.action('reload').error,'closed','بقي العرض المنهار هدفاً للأزرار');
    h.preview.destroy();
  }
  console.log('preview-controls-backend: '+checks+'/'+checks+' PASS');
}
main().catch(error=>{console.error('preview-controls-backend: '+(error.stack||error));process.exitCode=1;});