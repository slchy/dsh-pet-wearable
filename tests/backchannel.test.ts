/**
 * 旁听反馈只认整段都是应答词。误判的代价是把确认或请求静默吞掉。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isBackchannelOnly } from '../src/backchannel.ts';

test('长短词交界从左到右按最长词剥，整段仍是旁听反馈', () => {
  assert.equal(isBackchannelOnly('知道了我知道了'), true);
  assert.equal(isBackchannelOnly('我知道了知道了'), true);
  assert.equal(isBackchannelOnly('明白了我明白了'), true);
  assert.equal(isBackchannelOnly('我明白了明白了'), true);
  assert.equal(isBackchannelOnly('嗯我知道了'), true);
  assert.equal(isBackchannelOnly('嗯嗯，我知道了我知道了。'), true);
  assert.equal(isBackchannelOnly('知道了知道了。'), true);
  assert.equal(isBackchannelOnly('收到，收到。'), true);
  assert.equal(isBackchannelOnly('呃…明白了。'), true);
});

test('确认词和实义句放行', () => {
  // 「好的」不在词表里：它可能是对上一个确认请求的应答。
  // 「嗯我知道了好的」剥完「嗯」「我知道了」还剩「好的」，不是纯旁听。
  assert.equal(isBackchannelOnly('嗯我知道了好的'), false);
  assert.equal(isBackchannelOnly('好的。'), false);
  assert.equal(isBackchannelOnly('好。'), false);
  assert.equal(isBackchannelOnly('行。'), false);
  assert.equal(isBackchannelOnly('嗯，拍照。'), false);
  assert.equal(isBackchannelOnly('明白了，那第二点呢？'), false);
  assert.equal(isBackchannelOnly('我知道了，帮我查一下天气。'), false);
  assert.equal(isBackchannelOnly('哎，别别别别退。'), false);
  assert.equal(isBackchannelOnly(''), false);
  assert.equal(isBackchannelOnly('。。。'), false);
});
