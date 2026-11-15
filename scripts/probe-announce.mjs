/**
 * 探针：后台 job 结算后，「自发轮次 → 播报」这条链路到底走不走得通。
 *
 * 语音层的日志里从来没出现过 `后台 任务完成 → 播报`，也就是说这条链路
 * 从未被真实触发过。这里绕开语音层，直接对 DshSession 验一次。
 *
 * 跑法（服务器上）：
 *   set -a; . ~/miai-cloud/.env; set +a
 *   node /tmp/announce-probe.mjs
 */
import { mkdirSync } from 'node:fs';

import { DshSession } from '<部署路径>/miai-cloud/src/session.ts';

const DIR = '/tmp/announce-probe';
mkdirSync(DIR, { recursive: true });

const announced = [];
let statusLine = 0;

const session = new DshSession({
  workDir: DIR,
  // 必须用独立会话文件，否则会污染线上那条真实会话
  sessionFile: `${DIR}/session.json`,
  mode: 'sdk',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  patch: process.env['DSH_PATCH'],
  log: (line) => {
    statusLine += 1;
    console.log(`[dsh] ${line}`);
  },
});

session.onAnnounce = (text) => {
  announced.push(text);
  console.log(`### ANNOUNCE(${announced.length}): ${JSON.stringify(text)}`);
};

const prompt = '用 bash 在后台跑一条 `sleep 12 && echo PROBE_DONE`（run_in_background），'
  + '派走之后立刻回我一句「已经派走了」，不要等它跑完。';

console.log('--- 第一轮：只让它派任务 ---');
const first = await session.ask(prompt);
console.log(`first: ${JSON.stringify(first.text)}  ${(first.durationMs / 1000).toFixed(1)} s`);

console.log('--- 等后台结算（最多 75 s）---');
for (let i = 0; i < 75; i += 1) {
  await new Promise((resolve) => { setTimeout(resolve, 1000); });
  if (announced.length > 0) {
    console.log(`第 ${i + 1} 秒收到播报`);
    break;
  }
}

console.log(`\n===== 结论 =====`);
console.log(`onAnnounce 次数: ${announced.length}`);
console.log(`内容: ${JSON.stringify(announced)}`);
console.log(`dsh 日志行数: ${statusLine}`);
session.stop();
process.exit(announced.length > 0 ? 0 : 1);
