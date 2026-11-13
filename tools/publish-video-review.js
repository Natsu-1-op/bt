const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {checkDelivery} = require('./check-review-delivery');

const [original, videoDir, fit, output, extra, ...marks] = process.argv.slice(2);
if(!marks.length)throw Error('用法：node tools/publish-video-review.js 原交付目录 视频目录 深度标定结果.json 新交付目录 单独源文件或 - 人工标记.json […]');

const research='研究用_含原始数据_勿外发';
const destination=path.resolve(output);
if(fs.existsSync(destination))throw Error('新交付目录已存在，请选择新的输出路径。');
const stage=fs.mkdtempSync(path.join(path.dirname(destination),'.blink-review-'));
const draft=path.join(stage,'交付');
const reviewed=path.join(stage,'标定结果.json');
const run=(script,args)=>execFileSync(process.execPath,[path.join(__dirname,script),...args],{stdio:'inherit'});
try{
  run('apply-video-review.js',[path.join(original,research),fit,reviewed,...marks]);
  run('sync-calibrated-delivery.js',[original,reviewed,draft,...(extra==='-'?[]:[extra])]);
  const local=path.join(draft,research,'视频复核');
  fs.mkdirSync(local,{mode:0o700});
  fs.copyFileSync(reviewed,path.join(local,'人工复核后标定结果.json'));
  run('build-video-review.js',[path.join(draft,research),videoDir,reviewed,path.join(local,'视频与波形复核.html')]);
  console.log(JSON.stringify(checkDelivery(draft)));
  // Reserve the output path before moving the complete directory contents.
  fs.mkdirSync(destination,{mode:0o700});
  try{fs.renameSync(draft,destination);}
  catch(error){fs.rmdirSync(destination);throw error;}
  fs.unlinkSync(reviewed);
  fs.rmdirSync(stage);
  console.log(destination);
}catch(error){
  console.error('本次生成的文件保存在 '+stage);
  throw error;
}
