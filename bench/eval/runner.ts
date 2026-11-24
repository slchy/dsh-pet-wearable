/**
 * 离线准确率评测跑手：按 v2 `pcm16` 线协议以 20 ms 帧原速向沙盒服务端推流，
 * 按会话隔离收集 `events.jsonl` 与客户端标记，写出 `run-artifact.json`。
 *
 * 关键防假打断纪律（对应 `docs/QOS.md` §6.2 第 3 条）：
 * 服务端下行 PCM 往往比实时快很多（4 秒音频 0.8 秒发完），但 `TurnRunner` 按媒体时长
 * （`bytes / 48 ms`）+ `playbackTailMs` 保持 `speaking`。跑手必须等满媒体播放时长再推
 * 下一句（除非用例显式 `skipQuietWait`），否则会把上一轮自己打断。
 *
 * 用法：
 *   node bench/eval/runner.ts --port 18766 --corpus-dir ~/miai-vectors-synth/eval-v1 --out-dir /tmp/miai-eval/run1
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { join, resolve } from 'node:path';

import { DownstreamFrameType, FrameDecoder, UpstreamFrameType } from '../../src/frame.ts';
import { isMainModule } from '../../src/main.ts';
import { sleep } from '../../src/util.ts';
import { makeFloorNoise } from './synth-corpus.ts';
import type {
  CaseRunTrace,
  EvalCase,
  EvalManifest,
  EvalRunArtifact,
  EvalSessionSpec,
  SessionRunTrace,
} from './types.ts';

const HEADER = 5;
const CHUNK_BYTES = 640; // 20 ms @ 16 kHz mono s16le
const CHUNK_MS = 20;
const DOWNLINK_BYTES_PER_MS = 48; // 24 kHz mono s16le
const PLAYBACK_TAIL_MARGIN_MS = 1000;

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? fallback) : fallback;
}

function encodeFrame(type: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(HEADER);
  head.writeUInt8(type, 0);
  head.writeUInt32LE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

function listDirs(root: string): Set<string> {
  if (!existsSync(root)) return new Set();
  return new Set(
    readdirSync(root).filter((name) => {
      try {
        return statSync(join(root, name)).isDirectory();
      } catch {
        return false;
      }
    }),
  );
}

function countLines(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  const raw = readFileSync(filePath, 'utf8');
  if (raw.trim() === '') return 0;
  return raw.trim().split('\n').length;
}

interface BurstTracker {
  totalBytes: number;
  firstAt: number | null;
  lastAt: number | null;
  burstStartAt: number | null;
  burstBytes: number;
  burstLastAt: number | null;
  calls: string[];
  controls: string[];
}

function resetBurst(t: BurstTracker): void {
  t.burstStartAt = null;
  t.burstBytes = 0;
  t.burstLastAt = null;
}

async function streamPcmRealtime(socket: Socket, pcm: Buffer, onClosed: () => boolean): Promise<number> {
  const t0 = Date.now();
  let sent = 0;
  for (let off = 0; off < pcm.length; off += CHUNK_BYTES) {
    if (onClosed() || socket.destroyed) break;
    const chunk = pcm.subarray(off, Math.min(off + CHUNK_BYTES, pcm.length));
    socket.write(encodeFrame(UpstreamFrameType.Audio, chunk));
    sent += chunk.length;
    const target = t0 + Math.round(((off + chunk.length) / CHUNK_BYTES) * CHUNK_MS);
    const wait = target - Date.now();
    if (wait > 1) await sleep(wait);
  }
  return sent;
}

async function runSession(options: {
  readonly host: string;
  readonly port: number;
  readonly session: EvalSessionSpec;
  readonly corpusDir: string;
  readonly archiveRoot: string;
  readonly dshCallsFile: string;
  readonly bgReportsFile: string;
  readonly connectWarmupMs: number;
}): Promise<SessionRunTrace> {
  const beforeArchives = listDirs(options.archiveRoot);
  const startedAtMs = Date.now();

  const decoder = new FrameDecoder((msg) => {
    console.warn(`[runner] 协议解帧警告（${options.session.id}）：${msg}`);
  }, 16 << 20);
  let closed = false;
  let welcomeReceived = false;
  const tracker: BurstTracker = {
    totalBytes: 0,
    firstAt: null,
    lastAt: null,
    burstStartAt: null,
    burstBytes: 0,
    burstLastAt: null,
    calls: [],
    controls: [],
  };

  const socket = await new Promise<Socket>((resolveConn, rejectConn) => {
    const s = createConnection({ host: options.host, port: options.port });
    s.once('connect', () => { resolveConn(s); });
    s.once('error', (err) => { rejectConn(err); });
  });

  socket.on('close', () => { closed = true; });
  socket.on('error', () => { closed = true; });

  socket.on('data', (chunk: Buffer) => {
    const now = Date.now();
    for (const frame of decoder.push(chunk)) {
      if (frame.type === DownstreamFrameType.Welcome) {
        welcomeReceived = true;
      } else if (frame.type === DownstreamFrameType.Audio) {
        if (tracker.firstAt === null) tracker.firstAt = now;
        tracker.totalBytes += frame.payload.length;
        tracker.lastAt = now;
        if (tracker.burstStartAt === null) tracker.burstStartAt = now;
        tracker.burstBytes += frame.payload.length;
        tracker.burstLastAt = now;
      } else if (frame.type === DownstreamFrameType.Call) {
        tracker.calls.push(frame.payload.toString('utf8'));
      } else if (frame.type === DownstreamFrameType.Control) {
        tracker.controls.push(frame.payload.toString('utf8'));
      }
    }
  });

  // 发送 v2 Hello
  const hello = JSON.stringify({
    proto: 2,
    deviceId: `eval-${options.session.id}`,
    capabilities: { audioIn: 'pcm16', capture: {}, presence: false, power: false },
  });
  socket.write(encodeFrame(UpstreamFrameType.Hello, Buffer.from(hello, 'utf8')));

  const helloDeadline = Date.now() + 5000;
  while (!welcomeReceived && !closed && Date.now() < helloDeadline) {
    await sleep(30);
  }
  if (!welcomeReceived) {
    socket.destroy();
    throw new Error(`[runner] 会话 ${options.session.id} 未收到 Welcome`);
  }

  // 等 Omni 握手 session.update 完成（避免首轮命中 connecting skipped）
  const quietFrame = makeFloorNoise(CHUNK_MS, `quiet:${options.session.id}`);
  const warmUntil = Date.now() + options.connectWarmupMs;
  while (!closed && Date.now() < warmUntil) {
    socket.write(encodeFrame(UpstreamFrameType.Audio, quietFrame));
    await sleep(CHUNK_MS);
  }

  const pingTimer = setInterval(() => {
    if (!closed && !socket.destroyed) {
      socket.write(encodeFrame(UpstreamFrameType.Ping, Buffer.alloc(0)));
    }
  }, 10_000);

  const caseTraces: CaseRunTrace[] = [];

  /** 边推底噪帧边等，确保能量门与静音计时器持续推进 */
  const waitQuiet = async (untilFn: () => boolean, maxMs: number): Promise<void> => {
    const deadline = Date.now() + maxMs;
    while (!closed && Date.now() < deadline && !untilFn()) {
      socket.write(encodeFrame(UpstreamFrameType.Audio, quietFrame));
      await sleep(CHUNK_MS);
    }
  };

  try {
    for (const item of options.session.cases) {
      const pcmPath = join(options.corpusDir, `${item.id}.pcm`);
      if (!existsSync(pcmPath)) {
        throw new Error(`找不到合成语料文件：${pcmPath}`);
      }
      const pcm = readFileSync(pcmPath);

      tracker.totalBytes = 0;
      tracker.firstAt = null;
      tracker.lastAt = null;
      tracker.calls = [];
      tracker.controls = [];
      resetBurst(tracker);

      const dshBefore = countLines(options.dshCallsFile);
      const bgBefore = countLines(options.bgReportsFile);
      const caseStart = Date.now();
      const sentBytes = await streamPcmRealtime(socket, pcm, () => closed);
      const audioDoneAt = Date.now();

      // 1) 等前台首轮音频到达并按媒体时长播完
      const fgTimeoutMs = 9000;
      const fgStartDeadline = audioDoneAt + fgTimeoutMs;
      await waitQuiet(() => {
        const now = Date.now();
        if (tracker.burstStartAt === null) {
          return now >= fgStartDeadline;
        }
        const audioMs = Math.round(tracker.burstBytes / DOWNLINK_BYTES_PER_MS);
        const playEnd = tracker.burstStartAt + audioMs + PLAYBACK_TAIL_MARGIN_MS;
        const rxQuietEnd = (tracker.burstLastAt ?? now) + 1100;
        return now >= Math.max(playEnd, rxQuietEnd);
      }, 25_000);

      // 2) 若需要等后台空窗汇报，继续喂底噪并观测第二波下行音频或 bgReportsFile 更新
      const shouldWaitBg = !item.skipQuietWait && (
        (item.waitBgReportMs ?? 0) > 0
        || item.expectDelegate === 'yes'
        || countLines(options.dshCallsFile) > dshBefore
      );

      if (shouldWaitBg) {
        // 先留 1200 ms 让后台 dsh 调用落盘；如果根本没触发 dsh，不必干等 6 秒
        await waitQuiet(
          () => countLines(options.dshCallsFile) > dshBefore || countLines(options.bgReportsFile) > bgBefore,
          1400,
        );
        if (countLines(options.dshCallsFile) > dshBefore || countLines(options.bgReportsFile) > bgBefore) {
          resetBurst(tracker);
          const bgMax = item.waitBgReportMs ?? 7000;
          const bgWaitStart = Date.now();
          await waitQuiet(() => {
            const now = Date.now();
            if (tracker.burstStartAt === null) {
              // 若已经记录了非 defer 的 bgReport 且超过 1.2s 没音频（例如 silentTts），可提前收
              if (countLines(options.bgReportsFile) > bgBefore && now - bgWaitStart > 1800) {
                return true;
              }
              return now - bgWaitStart >= bgMax;
            }
            const audioMs = Math.round(tracker.burstBytes / DOWNLINK_BYTES_PER_MS);
            const playEnd = tracker.burstStartAt + audioMs + PLAYBACK_TAIL_MARGIN_MS;
            const rxQuietEnd = (tracker.burstLastAt ?? now) + 1200;
            return now >= Math.max(playEnd, rxQuietEnd);
          }, bgMax + 15_000);
        }
      } else if (item.skipQuietWait) {
        // 故意不等 800 ms 空窗，稍留 250 ms 就推下一句，压出 unspoken / defer 路径
        await waitQuiet(() => false, 250);
      } else {
        // 常规单轮之间留 800 ms 干净空窗，让 gate.close 落档
        await waitQuiet(() => false, 800);
      }

      const finishedAt = Date.now();
      caseTraces.push({
        caseId: item.id,
        sessionId: options.session.id,
        startedAtMs: caseStart,
        audioDoneAtMs: audioDoneAt,
        finishedAtMs: finishedAt,
        sentBytes,
        downlinkBytes: tracker.totalBytes,
        downlinkFirstAtMs: tracker.firstAt,
        callsReceived: [...tracker.calls],
        controlsReceived: [...tracker.controls],
      });

      const firstMs = tracker.firstAt === null ? '—' : `${tracker.firstAt - audioDoneAt}ms`;
      const dshDelta = countLines(options.dshCallsFile) - dshBefore;
      console.log(
        `[runner] ${options.session.id}/${item.id.padEnd(10)} down=${String(tracker.totalBytes).padStart(7)} B  dsh+${dshDelta}  dt=${firstMs}`,
      );
    }
  } finally {
    clearInterval(pingTimer);
    if (!socket.destroyed) {
      socket.end();
    }
  }

  // 等待服务端 SessionArchive 写完 close 事件
  await sleep(700);
  const afterArchives = listDirs(options.archiveRoot);
  const created = [...afterArchives].filter((name) => !beforeArchives.has(name)).sort();
  const archiveDir = created.length > 0 ? join(options.archiveRoot, created[created.length - 1]!) : null;

  return {
    sessionId: options.session.id,
    suite: options.session.suite,
    archiveDir,
    startedAtMs,
    finishedAtMs: Date.now(),
    cases: caseTraces,
  };
}

function selectSessions(manifest: EvalManifest, only: string): EvalSessionSpec[] {
  if (!only.trim()) return [...manifest.sessions];
  const tokens = new Set(only.split(',').map((t) => t.trim()).filter(Boolean));
  return manifest.sessions.filter(
    (s) => tokens.has(s.id) || tokens.has(s.suite) || s.cases.some((c) => tokens.has(c.id)),
  );
}

async function main(): Promise<void> {
  const host = arg('host', '127.0.0.1');
  const port = Number(arg('port', '18766'));
  const manifestPath = resolve(arg('manifest', 'bench/eval/manifest.json'));
  const corpusDir = resolve(arg('corpus-dir', 'bench/eval/out/corpus'));
  const outDir = resolve(arg('out-dir', 'bench/eval/out/run'));
  const pipeline = (arg('pipeline', 'live') === 'cascade' ? 'cascade' : 'live') as 'live' | 'cascade';
  const backend = (arg('backend', 'stub') === 'real-dsh' ? 'real-dsh' : 'stub') as 'stub' | 'real-dsh';
  const only = arg('only', '');
  const connectWarmupMs = Number(arg('warmup-ms', '1800'));

  mkdirSync(outDir, { recursive: true });
  const archiveRoot = join(outDir, 'archives');
  const dshCallsFile = join(outDir, 'dsh-calls.jsonl');
  const bgReportsFile = join(outDir, 'bg-reports.jsonl');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as EvalManifest;

  const sessionsToRun = selectSessions(manifest, only);
  if (sessionsToRun.length === 0) {
    console.error(`--only ${only} 没匹配到任何会话`);
    process.exit(2);
  }

  const now = new Date();
  const hourCst = (now.getUTCHours() + 8) % 24;
  const runId = `${now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${pipeline}`;

  console.log(
    `[runner] 开始评测 ${runId}（${sessionsToRun.length} 个会话，${sessionsToRun.reduce((n, s) => n + s.cases.length, 0)} 轮，CST ${hourCst} 时）`,
  );

  const sessionTraces: SessionRunTrace[] = [];
  for (const session of sessionsToRun) {
    console.log(`\n--- 会话 ${session.id}：${session.title} ---`);
    const trace = await runSession({
      host,
      port,
      session,
      corpusDir,
      archiveRoot,
      dshCallsFile,
      bgReportsFile,
      connectWarmupMs,
    });
    sessionTraces.push(trace);
    await sleep(500);
  }

  const artifact: EvalRunArtifact = {
    version: manifest.version,
    runId,
    startedAt: now.toISOString(),
    hourCst,
    pipeline,
    backend,
    corpusDir,
    archiveRoot,
    dshCallsFile,
    bgReportsFile,
    sessions: sessionTraces,
  };

  const artifactPath = join(outDir, 'run-artifact.json');
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(`\n[runner] 全部完成 → ${artifactPath}`);
}

if (isMainModule(process.argv[1], import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`[runner] 失败: ${(err as Error).message}`);
    process.exit(1);
  });
}
