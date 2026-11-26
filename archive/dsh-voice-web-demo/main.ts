/**
 * 页面逻辑：开始/结束、电平条、立即静音、回声余量测量、日志。
 *
 * 桥把本页和 WS 发在同一个端口，所以地址直接从 `location` 推出来 —— 换机器、
 * 换端口、上 TLS 都不用改代码。
 *
 * 构建：`npm run demo:build`（esbuild 把 `.ts` 的 import 打包，原生 ESM 不认 `.ts`）。
 */
import { createVoiceClient, type VoiceClient } from '../src/browser/client.ts';

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`缺少元素 #${id}`);
  }
  return element as T;
};

const pill = $('pill');
const level = $('level');
const toggle = $<HTMLButtonElement>('toggle');
const hush = $<HTMLButtonElement>('hush');
const probe = $<HTMLButtonElement>('probe');
const notice = $('notice');
const logBox = $<HTMLPreElement>('log');
const mNoise = $('m-noise');
const mEcho = $('m-echo');
const mMargin = $('m-margin');
const mVerdict = $('m-verdict');

/** 服务端上行能量门，与 `VOICE_PEAK_DBFS` 默认值（−30 dBFS）一致 */
const GATE_DBFS = -30;
const gateLabel = mMargin.previousElementSibling;
if (gateLabel !== null) {
  gateLabel.textContent = `对门限（−${Math.abs(GATE_DBFS)} dBFS）`;
}
const TEST_QUIET_MS = 1_200;
const TEST_PLAY_MS = 3_000;

const startedAt = performance.now();
const log = (line: string): void => {
  const at = ((performance.now() - startedAt) / 1000).toFixed(2).padStart(6, ' ');
  logBox.textContent += `${at}s  ${line}\n`;
  logBox.scrollTop = logBox.scrollHeight;
};

const setPill = (text: string, state: string): void => {
  pill.textContent = text;
  pill.dataset['state'] = state;
};

const showNotice = (text: string): void => {
  notice.textContent = text;
  notice.hidden = text === '';
};

/** WS 地址从当前页面推：同端口、同协议（https → wss） */
function socketUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}`;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 一块 PCM16 的峰值，单位 dBFS。服务端门限判的就是这个量。 */
function peakDbfs(pcm: Uint8Array): number {
  const count = pcm.length >> 1;
  if (count === 0) {
    return -120;
  }
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let peak = 0;
  for (let i = 0; i < count; i += 1) {
    const value = Math.abs(view.getInt16(i * 2, true));
    if (value > peak) {
      peak = value;
    }
  }
  return peak === 0 ? -120 : 20 * Math.log10(peak / 32_768);
}

const fmtDb = (db: number): string => (db <= -119 ? '静音' : `${db.toFixed(1)} dBFS`);

// 先检查环境，省得用户点了按钮才看到没反应
if (!window.isSecureContext) {
  showNotice('这个页面不是安全上下文，浏览器不会给麦克风。用 http://127.0.0.1 或 https:// 打开。');
  toggle.disabled = true;
}

let client: VoiceClient | null = null;
let meterTimer: ReturnType<typeof setTimeout> | undefined;
/** 测量窗口：只有这里面的块会被记进峰值 */
let probePhase: 'idle' | 'quiet' | 'play' = 'idle';
let probeSink: ((db: number) => void) | null = null;

toggle.addEventListener('click', () => {
  if (client !== null) {
    client.close();
    client = null;
    toggle.textContent = '开始对话';
    toggle.dataset['running'] = 'false';
    hush.disabled = true;
    probe.disabled = true;
    setPill('未开始', 'idle');
    level.style.transform = 'scaleX(0)';
    log('已断开');
    return;
  }

  const instance = createVoiceClient({
    url: socketUrl(),
    deviceId: 'web',
    onChunk: (pcm) => {
      const db = peakDbfs(pcm);
      probeSink?.(db);
      // 峰值保持 250 ms，避免条子闪得看不清。-60..0 dBFS 映射到 0..1
      level.style.transform = `scaleX(${Math.min(1, Math.max(0, (db + 60) / 60)).toFixed(3)})`;
      clearTimeout(meterTimer);
      meterTimer = setTimeout(() => { level.style.transform = 'scaleX(0)'; }, 250);
    },
    onEvent: (event) => {
      switch (event.type) {
        case 'open':
          setPill('连接中', 'live');
          log(`WS 已连 ${socketUrl()}`);
          break;
        case 'ready':
          setPill('在听', 'live');
          toggle.dataset['running'] = 'true';
          toggle.textContent = '结束对话';
          hush.disabled = false;
          probe.disabled = false;
          log('服务端已接受 v2 能力（上行 pcm16）');
          break;
        case 'speaking':
          setPill(event.active ? '它在说' : '在听', event.active ? 'speaking' : 'live');
          break;
        case 'control':
          log(`控制串 ${event.text}`);
          break;
        case 'call':
          log(`原语 ${JSON.stringify(event.json)}`);
          break;
        case 'error':
          setPill('出错', 'error');
          log(`错误：${event.message}`);
          break;
        case 'close':
          // 服务端 45 s 没收到上行字节会主动断开。必须先 close() 再丢掉引用，
          // 否则麦还开着，再点「开始」会叠第二只麦克风。
          setPill('已断开', 'idle');
          toggle.dataset['running'] = 'false';
          toggle.textContent = '开始对话';
          hush.disabled = true;
          probe.disabled = true;
          log(`连接关闭 ${event.code}${event.reason === '' ? '' : ` ${event.reason}`}`);
          instance.close();
          client = null;
          break;
      }
    },
  });
  client = instance;
  setPill('启动中', 'live');

  void instance.start().then(
    () => {
      // 权限框期间被关掉：start() 按代次直接返回，这时不该再说麦开着。
      if (client !== instance) {
        return;
      }
      log('麦克风已打开');
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setPill('出错', 'error');
      log(`启动失败：${message}`);
      // 两类错误最常见，给一句能照着做的提示
      if (/NotAllowedError|Permission/i.test(message)) {
        showNotice('麦克风权限被拒绝。在地址栏的站点设置里允许麦克风后重新开始。');
      } else if (/NotFoundError/i.test(message)) {
        showNotice('没有可用的麦克风设备。');
      } else {
        showNotice(`启动失败：${message}`);
      }
      instance.close();
      client = null;
      toggle.textContent = '开始对话';
      toggle.dataset['running'] = 'false';
    },
  );
});

/**
 * 测试信号：白噪经一阶低通塑到语音频段，再套一个 3.2 Hz 的音节包络。
 *
 * 不用正弦：稳态单音是自适应滤波器最好对付的输入，量出来的余量会偏乐观；
 * 也不用恒定电平的噪声：真实语音有起伏，AEC 的收敛在起伏处最容易露馅。
 */
function makeProbeBuffer(context: AudioContext, seconds: number): AudioBuffer {
  const rate = context.sampleRate;
  const length = Math.round(rate * seconds);
  const buffer = context.createBuffer(1, length, rate);
  const out = buffer.getChannelData(0);
  let lowpass = 0;
  for (let i = 0; i < length; i += 1) {
    const t = i / rate;
    const envelope = 0.15 + 0.85 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3.2 * t)) ** 2;
    lowpass += 0.25 * ((Math.random() * 2 - 1) - lowpass);
    out[i] = lowpass * envelope * 0.5;
  }
  return buffer;
}

probe.addEventListener('click', () => { void runProbe(); });

async function runProbe(): Promise<void> {
  // 必须用采集/播放共用的那个 context：另开一个放出来的声音对 AEC 是"外人"
  const context = client?.context ?? null;
  if (context === null) {
    return;
  }
  if (context.state !== 'running') {
    await context.resume();
  }

  probe.disabled = true;
  mNoise.textContent = '…';
  mEcho.textContent = '…';
  mMargin.textContent = '—';
  mVerdict.dataset['level'] = '';
  mVerdict.textContent = '先保持安静 1.2 秒…';

  let noiseMax = -120;
  let echoMax = -120;
  probeSink = (db) => {
    if (probePhase === 'quiet') {
      noiseMax = Math.max(noiseMax, db);
    } else if (probePhase === 'play') {
      echoMax = Math.max(echoMax, db);
    }
  };

  try {
    probePhase = 'quiet';
    await delay(TEST_QUIET_MS);

    const source = context.createBufferSource();
    source.buffer = makeProbeBuffer(context, TEST_PLAY_MS / 1000);
    source.connect(context.destination);
    probePhase = 'play';
    mVerdict.textContent = '正在放测试信号（3 秒），保持安静…';
    source.start();
    await delay(TEST_PLAY_MS);
    try {
      source.stop();
    } catch {
      // 已经播完
    }
    source.disconnect();
  } finally {
    probePhase = 'idle';
    probeSink = null;
    probe.disabled = false;
  }

  mNoise.textContent = fmtDb(noiseMax);
  mEcho.textContent = fmtDb(echoMax);

  // 余量 = 门限 − 回波峰值。正数表示回波还在门限以下，还有这么多 dB 的富余。
  const margin = GATE_DBFS - echoMax;
  mMargin.textContent = `${margin >= 0 ? '+' : ''}${margin.toFixed(1)} dB`;

  // 三个阈值不是"能不能用"的分级 —— 链路的前提是**戴耳机**，
  // 所以这项测量的用途是确认耳机真的生效了，而不是拿余量去调门限。
  if (echoMax <= -120) {
    mVerdict.dataset['level'] = 'tight';
    mVerdict.textContent = '播放期没收到任何上行数据 —— 麦克风可能没在工作。';
  } else if (margin >= 25) {
    mVerdict.dataset['level'] = 'ok';
    mVerdict.textContent = `回波比门限低 ${margin.toFixed(0)} dB —— 耳机生效了（或者是静音输出，别用 silent TTS 测）。`;
  } else if (margin >= 10) {
    mVerdict.dataset['level'] = 'tight';
    mVerdict.textContent = `余量 ${margin.toFixed(0)} dB，勉强够。可能耳机漏音，或者戴得不够严。`;
  } else {
    mVerdict.dataset['level'] = 'bad';
    mVerdict.textContent = '回波贴着门限 —— 大概率没戴耳机（外放），这个状态下它会被自己的声音触发。';
  }
  log(`回声测量：静默 ${fmtDb(noiseMax)} / 播放 ${fmtDb(echoMax)} / 余量 ${margin.toFixed(1)} dB`);
}

// 立刻掐掉本地播放；服务端那边靠上行音频自己发现被打断
hush.addEventListener('click', () => {
  client?.interrupt();
  log('已本地静音');
});

window.addEventListener('keydown', (event) => {
  if (event.code === 'Space' && document.activeElement?.tagName !== 'BUTTON') {
    event.preventDefault();
    client?.interrupt();
  }
});

window.addEventListener('pagehide', () => { client?.close(); });
