/**
 * 桌宠偏好：坏 JSON、锚点版本、尺寸两套上限、右缘避让、字幕开关。不碰 DOM。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_RIGHT_GAP,
  DEFAULT_SIZE_PX,
  PREFS_KEY,
  SIZE_SLIDER_MAX_PX,
  SIZE_STORE_MAX_PX,
  clampSliderSize,
  defaultPrefs,
  loadPrefs,
  parsePrefs,
  savePrefs,
  serializePrefs,
} from '../src/browser/pet-prefs.ts';

const ANCHOR = {
  v: 2 as const,
  hAnchor: 'right' as const,
  hDist: 12,
  vAnchor: 'bottom' as const,
  vDist: 0,
  hSnapped: 'right' as const,
  vSnapped: null,
};

test('坏 JSON、空串和非对象回到默认', () => {
  assert.equal(PREFS_KEY, 'dsh-voice-pet-v1');
  assert.deepEqual(parsePrefs('{'), defaultPrefs());
  assert.deepEqual(parsePrefs(''), defaultPrefs());
  assert.deepEqual(parsePrefs('not-json'), defaultPrefs());
  assert.deepEqual(parsePrefs('null'), defaultPrefs());
  assert.deepEqual(parsePrefs('[]'), defaultPrefs());
  assert.deepEqual(parsePrefs('0'), defaultPrefs());
  assert.equal(defaultPrefs().sizePx, DEFAULT_SIZE_PX);
  assert.equal(defaultPrefs().rightGap, DEFAULT_RIGHT_GAP);
  assert.equal(defaultPrefs().showBubble, true);
  assert.equal(defaultPrefs().mirrorOnLeft, false);
  assert.equal(defaultPrefs().headphoneHintDismissed, false);
  assert.equal(defaultPrefs().soundEnabled, true);
  assert.equal(defaultPrefs().retroSpark, false);
  assert.equal(defaultPrefs().anchor, null);
});

test('音效开关：soundEnabled 只有显式 false 才关，retroSpark 只有显式 true 才开', () => {
  assert.equal(parsePrefs({}).soundEnabled, true);
  assert.equal(parsePrefs({ soundEnabled: true }).soundEnabled, true);
  assert.equal(parsePrefs({ soundEnabled: false }).soundEnabled, false);
  assert.equal(parsePrefs({ soundEnabled: 0 }).soundEnabled, true);
  assert.equal(parsePrefs({ soundEnabled: 'false' }).soundEnabled, true);
  assert.equal(parsePrefs({ soundEnabled: null }).soundEnabled, true);

  assert.equal(parsePrefs({}).retroSpark, false);
  assert.equal(parsePrefs({ retroSpark: true }).retroSpark, true);
  assert.equal(parsePrefs({ retroSpark: false }).retroSpark, false);
  assert.equal(parsePrefs({ retroSpark: 1 }).retroSpark, false);
  assert.equal(parsePrefs({ retroSpark: 'true' }).retroSpark, false);

  const prefs = defaultPrefs();
  prefs.soundEnabled = false;
  prefs.retroSpark = true;
  assert.deepEqual(parsePrefs(serializePrefs(prefs)), prefs);
});

test('锚点 v 不是 2 就丢掉，其它字段还在', () => {
  const parsed = parsePrefs({
    anchor: {
      v: 1,
      hAnchor: 'left',
      hDist: 0,
      vAnchor: 'top',
      vDist: 0,
      hSnapped: null,
      vSnapped: null,
    },
    sizePx: 180,
    mirrorOnLeft: true,
  });
  assert.equal(parsed.anchor, null);
  assert.equal(parsed.sizePx, 180);
  assert.equal(parsed.mirrorOnLeft, true);

  assert.equal(parsePrefs({
    anchor: { ...ANCHOR, v: '2' },
  }).anchor, null);
  assert.deepEqual(parsePrefs({ anchor: ANCHOR }).anchor, ANCHOR);
  assert.equal(parsePrefs({
    anchor: { ...ANCHOR, hDist: Number.NaN },
  }).anchor, null);
});

test('NaN 尺寸回默认，存档夹到 260，滑条夹到 240', () => {
  assert.equal(SIZE_STORE_MAX_PX, 260);
  assert.equal(SIZE_SLIDER_MAX_PX, 240);
  assert.equal(parsePrefs({ sizePx: Number.NaN }).sizePx, DEFAULT_SIZE_PX);
  assert.equal(parsePrefs({ sizePx: Number.POSITIVE_INFINITY }).sizePx, DEFAULT_SIZE_PX);
  assert.equal(parsePrefs({ sizePx: '200' }).sizePx, DEFAULT_SIZE_PX);
  assert.equal(parsePrefs({ sizePx: 50 }).sizePx, 96);
  assert.equal(parsePrefs({ sizePx: 96.4 }).sizePx, 96);
  assert.equal(parsePrefs({ sizePx: 96.5 }).sizePx, 97);
  assert.equal(parsePrefs({ sizePx: 240 }).sizePx, 240);
  assert.equal(parsePrefs({ sizePx: 260 }).sizePx, 260);
  assert.equal(parsePrefs({ sizePx: 260.4 }).sizePx, 260);
  assert.equal(parsePrefs({ sizePx: 300 }).sizePx, 260);

  assert.equal(clampSliderSize(300), 240);
  assert.equal(clampSliderSize(260), 240);
  assert.equal(clampSliderSize(240.4), 240);
  assert.equal(clampSliderSize(240.6), 240);
  assert.equal(clampSliderSize(180.2), 180);
  assert.equal(clampSliderSize(50), 96);
});

test('rightGap 小于等于 0 收成 0，没有上限', () => {
  assert.equal(parsePrefs({ rightGap: 0 }).rightGap, 0);
  assert.equal(parsePrefs({ rightGap: -8 }).rightGap, 0);
  assert.equal(parsePrefs({ rightGap: 0.25 }).rightGap, 0.25);
  assert.equal(parsePrefs({ rightGap: 100_000 }).rightGap, 100_000);
  assert.equal(parsePrefs({ rightGap: Number.NaN }).rightGap, DEFAULT_RIGHT_GAP);
  assert.equal(parsePrefs({ rightGap: Number.POSITIVE_INFINITY }).rightGap, DEFAULT_RIGHT_GAP);
  assert.equal(parsePrefs({ rightGap: '4' }).rightGap, DEFAULT_RIGHT_GAP);
});

test('showBubble 只有显式 false 才关，其余都开', () => {
  assert.equal(parsePrefs({}).showBubble, true);
  assert.equal(parsePrefs({ showBubble: true }).showBubble, true);
  assert.equal(parsePrefs({ showBubble: false }).showBubble, false);
  assert.equal(parsePrefs({ showBubble: 0 }).showBubble, true);
  assert.equal(parsePrefs({ showBubble: 'false' }).showBubble, true);
  assert.equal(parsePrefs({ showBubble: null }).showBubble, true);
  assert.equal(parsePrefs({ mirrorOnLeft: 'true' }).mirrorOnLeft, false);
  assert.equal(parsePrefs({ mirrorOnLeft: true }).mirrorOnLeft, true);
  assert.equal(parsePrefs({ headphoneHintDismissed: 1 }).headphoneHintDismissed, false);
  assert.equal(parsePrefs({ headphoneHintDismissed: true }).headphoneHintDismissed, true);
});

test('序列化来回，坏存档和拒写都不抛', () => {
  const prefs = defaultPrefs();
  prefs.sizePx = 200;
  prefs.showBubble = false;
  prefs.rightGap = 0;
  prefs.mirrorOnLeft = true;
  prefs.headphoneHintDismissed = true;
  prefs.anchor = ANCHOR;
  const raw = serializePrefs(prefs);
  assert.deepEqual(parsePrefs(raw), prefs);

  const mem = new Map<string, string>();
  const storage = {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => { mem.set(key, value); },
  };
  savePrefs(prefs, storage);
  assert.equal(mem.has(PREFS_KEY), true);
  assert.deepEqual(loadPrefs(storage), prefs);

  mem.set(PREFS_KEY, '{');
  assert.deepEqual(loadPrefs(storage), defaultPrefs());
  assert.doesNotThrow(() => {
    savePrefs(prefs, {
      getItem: () => null,
      setItem: () => { throw new Error('denied'); },
    });
  });
});
