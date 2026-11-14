/**
 * 小米 AI 眼镜（v1 手机端）的默认能力与代说的话。
 *
 * v1 手机不在 `Hello` 里自报能力，所以由 `--device xiaomi-glasses` 这个入参补上。
 * 手机端改说新协议后，这些都改由手机自报，这个文件随 `wire-v1.ts` 一起删掉。
 *
 * 真机验证过的（`evidence: measured`）：
 * - 上行是手机转发的 mSBC；固件做了回声消除
 * - 唤醒词「小爱同学」烧在固件里，ASR 会把它本身识别成完整一句
 * - 低清（SPP 直出）不用确认；高清要手机建 P2P 拉相册，**必须人按快门**
 *   （程序化快门不写相册）
 *
 * 佩戴 / 电量 / 长按设备侧都有（`System` id=93/79、id=1/97、`Aivs` id=10），
 * 但 v1 手机端**没有转发**到云端，所以这里如实声明为没有。
 */
import type { DeviceCapabilities } from './primitives.ts';
import { V1_BASELINE, type V1Phrases } from './wire-v1.ts';

export const XIAOMI_GLASSES_MODEL = 'xiaomi-glasses';

export const XIAOMI_GLASSES_CAPABILITIES: DeviceCapabilities = {
  ...V1_BASELINE,
  capture: {
    glance: { needsUser: false },
    detail: { needsUser: true },
  },
  ignorePhrases: ['小爱同学'],
};

/**
 * v1 失败原因 → 一句给用户的原因。
 *
 * 这些原因（P2P / 入组 / 快门 / 相册）是小米这条链路的实现细节；
 * 新协议里由手机端直接在 `say` 里给出。
 */
function xiaomiFailureSay(reason: string): string | undefined {
  switch (reason) {
    case 'no_shutter':
      return '相册里没有新照片，需要先按一下眼镜上的快门，然后再说一次';
    case 'no_arm':
      return '手机没有响应拍照请求，可能没连上';
    case 'p2p':
    case 'join':
    case 'connect':
    case 'arm':
      return '手机和眼镜的相册通道没建起来，稍后再试';
    case 'download':
    case 'decode':
      return '照片拿到了但读不出来，再说一次试试';
    case 'send':
      return '照片拍到了但没能传上来，再说一次试试';
    default:
      return undefined;
  }
}

export const XIAOMI_GLASSES_PHRASES: V1Phrases = {
  waitingSay: '好，请按一下眼镜上的快门，我等着。',
  failureSay: xiaomiFailureSay,
};
