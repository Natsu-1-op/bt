const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');
const net=require('node:net');
(async()=>{
 const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const child=spawn(process.execPath,['tools/serve-page.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port)}});
 try{
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('preview startup timeout')),5000);child.stdout.once('data',()=>{clearTimeout(timeout);resolve();});child.once('exit',()=>{clearTimeout(timeout);reject(Error('preview exited'));});});
  for(const file of ['index.html','test.html','blink-app.js'])assert.equal((await fetch(`http://127.0.0.1:${port}/${file}`)).status,200);
  for(const file of ['.git/HEAD','database.rules.json','AI-SYNC/README.md','uploads/Bootloader.hex','package.json','%2e%2e/.git/HEAD'])assert.equal((await fetch(`http://127.0.0.1:${port}/${file}`)).status,403);
 }finally{child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));}
 console.log('PASS preview server: allowlisted assets only, private paths rejected');
})().catch(err=>{console.error(err);process.exitCode=1;});
