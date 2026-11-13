/**
 * 拍照收件箱：把「请设备拍一张」变成一次可等待、可超时的请求。
 *
 * 两类使用者：
 * - 工具口 `POST /take_photo`：等图，超时返回 null
 * - 设备自己按快门：没人等就落到 {@link deliver} 返回 false，由调用方当成一轮识图
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type PhotoKind = 'spp' | 'hq';

export interface PhotoInboxOptions {
  /** 落盘目录；空串不落盘（默认） */
  readonly dir: string;
  readonly timeoutMs: number;
  readonly log: (line: string) => void;
  /** 真正下发 `take_photo` 的地方（连接层动作） */
  /** spp = 低清直出（快）；hq = P2P 拉原图再缩（慢但看得清） */
  readonly sendTakePhoto: (kind: PhotoKind) => void;
}

interface Waiter {
  resolve: (jpeg: Buffer | null) => void;
  timer: NodeJS.Timeout;
}

export class PhotoInbox {
  private readonly options: PhotoInboxOptions;
  private waiter: Waiter | null = null;

  constructor(options: PhotoInboxOptions) {
    this.options = options;
  }

  get isWaiting(): boolean {
    return this.waiter !== null;
  }

  /**
   * 等一张图；已经有请求在等时直接给 null（不排队，避免两次请求抢一张图）。
   *
   * @param kind 走哪条采集路径；hq 时手机侧会开一次 P2P 拉原图，通常 3–8 s
   */
  request(kind: PhotoKind = 'spp'): Promise<Buffer | null> {
    if (this.waiter) {
      return Promise.resolve(null);
    }
    this.options.sendTakePhoto(kind);
    this.options.log(`  拍照    已下发指令（${kind}），等设备回图…`);

    return new Promise<Buffer | null>((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiter?.timer === timer) {
          this.waiter = null;
        }
        resolve(null);
      }, this.options.timeoutMs);

      this.waiter = { resolve, timer };
    });
  }

  /**
   * 收到一张图。
   *
   * @returns true 表示交给了等待者；false 表示没人等（调用方自行处理）
   */
  deliver(jpeg: Buffer): boolean {
    this.persist(jpeg);
    const waiter = this.waiter;
    if (!waiter) {
      return false;
    }
    this.waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(jpeg);
    return true;
  }

  private persist(jpeg: Buffer): void {
    const { dir, log } = this.options;
    if (!dir) {
      return;
    }
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `photo_${Date.now()}.jpg`);
      writeFileSync(file, jpeg);
      log(`  图片    ${jpeg.length} B  ${file}`);
    } catch (error) {
      log(`  ✗ 图片落盘失败: ${(error as Error).message}`);
    }
  }
}
