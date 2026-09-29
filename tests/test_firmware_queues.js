// Compile the actual queue functions on the host with only the hardware barrier stubbed.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-queues-'));
for (const name of ['main.c', 'main_sta_flying_lead.c']) {
  const s = fs.readFileSync(path.join(__dirname, '../stm32/User', name), 'utf8');
  const queue = s.slice(s.indexOf('static uint16_t adc_dma_buf'), s.indexOf('/* 毫秒时基'));
  const tx = s.match(/static uint16_t tx_push\([^]*?\n\}/)[0];
  const code = `#include <stdint.h>
#include <assert.h>
#include <string.h>
#define ADC_BLOCK 16U
#define ADC_BUF_LEN 32U
#define SAMPLE_PERIOD_MS 5U
#define TX_RING_SIZE 16U
#define __DMB() ((void)0)
${queue}
static uint8_t g_tx_ring[TX_RING_SIZE];
static uint16_t g_tx_head, g_tx_tail;
static uint32_t g_dropped;
static uint32_t g_tx_bytes;   /* main.c 的诊断计数，宿主壳子里补个定义 */
${tx}
int main(void) {
  uint16_t i;
  assert(tx_push("123456789012",12)==12);
  assert(tx_push("ABCD",4)==0);
  assert(g_tx_head==12 && g_dropped==4);
  g_tx_tail=10;
  assert(tx_push("ABCDEF",6)==6);
  assert(g_tx_head==2 && g_tx_ring[0]=='E' && g_tx_ring[1]=='F');
  for(i=0;i<32;i++) adc_dma_buf[i]=i;
  capture_adc_block(0); capture_adc_block(1); capture_adc_block(0);
  capture_adc_block(1); /* Queue full: drop entire acquisition block. */
  assert(adc_overruns==1 && adc_acquired==64);
  memset(adc_dma_buf,0,sizeof(adc_dma_buf));
  assert(take_adc_packet());
  assert(adc_pending.first_seq==1 && adc_pending.samples[15]==15);
  assert(take_adc_packet()); assert(adc_pending.first_seq==17);
  assert(take_adc_packet()); assert(adc_pending.first_seq==33);
  assert(!take_adc_packet());
  capture_adc_block(0); assert(take_adc_packet());
  assert(adc_pending.first_seq==65 && adc_pending.first_ms==320);
  return 0;
}`;
  const bin = path.join(dir, name + '.test');
  const build = spawnSync('clang', ['-x','c','-std=c99','-o',bin,'-'], {input:code,encoding:'utf8'});
  if (build.status !== 0) throw Error(build.stderr);
  const run = spawnSync(bin, [], {encoding:'utf8'});
  if (run.status !== 0) throw Error(run.stderr);
  console.log(`PASS ${name}: whole-frame TX, wrap, ADC snapshots, overflow sequence gap`);
}
