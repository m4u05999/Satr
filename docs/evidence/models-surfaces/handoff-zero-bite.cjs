'use strict';
const fs=require('fs'),path=require('path');
const file=path.join(__dirname,'src/ui/components/preview-panel.js');
const pristine=path.join(__dirname,'preview-panel.original.js');
if(process.argv[2]==='restore'){
  fs.copyFileSync(pristine,file);console.log('restored isolated production copy');
}else{
  const original='window.satr.previewBounds(0, 0, 0, 0)';
  const mutant='window.satr.previewBounds(20, 30, 420, 360)';
  const text=fs.readFileSync(file,'utf8');
  const count=(value,part)=>value.split(part).length-1;
  console.log('before original='+count(text,original)+' mutant='+count(text,mutant));
  if(count(text,original)!==1||count(text,mutant)!==0)throw Error('unexpected source');
  const next=text.replace(original,mutant);fs.writeFileSync(file,next);
  console.log('after original='+count(next,original)+' mutant='+count(next,mutant));
}