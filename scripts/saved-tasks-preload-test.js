#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const Module=require('node:module');
const path=require('node:path');
const calls=[],listeners=new Map();
let rejectedChannel='';
let exposed=null;
const original=Module._load;
Module._load=function(request,parent,isMain){
  if(request==='electron') return {
    contextBridge:{exposeInMainWorld(name,value){assert.equal(name,'satr');exposed=value;}},
    ipcRenderer:{
      invoke(channel,payload){calls.push({channel,payload});return channel===rejectedChannel?Promise.reject(new Error('No handler registered for '+channel)):Promise.resolve({ok:true});},
      on(channel,handler){listeners.set(channel,handler);},
      removeListener(channel,handler){if(listeners.get(channel)===handler)listeners.delete(channel);},
      send(){},
    },
  };
  return original.call(this,request,parent,isMain);
};
try{
  const target=path.resolve(__dirname,'../electron/preload.js');delete require.cache[target];require(target);
}finally{Module._load=original;}
assert(exposed);
(async()=>{
  const payload={task_id:'task_'+ 'a'.repeat(32),revision:1};
  await exposed.savedTasksPrepareStart(payload);
  assert.deepEqual(calls.pop(),{channel:'satr:ee:savedTasksPrepareStart',payload});
  await exposed.savedTasksVerificationCatalog();
  assert.deepEqual(calls.pop(),{channel:'satr:ee:savedTasksVerificationCatalog',payload:undefined});
  rejectedChannel='satr:ee:savedTasksAvailability';
  assert.deepEqual(await exposed.savedTasksAvailability(),{ok:false,error:'feature_unavailable'});
  rejectedChannel='';
  let received=null;const off=exposed.onSavedTaskEvent((value)=>{received=value;});
  const envelope={owner:{run_id:'run_'+ 'b'.repeat(32)},event:{type:'stream_text',text:'x'}};
  listeners.get('satr:savedTaskEvent')({},envelope);assert.equal(received,envelope);off();
  assert.equal(listeners.has('satr:savedTaskEvent'),false);
  assert.equal(Object.prototype.hasOwnProperty.call(exposed,'invoke'),false,'preload كشف invoke عاماً');
  console.log('saved-tasks-preload: exact channels, event unsubscribe, and no generic invoke passed');
})().catch((error)=>{console.error(error.stack||error);process.exitCode=1;});