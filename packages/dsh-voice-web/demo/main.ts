/**
 * 演示页脚本：一个按钮开始 / 停止，日志直接打在页面上。
 *
 * 构建：`npm run demo:build`（esbuild 把 `.ts` 的 import 打包成浏览器能读的 ESM）。
 * 直接开 `demo/index.html` 不行 —— 原生 ESM 不认 `.ts` 扩展名。
 */
import { createVoiceClient, type VoiceClient } from '../src/browser/client.ts';

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`缺少元素 #${id}`);
  }
  return element;
};

const urlInput = $('url') as HTMLInputElement;
const tokenInput = $('token') as HTMLInputElement;
const deviceInput = $('device') as HTMLInputElement;
const toggleButton = $('toggle') as HTMLButtonElement;
const logBox = $('log') as HTMLPreElement;

const startedAt = performance.now();
const log = (line: string): void => {
  const at = ((performance.now() - startedAt) / 1000).toFixed(2).padStart(6, ' ');
  logBox.textContent += `${at}s  ${line}\n`;
  logBox.scrollTop = logBox.scrollHeight;
};

let client: VoiceClient | null = null;

toggleButton.addEventListener('click', () => {
  if (client !== null) {
    client.close();
    client = null;
    toggleButton.textContent = '开始';
    log('已断开');
    return;
  }

  const instance = createVoiceClient({
    url: urlInput.value.trim(),
    token: tokenInput.value.trim(),
    deviceId: deviceInput.value.trim() || 'web',
    onEvent: (event) => {
      switch (event.type) {
        case 'open': log('WS 已连上，发 Hello'); break;
        case 'ready': log('收到 Welcome（服务端认了 v2 能力）'); break;
        case 'control': log(`控制串 ${event.text}`); break;
        case 'call': log(`原语 ${JSON.stringify(event.json)}`); break;
        case 'error': log(`错误：${event.message}`); break;
        case 'close': log(`连接关闭 ${event.code} ${event.reason}`); break;
      }
    },
  });
  client = instance;
  toggleButton.textContent = '停止';

  void instance.start().then(
    () => { log('麦克风已打开'); },
    (error: unknown) => {
      log(`启动失败：${error instanceof Error ? error.message : String(error)}`);
      instance.close();
      client = null;
      toggleButton.textContent = '开始';
    },
  );
});

// 手动掐断本地播放；服务端那边靠上行音频自己发现被打断
window.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
    event.preventDefault();
    client?.interrupt();
    log('已本地静音（打断）');
  }
});
