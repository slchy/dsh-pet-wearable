/**
 * 语音主管道的启动期选择：`live` 与 `cascade` 必须互斥，不能装成开了其实没开。
 *
 * 这些用例防的是同一类静默降级：
 * - 显式 `live` 缺 key 或 STT 不对，却照样启动（用户听不到声音）
 * - 显式 `live` 仍把文本快车道的 key 留下，两条管道混跑
 * - 显式 `cascade` 被旧的 `OMNI_ANSWER=full` 偷偷改成发声
 * - 只读探针在不该挂的时候挂上，或者 cascade 下该挂的测量被关掉
 * - `VOICE_PIPELINE` 没写时，旧环境变量推断错边
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveVoicePipeline, resolveVoicePipelineFromEnv } from '../src/pipeline-mode.ts';
import type { PipelinePlan } from '../src/pipeline-mode.ts';

const LIVE_NOTE = '纯 live 模式：不加载文本级联快车道（FastLlmClient / PrefetchSlot 已禁用）';
const CASCADE_NOTE = '显式 VOICE_PIPELINE=cascade：忽略 OMNI_ANSWER，不接管发声';

const EMPTY_CASCADE: PipelinePlan = {
  mode: 'cascade',
  useOmniPlayback: false,
  useOmniProbeOnly: false,
  useCascadeFastLane: false,
  cascadeKey: '',
  explicit: false,
  notes: [],
};

test('显式 live：DashScope key + qwen-realtime', () => {
  const plan = resolveVoicePipeline({
    explicit: 'live',
    omniKey: 'dash-test-key',
    sttName: 'qwen-realtime',
  });
  assert.deepEqual(plan, {
    mode: 'live',
    useOmniPlayback: true,
    useOmniProbeOnly: false,
    useCascadeFastLane: false,
    cascadeKey: '',
    explicit: true,
    notes: [],
  });
});

test('显式 live 与快车道互斥，即使同时给了 fastKey', () => {
  const plan = resolveVoicePipeline({
    explicit: 'live',
    omniKey: 'dash-test-key',
    sttName: 'qwen-realtime',
    fastKey: 'fast-test-key',
    omniShadow: true,
    omniAnswer: 'full',
  });
  assert.equal(plan.mode, 'live');
  assert.equal(plan.useOmniPlayback, true);
  assert.equal(plan.useOmniProbeOnly, false);
  assert.equal(plan.useCascadeFastLane, false);
  assert.equal(plan.cascadeKey, '');
  assert.equal(plan.explicit, true);
  assert.deepEqual(plan.notes, [LIVE_NOTE]);
});

test('显式 live 在快车道本来就关着时不额外记互斥说明', () => {
  const plan = resolveVoicePipeline({
    explicit: 'live',
    omniKey: 'dash-test-key',
    sttName: 'qwen-realtime',
    fastOff: true,
    fastKey: 'fast-test-key',
  });
  assert.equal(plan.useCascadeFastLane, false);
  assert.equal(plan.cascadeKey, '');
  assert.deepEqual(plan.notes, []);
});

test('显式 live 缺 key 直接失败，空白 key 同样算缺', () => {
  assert.throws(
    () => resolveVoicePipeline({ explicit: 'live', sttName: 'qwen-realtime' }),
    /VOICE_PIPELINE=live 需要 OMNI_API_KEY 或 DASHSCOPE_API_KEY/,
  );
  assert.throws(
    () => resolveVoicePipeline({ explicit: 'live', omniKey: '   ', sttName: 'qwen-realtime' }),
    /VOICE_PIPELINE=live 需要 OMNI_API_KEY 或 DASHSCOPE_API_KEY/,
  );
});

test('显式 live 缺 key 时先报 key，不把 STT 错误盖过去', () => {
  assert.throws(
    () => resolveVoicePipeline({ explicit: 'live', sttName: 'aliyun' }),
    /OMNI_API_KEY 或 DASHSCOPE_API_KEY/,
  );
});

test('显式 live 的 STT 必须支持手动封段（内置 qwen-realtime / openai-realtime 或插件能力位）', () => {
  assert.throws(
    () => resolveVoicePipeline({
      explicit: 'live',
      omniKey: 'dash-test-key',
      sttName: 'aliyun',
    }),
    /VOICE_PIPELINE=live 需要支持手动封段的 STT.*当前是 aliyun/,
  );

  const openAiPlan = resolveVoicePipeline({
    explicit: 'live',
    omniKey: 'openai-test-key',
    sttName: 'openai-realtime',
  });
  assert.equal(openAiPlan.mode, 'live');
  assert.equal(openAiPlan.useOmniPlayback, true);

  const pluginPlan = resolveVoicePipeline({
    explicit: 'live',
    omniKey: 'custom-key',
    sttName: './my-manual-asr.mjs',
    sttSupportsManualEndpoint: true,
  });
  assert.equal(pluginPlan.mode, 'live');
  assert.equal(pluginPlan.useOmniPlayback, true);

  assert.throws(
    () => resolveVoicePipeline({
      explicit: 'live',
      omniKey: 'dash-test-key',
      sttName: 'qwen-realtime',
      sttSupportsManualEndpoint: false,
    }),
    /当前是 qwen-realtime/,
  );
});

test('显式 live 没传 sttName 时不因为缺省拦截', () => {
  const plan = resolveVoicePipeline({ explicit: 'live', omniKey: 'dash-test-key' });
  assert.equal(plan.mode, 'live');
  assert.equal(plan.useOmniPlayback, true);
  assert.equal(plan.explicit, true);
});

test('strict: false 允许离线测试在没有 key 的情况下走 live', () => {
  const plan = resolveVoicePipeline({ explicit: 'live', strict: false });
  assert.deepEqual(plan, {
    mode: 'live',
    useOmniPlayback: true,
    useOmniProbeOnly: false,
    useCascadeFastLane: false,
    cascadeKey: '',
    explicit: true,
    notes: [],
  });

  const wrongStt = resolveVoicePipeline({
    explicit: 'live',
    strict: false,
    sttName: 'aliyun',
  });
  assert.equal(wrongStt.mode, 'live');
  assert.equal(wrongStt.useOmniPlayback, true);
  assert.equal(wrongStt.explicit, true);
});

test('显式 cascade：有 fastKey 且未关闭时启用快车道', () => {
  const plan = resolveVoicePipeline({
    explicit: 'cascade',
    fastKey: 'fast-test-key',
  });
  assert.deepEqual(plan, {
    mode: 'cascade',
    useOmniPlayback: false,
    useOmniProbeOnly: false,
    useCascadeFastLane: true,
    cascadeKey: 'fast-test-key',
    explicit: true,
    notes: [],
  });
});

test('显式 cascade 忽略 OMNI_ANSWER=full，不接管发声', () => {
  const plan = resolveVoicePipeline({
    explicit: 'cascade',
    omniShadow: true,
    omniAnswer: 'full',
    omniKey: 'dash-test-key',
    sttName: 'qwen-realtime',
    fastKey: 'fast-test-key',
  });
  assert.deepEqual(plan, {
    mode: 'cascade',
    useOmniPlayback: false,
    useOmniProbeOnly: false,
    useCascadeFastLane: true,
    cascadeKey: 'fast-test-key',
    explicit: true,
    notes: [CASCADE_NOTE],
  });
});

test('显式 cascade 对 clip 和大写 FULL 同样忽略接管', () => {
  for (const omniAnswer of ['clip', 'FULL', ' Full ']) {
    const plan = resolveVoicePipeline({
      explicit: 'cascade',
      omniShadow: true,
      omniAnswer,
      omniKey: 'dash-test-key',
      sttName: 'qwen-realtime',
    });
    assert.equal(plan.mode, 'cascade', omniAnswer);
    assert.equal(plan.useOmniPlayback, false, omniAnswer);
    assert.equal(plan.useOmniProbeOnly, false, omniAnswer);
    assert.equal(plan.explicit, true, omniAnswer);
    assert.deepEqual(plan.notes, [CASCADE_NOTE], omniAnswer);
  }
});

test('显式 cascade 在 OMNI_ANSWER=off 时仍可挂只读探针', () => {
  const plan = resolveVoicePipeline({
    explicit: 'cascade',
    omniShadow: true,
    omniAnswer: 'off',
    omniKey: 'dash-test-key',
    sttName: 'qwen-realtime',
    fastKey: 'fast-test-key',
  });
  assert.deepEqual(plan, {
    mode: 'cascade',
    useOmniPlayback: false,
    useOmniProbeOnly: true,
    useCascadeFastLane: true,
    cascadeKey: 'fast-test-key',
    explicit: true,
    notes: [],
  });
});

test('只读探针缺影子、缺 key，或 STT 不是 qwen-realtime 时不挂', () => {
  const noShadow = resolveVoicePipeline({
    explicit: 'cascade',
    omniAnswer: 'off',
    omniKey: 'dash-test-key',
    sttName: 'qwen-realtime',
  });
  assert.equal(noShadow.useOmniProbeOnly, false);

  const noKey = resolveVoicePipeline({
    explicit: 'cascade',
    omniShadow: true,
    omniAnswer: 'off',
    sttName: 'qwen-realtime',
  });
  assert.equal(noKey.useOmniProbeOnly, false);

  const blankKey = resolveVoicePipeline({
    explicit: 'cascade',
    omniShadow: true,
    omniAnswer: 'off',
    omniKey: '   ',
    sttName: 'qwen-realtime',
  });
  assert.equal(blankKey.useOmniProbeOnly, false);

  const wrongStt = resolveVoicePipeline({
    explicit: 'cascade',
    omniShadow: true,
    omniAnswer: 'off',
    omniKey: 'dash-test-key',
    sttName: 'aliyun',
  });
  assert.equal(wrongStt.useOmniProbeOnly, false);
  assert.equal(wrongStt.useOmniPlayback, false);
});

test('cascade 在 fastOff 或空 fastKey 时不开快车道', () => {
  const closed = resolveVoicePipeline({
    explicit: 'cascade',
    fastOff: true,
    fastKey: 'fast-test-key',
  });
  assert.equal(closed.mode, 'cascade');
  assert.equal(closed.useOmniPlayback, false);
  assert.equal(closed.useCascadeFastLane, false);
  assert.equal(closed.cascadeKey, '');

  const empty = resolveVoicePipeline({ explicit: 'cascade', fastKey: '' });
  assert.equal(empty.useCascadeFastLane, false);
  assert.equal(empty.cascadeKey, '');

  const blank = resolveVoicePipeline({ explicit: 'cascade', fastKey: '   ' });
  assert.equal(blank.useCascadeFastLane, false);
  assert.equal(blank.cascadeKey, '');
});

test('cascade 的 fastKey 会去掉首尾空白', () => {
  const plan = resolveVoicePipeline({
    explicit: 'cascade',
    fastKey: '  fast-test-key  ',
  });
  assert.equal(plan.useCascadeFastLane, true);
  assert.equal(plan.cascadeKey, 'fast-test-key');
});

test('无效的 VOICE_PIPELINE 直接失败', () => {
  for (const explicit of ['hybrid', 'omni']) {
    assert.throws(
      () => resolveVoicePipeline({ explicit, omniKey: 'dash-test-key', fastKey: 'fast-test-key' }),
      new RegExp(`VOICE_PIPELINE 无效值 "${explicit}"：只允许 "live" 或 "cascade"`),
    );
  }
  assert.throws(
    () => resolveVoicePipeline({ explicit: ' hybrid ' }),
    /VOICE_PIPELINE 无效值 " hybrid "：只允许 "live" 或 "cascade"/,
  );
});

test('显式开关忽略大小写和首尾空白', () => {
  const live = resolveVoicePipeline({
    explicit: '  LIVE ',
    omniKey: 'dash-test-key',
    sttName: 'qwen-realtime',
  });
  assert.equal(live.mode, 'live');
  assert.equal(live.explicit, true);

  const cascade = resolveVoicePipeline({
    explicit: ' Cascade ',
    fastKey: 'fast-test-key',
  });
  assert.equal(cascade.mode, 'cascade');
  assert.equal(cascade.explicit, true);
  assert.equal(cascade.useCascadeFastLane, true);
});

test('未设 VOICE_PIPELINE：影子 + full/clip 推断 live', () => {
  for (const omniAnswer of ['full', 'clip', 'FULL']) {
    const plan = resolveVoicePipeline({
      omniShadow: true,
      omniAnswer,
      omniKey: 'dash-test-key',
      sttName: 'qwen-realtime',
    });
    assert.equal(plan.mode, 'live', omniAnswer);
    assert.equal(plan.explicit, false, omniAnswer);
    assert.equal(plan.useOmniPlayback, true, omniAnswer);
    assert.equal(plan.useOmniProbeOnly, false, omniAnswer);
    assert.equal(plan.useCascadeFastLane, false, omniAnswer);
    assert.equal(plan.cascadeKey, '', omniAnswer);
    assert.deepEqual(plan.notes, [], omniAnswer);
  }
});

test('推断出来的 live 同样不加载快车道', () => {
  const plan = resolveVoicePipeline({
    omniShadow: true,
    omniAnswer: 'full',
    omniKey: 'dash-test-key',
    sttName: 'qwen-realtime',
    fastKey: 'fast-test-key',
  });
  assert.equal(plan.mode, 'live');
  assert.equal(plan.explicit, false);
  assert.equal(plan.useCascadeFastLane, false);
  assert.equal(plan.cascadeKey, '');
  assert.deepEqual(plan.notes, [LIVE_NOTE]);
});

test('未设 VOICE_PIPELINE：影子 + off 推断 cascade，并打开只读探针', () => {
  const plan = resolveVoicePipeline({
    omniShadow: true,
    omniAnswer: 'off',
    omniKey: 'dash-test-key',
    sttName: 'qwen-realtime',
  });
  assert.deepEqual(plan, {
    mode: 'cascade',
    useOmniPlayback: false,
    useOmniProbeOnly: true,
    useCascadeFastLane: false,
    cascadeKey: '',
    explicit: false,
    notes: [],
  });
});

test('没写 OMNI_ANSWER 时按 off 处理，有 key 的影子旁路只做探针', () => {
  const plan = resolveVoicePipeline({
    omniShadow: true,
    omniKey: 'dash-test-key',
  });
  assert.equal(plan.mode, 'cascade');
  assert.equal(plan.explicit, false);
  assert.equal(plan.useOmniPlayback, false);
  assert.equal(plan.useOmniProbeOnly, true);
});

test('什么都没设，或显式开关是空白：推断 cascade', () => {
  assert.deepEqual(resolveVoicePipeline({}), EMPTY_CASCADE);
  assert.deepEqual(resolveVoicePipeline({ explicit: '' }), EMPTY_CASCADE);
  assert.deepEqual(resolveVoicePipeline({ explicit: '   ' }), EMPTY_CASCADE);
});

test('推断 live 时缺 key 同样失败', () => {
  assert.throws(
    () => resolveVoicePipeline({ omniShadow: true, omniAnswer: 'full' }),
    /VOICE_PIPELINE=live 需要 OMNI_API_KEY 或 DASHSCOPE_API_KEY/,
  );
});

test('resolveVoicePipelineFromEnv：显式 live 吃大小写、空白，并丢掉快车道 key', () => {
  const plan = resolveVoicePipelineFromEnv({
    VOICE_PIPELINE: '  LiVe ',
    DASHSCOPE_API_KEY: '  dash-key  ',
    FAST_LANE_API_KEY: '  fast-key  ',
    DEEPSEEK_API_KEY: 'deep-key',
    OMNI_SHADOW: '1',
    OMNI_ANSWER: 'full',
  }, { sttName: 'qwen-realtime' });
  assert.deepEqual(plan, {
    mode: 'live',
    useOmniPlayback: true,
    useOmniProbeOnly: false,
    useCascadeFastLane: false,
    cascadeKey: '',
    explicit: true,
    notes: [LIVE_NOTE],
  });
});

test('resolveVoicePipelineFromEnv：只有空白的 key 等于没有 key', () => {
  assert.throws(
    () => resolveVoicePipelineFromEnv({
      VOICE_PIPELINE: 'live',
      DASHSCOPE_API_KEY: '   ',
    }),
    /OMNI_API_KEY 或 DASHSCOPE_API_KEY/,
  );
  assert.throws(
    () => resolveVoicePipelineFromEnv({
      VOICE_PIPELINE: 'LIVE',
      OMNI_API_KEY: '   ',
      DASHSCOPE_API_KEY: 'dash-key',
    }, { sttName: 'qwen-realtime' }),
    /OMNI_API_KEY 或 DASHSCOPE_API_KEY/,
  );
});

test('resolveVoicePipelineFromEnv：OMNI_API_KEY 优先，缺省才用 DASHSCOPE_API_KEY', () => {
  const omni = resolveVoicePipelineFromEnv({
    VOICE_PIPELINE: 'live',
    OMNI_API_KEY: 'omni-key',
  }, { sttName: 'qwen-realtime' });
  assert.equal(omni.mode, 'live');

  const dash = resolveVoicePipelineFromEnv({
    VOICE_PIPELINE: 'live',
    DASHSCOPE_API_KEY: 'dash-key',
  }, { sttName: 'qwen-realtime' });
  assert.equal(dash.mode, 'live');
});

test('resolveVoicePipelineFromEnv：未写 VOICE_PIPELINE 时按旧档位推断', () => {
  const live = resolveVoicePipelineFromEnv({
    OMNI_SHADOW: '1',
    OMNI_ANSWER: '  FuLl ',
    DASHSCOPE_API_KEY: '  dash-key  ',
    FAST_LANE_API_KEY: ' fast-key ',
  }, { sttName: 'qwen-realtime' });
  assert.equal(live.mode, 'live');
  assert.equal(live.explicit, false);
  assert.equal(live.useOmniPlayback, true);
  assert.equal(live.useOmniProbeOnly, false);
  assert.equal(live.useCascadeFastLane, false);
  assert.equal(live.cascadeKey, '');
  assert.deepEqual(live.notes, [LIVE_NOTE]);

  const probe = resolveVoicePipelineFromEnv({
    OMNI_SHADOW: '1',
    OMNI_ANSWER: '  OFF ',
    OMNI_API_KEY: '  omni-key  ',
    DEEPSEEK_API_KEY: '  deep-key  ',
  }, { sttName: 'qwen-realtime' });
  assert.deepEqual(probe, {
    mode: 'cascade',
    useOmniPlayback: false,
    useOmniProbeOnly: true,
    useCascadeFastLane: true,
    cascadeKey: 'deep-key',
    explicit: false,
    notes: [],
  });

  assert.deepEqual(resolveVoicePipelineFromEnv({}), EMPTY_CASCADE);
  assert.deepEqual(resolveVoicePipelineFromEnv({ VOICE_PIPELINE: '   ' }), EMPTY_CASCADE);
});

test('resolveVoicePipelineFromEnv：FAST_LANE_API_KEY 优先于 DEEPSEEK_API_KEY', () => {
  const preferred = resolveVoicePipelineFromEnv({
    VOICE_PIPELINE: 'cascade',
    FAST_LANE_API_KEY: '  fast-key  ',
    DEEPSEEK_API_KEY: 'deep-key',
  });
  assert.equal(preferred.useCascadeFastLane, true);
  assert.equal(preferred.cascadeKey, 'fast-key');

  const fallback = resolveVoicePipelineFromEnv({
    VOICE_PIPELINE: 'CASCADE',
    DEEPSEEK_API_KEY: '  deep-key  ',
  });
  assert.equal(fallback.mode, 'cascade');
  assert.equal(fallback.explicit, true);
  assert.equal(fallback.cascadeKey, 'deep-key');
});

test('resolveVoicePipelineFromEnv：空的 FAST_LANE_API_KEY 不会退到 DEEPSEEK_API_KEY', () => {
  const plan = resolveVoicePipelineFromEnv({
    VOICE_PIPELINE: 'cascade',
    FAST_LANE_API_KEY: '   ',
    DEEPSEEK_API_KEY: 'deep-key',
  });
  assert.equal(plan.useCascadeFastLane, false);
  assert.equal(plan.cascadeKey, '');
});

test('resolveVoicePipelineFromEnv：只有 FAST_LANE=0 才关掉快车道', () => {
  const off = resolveVoicePipelineFromEnv({
    VOICE_PIPELINE: 'cascade',
    FAST_LANE: '0',
    FAST_LANE_API_KEY: 'fast-key',
    OMNI_SHADOW: '1',
    OMNI_ANSWER: 'off',
    DASHSCOPE_API_KEY: 'dash-key',
  }, { sttName: 'qwen-realtime' });
  assert.equal(off.mode, 'cascade');
  assert.equal(off.useCascadeFastLane, false);
  assert.equal(off.cascadeKey, '');
  assert.equal(off.useOmniProbeOnly, true);
  assert.equal(off.useOmniPlayback, false);

  const on = resolveVoicePipelineFromEnv({
    VOICE_PIPELINE: 'cascade',
    FAST_LANE: 'false',
    FAST_LANE_API_KEY: 'fast-key',
  });
  assert.equal(on.useCascadeFastLane, true);
  assert.equal(on.cascadeKey, 'fast-key');
});

test('resolveVoicePipelineFromEnv：OMNI_SHADOW 只有精确的 1 才算开', () => {
  const ignored = resolveVoicePipelineFromEnv({
    OMNI_SHADOW: 'true',
    OMNI_ANSWER: 'full',
    DASHSCOPE_API_KEY: 'dash-key',
  }, { sttName: 'qwen-realtime' });
  assert.equal(ignored.mode, 'cascade');
  assert.equal(ignored.explicit, false);
  assert.equal(ignored.useOmniPlayback, false);
  assert.equal(ignored.useOmniProbeOnly, false);

  const spaced = resolveVoicePipelineFromEnv({
    OMNI_SHADOW: ' 1',
    OMNI_ANSWER: 'off',
    OMNI_API_KEY: 'omni-key',
  }, { sttName: 'qwen-realtime' });
  assert.equal(spaced.useOmniProbeOnly, false);
});

test('resolveVoicePipelineFromEnv：无效值、strict 与 sttName 照原样往下传', () => {
  assert.throws(
    () => resolveVoicePipelineFromEnv({ VOICE_PIPELINE: 'hybrid' }),
    /VOICE_PIPELINE 无效值 "hybrid"：只允许 "live" 或 "cascade"/,
  );
  assert.throws(
    () => resolveVoicePipelineFromEnv({ VOICE_PIPELINE: 'omni' }),
    /VOICE_PIPELINE 无效值 "omni"/,
  );

  const offline = resolveVoicePipelineFromEnv(
    { VOICE_PIPELINE: 'live' },
    { strict: false, sttName: 'aliyun' },
  );
  assert.equal(offline.mode, 'live');
  assert.equal(offline.explicit, true);
  assert.equal(offline.useOmniPlayback, true);

  assert.throws(
    () => resolveVoicePipelineFromEnv(
      { VOICE_PIPELINE: 'live', DASHSCOPE_API_KEY: 'dash-key' },
      { sttName: 'aliyun' },
    ),
    /当前是 aliyun/,
  );
});

test('从环境推断 live 时缺 key 同样失败', () => {
  assert.throws(
    () => resolveVoicePipelineFromEnv({
      OMNI_SHADOW: '1',
      OMNI_ANSWER: 'full',
    }),
    /OMNI_API_KEY 或 DASHSCOPE_API_KEY/,
  );
});

test('resolveVoicePipelineFromEnv：支持 LIVE_API_KEY 与 OpenAI 方言下的 OPENAI_API_KEY', () => {
  const neutral = resolveVoicePipelineFromEnv(
    { VOICE_PIPELINE: 'live', LIVE_API_KEY: '  live-key  ' },
    { sttName: 'openai-realtime' },
  );
  assert.equal(neutral.mode, 'live');
  assert.equal(neutral.useOmniPlayback, true);

  const openAi = resolveVoicePipelineFromEnv(
    { VOICE_PIPELINE: 'live', LIVE_DIALECT: 'openai-ga', OPENAI_API_KEY: 'sk-openai-test' },
    { sttName: 'openai-realtime' },
  );
  assert.equal(openAi.mode, 'live');
  assert.equal(openAi.useOmniPlayback, true);

  // 未切 OpenAI 方言时，OPENAI_API_KEY 不会误当成 DashScope key
  assert.throws(
    () => resolveVoicePipelineFromEnv(
      { VOICE_PIPELINE: 'live', OPENAI_API_KEY: 'sk-openai-test' },
      { sttName: 'qwen-realtime' },
    ),
    /OMNI_API_KEY 或 DASHSCOPE_API_KEY/,
  );

  // 显式支持手动封段的自定义插件也可挂只读探针
  const probe = resolveVoicePipelineFromEnv(
    { OMNI_SHADOW: '1', OMNI_ANSWER: 'off', LIVE_API_KEY: 'k' },
    { sttName: './custom-asr.mjs', sttSupportsManualEndpoint: true },
  );
  assert.equal(probe.useOmniProbeOnly, true);
});
