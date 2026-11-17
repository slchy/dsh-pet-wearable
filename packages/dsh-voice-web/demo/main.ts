/**
 * 页面逻辑：一个按钮开始/停止，一个电平条，一个「立即静音」，加一块日志。
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
const notice = $('notice');
const logBox = $<HTMLPreElement>('log');

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

/** 16-bit 小端的均方根，映射成 0–1 的条长。只用来给人看，不参与任何判定。 */
function rmsOf(pcm: Uint8Array): number {
  const count = pcm.length >> 1;
  if (count === 0) {
    return 0;
  }
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const sample = view.getInt16(i * 2, true) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / count);
}

// 先检查环境，省得用户点了按钮才看到 Controller 没反应
if (!window.isSecureContext) {
  showNotice('这个页面不是安全上下文，浏览器不会给麦克风。用 http://127.0.0.1 或 https:// 打开。');
  toggle.disabled = true;
}

let client: VoiceClient | null = null;
let speaking = false;

toggle.addEventListener('click', () => {
  if (client !== null) {
    client.close();
    client = null;
    toggle.textContent = '开始对话';
    toggle.dataset['running'] = 'false';
    hush.disabled = true;
    setPill('未开始', 'idle');
    level.style.transform = 'scaleX(0)';
    log('已断开');
    return;
  }

  const instance = createVoiceClient({
    url: socketUrl(),
    deviceId: 'web',
    onChunk: (pcm) => {
      // 峰值保持 250 ms，避免条子闪得看不清
      const value = Math.min(1, rmsOf(pcm) * 6);
      level.style.transform = `scaleX(${value.toFixed(3)})`;
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
          log('服务端已接受 v2 能力（上行 pcm16）');
          break;
        case 'speaking':
          speaking = event.active;
          setPill(speaking ? '它在说' : '在听', speaking ? 'speaking' : 'live');
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
          // 服务端 45 s 没收到上行字节会主动断开，这里如实说清
          setPill('已断开', 'idle');
          toggle.dataset['running'] = 'false';
          toggle.textContent = '开始对话';
          hush.disabled = true;
          log(`连接关闭 ${event.code}${event.reason === '' ? '' : ` ${event.reason}`}`);
          client = null;
          break;
      }
    },
  });
  client = instance;
  setPill('启动中', 'live');

  void instance.start().then(
    () => { log('麦克风已打开'); },
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

let meterTimer: ReturnType<typeof setTimeout> | undefined;

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
