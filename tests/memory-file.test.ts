/**
 * 长期记忆的只读视图（`MEMORY.md`）。
 *
 * 关键约定：**写权限只在 L2（dsh 的 `remember` 工具）**，快车道只读。
 * 所以这里只测两件事 —— 能不能正确解析，和「挑几条」挑得对不对。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { MemoryFile } from '../src/memory-file.ts';

const HEADER = '# 长期记忆\n\n这一行之下每行一条，越新越靠下。\n';

function withFile(content: string, run: (file: MemoryFile) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  const file = join(dir, 'MEMORY.md');
  writeFileSync(file, content, 'utf8');
  try {
    run(new MemoryFile(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('解析：只认 `- ` 开头的条目，并去掉日期前缀', () => {
  withFile(
    `${HEADER}- 2026-11-16 23:08 · 哥姓袁，称呼袁哥。\n- 哥住在杭州。\n`,
    (mem) => {
      assert.deepEqual(mem.entries(), ['哥姓袁，称呼袁哥。', '哥住在杭州。']);
    },
  );
});

test('文件不存在就当没有记忆，不抛', () => {
  const mem = new MemoryFile(join(tmpdir(), '绝对不存在的记忆.md'));
  assert.deepEqual(mem.entries(), []);
  assert.deepEqual(mem.relevant('我叫什么'), []);
});

test('相关的那条排前面', () => {
  withFile(
    `${HEADER}- 哥姓袁，称呼袁哥。\n- 哥住在杭州。\n- 哥每天十一点睡。\n`,
    (mem) => {
      assert.deepEqual(mem.relevant('我住在哪来着'), ['哥住在杭州。']);
    },
  );
});

test('一条都不沾边时给最近两条（宁可多给，别让模型说不知道）', () => {
  withFile(
    `${HEADER}- 哥姓袁，称呼袁哥。\n- 哥住在杭州。\n- 哥每天十一点睡。\n`,
    (mem) => {
      assert.deepEqual(mem.relevant('我有点困了'), ['哥住在杭州。', '哥每天十一点睡。']);
    },
  );
});

test('文件改了要能读到新的（按 mtime 缓存，不能缓存一辈子）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  const path = join(dir, 'MEMORY.md');
  try {
    writeFileSync(path, `${HEADER}- 哥住在杭州。\n`, 'utf8');
    const mem = new MemoryFile(path);
    assert.deepEqual(mem.entries(), ['哥住在杭州。']);

    writeFileSync(path, `${HEADER}- 哥住在杭州。\n- 哥养了只橘猫。\n`, 'utf8');
    // 有些文件系统的 mtime 精度是秒，等一下确保变了
    const now = Date.now() + 5;
    while (Date.now() < now) { /* 空转几毫秒 */ }
    assert.equal(mem.entries().length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 实测漏召回的那 5 条：问名字时 2-gram 只蹭到橘猫，姓名和过敏史都掉了。 */
const SMALL_MEMORY = [
  '- 2026-11-20 10:00 · 用户叫陈默，住在成都高新区',
  '- 2026-11-20 10:01 · 用户对花生严重过敏，点餐和推荐食物一定要避开花生',
  '- 2026-11-20 10:02 · 用户养了一只橘猫，名字叫团子',
  '- 2026-11-20 10:03 · 用户最常连的测试网关端口是 9420',
  '- 2026-11-20 10:04 · 用户最喜欢的科幻作家是波兰的莱姆',
].join('\n');

test('小记忆库未传 k：相关的排前，且不因默认 3 条裁掉姓名和过敏', () => {
  withFile(`${HEADER}${SMALL_MEMORY}\n`, (mem) => {
    const got = mem.relevant('还记得我叫什么名字？');
    assert.equal(got.length, 5);
    assert.ok(got[0]?.includes('陈默'));
    const cat = got.findIndex((line) => line.includes('团子'));
    const allergy = got.findIndex((line) => line.includes('花生'));
    assert.ok(cat > 0);
    assert.ok(allergy > cat);
  });
});

test('显式传入 k 时仍然只取前 k 条', () => {
  withFile(`${HEADER}${SMALL_MEMORY}\n`, (mem) => {
    const got = mem.relevant('还记得我叫什么名字？', 2);
    assert.deepEqual(got, [
      '用户叫陈默，住在成都高新区',
      '用户养了一只橘猫，名字叫团子',
    ]);
  });
});

test('大记忆库靠词簇召回姓名、住址和过敏', () => {
  const fillers = [
    '螺丝刀放在抽屉里',
    '会议室在二楼尽头',
    '蓝色水杯已经空了',
    '门口挂着一串钥匙',
    '雨伞塞在车座下面',
    '笔记本这周写满了',
    '充电器一直在包里',
  ];
  const body = [
    '- 用户叫陈默，住在成都高新区',
    '- 用户对花生严重过敏，点餐和推荐食物一定要避开花生',
    '- 用户养了一只橘猫，名字叫团子',
    ...fillers.map((line) => `- ${line}`),
  ].join('\n');
  withFile(`${HEADER}${body}\n`, (mem) => {
    const name = mem.relevant('还记得我叫什么名字？');
    assert.ok(name.length <= 3);
    const nameAt = name.findIndex((line) => line.includes('陈默'));
    const catAt = name.findIndex((line) => line.includes('团子'));
    assert.ok(nameAt >= 0 && catAt >= 0 && nameAt < catAt);

    const home = mem.relevant('我住在哪个城市？');
    assert.ok(home.length <= 3);
    assert.ok(home[0]?.includes('成都'));

    const food = mem.relevant('我想点份宫保鸡丁，你觉得合适吗？');
    assert.ok(food.length <= 3);
    assert.ok(food[0]?.includes('过敏'));
  });
});

test('条目又多又长时不再整份返回', () => {
  const lines = [
    ...Array.from({ length: 7 }, (_, i) => `- 备忘${i}${'无'.repeat(70)}`),
    `- 用户叫陈默${'无'.repeat(70)}`,
  ];
  withFile(`${HEADER}${lines.join('\n')}\n`, (mem) => {
    const got = mem.relevant('我叫什么名字');
    assert.equal(got.length, 1);
    assert.ok(got[0]?.includes('陈默'));
  });
});

test('summary 逐行短横线，超长就停在字数内', () => {
  withFile(`${HEADER}- 哥姓袁，称呼袁哥。\n- 哥住在杭州。\n`, (mem) => {
    const full = '- 哥姓袁，称呼袁哥。\n- 哥住在杭州。';
    assert.equal(mem.summary(), full);
    assert.equal(mem.summary(0), '');
    const first = '- 哥姓袁，称呼袁哥。';
    assert.equal(mem.summary(first.length), first);
    assert.equal(mem.summary(first.length + 1), first);
    assert.equal(mem.summary(1), '-');
    assert.ok(mem.summary(full.length) === full);
    assert.ok(mem.summary(4).length <= 4);
  });
});

test('hotwordHints 去掉日期前缀后用空格拼接', () => {
  withFile(`${HEADER}${SMALL_MEMORY}\n`, (mem) => {
    const hints = mem.hotwordHints();
    assert.equal(hints, mem.entries().join(' '));
    assert.ok(hints.includes('陈默'));
    assert.ok(hints.includes('9420'));
    assert.ok(hints.includes('莱姆'));
    assert.equal(hints.includes('2026-11-20'), false);
    assert.ok(hints.length <= 400);
    const first = mem.entries()[0] ?? '';
    assert.equal(mem.hotwordHints(first.length + 1), first);
    assert.equal(mem.hotwordHints(0), '');
    assert.ok(mem.hotwordHints(4).length <= 4);
  });
});

test('没有记忆时摘要和热词是空串', () => {
  const mem = new MemoryFile(join(tmpdir(), '绝对不存在的记忆-摘要.md'));
  assert.equal(mem.summary(), '');
  assert.equal(mem.hotwordHints(), '');
  assert.equal(mem.summary(10), '');
});
