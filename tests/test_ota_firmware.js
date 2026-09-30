// Hardware-free checks of the real image/BEGIN validator plus boot erase order.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),ota=path.join(root,'stm32/OTA');
for(const f of ['ota_image.h','ota_app.c','bootloader.c'])if(!fs.existsSync(path.join(ota,f)))throw Error('Missing local firmware: '+f);
const boot=fs.readFileSync(path.join(ota,'bootloader.c'),'utf8');
const program=boot.slice(boot.indexOf('static uint8_t program_staged_image'),boot.indexOf('static void clear_metadata'));
assert(program.indexOf('OTA_ImageValid(OTA_STAGING_BASE')<program.indexOf('FLASH_Unlock()'),'staged vector validation precedes any erase');
const main=fs.readFileSync(path.join(root,'stm32/User/main.c'),'utf8');
assert.match(main,/OTA_App_ValidateBegin\(cmd\)/);assert.match(main,/now_ms - g_ota_last_activity\) >= 30000U/);
const app=fs.readFileSync(path.join(ota,'ota_app.c'),'utf8');
// Compile validator bodies from the actual source, not a JavaScript facsimile.
const functions=['is_dec','split_field','parse_u32','OTA_App_ValidateBegin'].map(n=>{
 const match=app.match(new RegExp('(?:static )?uint8_t '+n+'\\([^]*?\\n\\}'));
 if(!match)throw Error('Missing C validator '+n);return match[0];
}).join('\n');
const code=`#include <stdint.h>
#include <assert.h>
#include <string.h>
#include "ota_image.h"
${functions}
int main(void){
 uint32_t image[8]={0x20005000U,0x08002009U,0x0000BF00U};
 assert(OTA_ImageValid((uintptr_t)image,10));
 assert(!OTA_ImageValid((uintptr_t)image,1));
 image[1]=0x08007FFFU; assert(!OTA_ImageValid((uintptr_t)image,10));
 image[1]=0x08002008U; assert(!OTA_ImageValid((uintptr_t)image,10));
 image[1]=0x08002009U;image[0]=0x20004FFFU;assert(!OTA_ImageValid((uintptr_t)image,10));
 image[0]=0x20005000U;image[2]=0xFFFFFFFFU;assert(!OTA_ImageValid((uintptr_t)image,10));
 assert(OTA_App_ValidateBegin("OTA_BEGIN,10,0,1"));
 assert(!OTA_App_ValidateBegin("OTA_BEGIN,1,0,1"));
 assert(!OTA_App_ValidateBegin("OTA_BEGIN,24577,0,1"));
 assert(!OTA_App_ValidateBegin("OTA_BEGIN,10,0,1,junk"));
 assert(!OTA_App_ValidateBegin("OTA_BEGIN,NaN,0,1"));
 return 0;
}`;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'blink-ota-')),bin=path.join(dir,'validators');
const build=spawnSync('clang',['-x','c','-std=c99','-I',ota,'-o',bin,'-'],{input:code,encoding:'utf8'});assert.equal(build.status,0,build.stderr);
const run=spawnSync(bin,[],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
console.log('PASS actual firmware validators: vector/range/alignment, BEGIN rejection, pre-erase gate and abandonment timeout');
