/**
 * 透明穿透。矩形外直接放过；没有 alpha 贴图时矩形内都算点中。
 *
 * 镜像时采样 x 用 `HIT_SIZE - x`，再 floor 夹到 0..255。alpha 必须大于 10。
 */

export const HIT_SIZE = 256;
export const ALPHA_THRESHOLD = 10;

export interface PetHitRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface PetHitProbe {
  readonly clientX: number;
  readonly clientY: number;
  readonly rect: PetHitRect;
  readonly mirror: boolean;
  readonly hitMode: 'rect' | 'alpha';
  readonly alpha: Uint8ClampedArray | null;
}

export function samplePetHit(probe: PetHitProbe): boolean {
  const { rect } = probe;
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (
    probe.clientX < rect.left
    || probe.clientX > rect.right
    || probe.clientY < rect.top
    || probe.clientY > rect.bottom
  ) {
    return false;
  }
  if (probe.hitMode !== 'alpha' || probe.alpha === null) return true;
  let x = ((probe.clientX - rect.left) / rect.width) * HIT_SIZE;
  const y = ((probe.clientY - rect.top) / rect.height) * HIT_SIZE;
  if (probe.mirror) x = HIT_SIZE - x;
  const ix = Math.min(HIT_SIZE - 1, Math.max(0, Math.floor(x)));
  const iy = Math.min(HIT_SIZE - 1, Math.max(0, Math.floor(y)));
  const pixel = probe.alpha[(iy * HIT_SIZE + ix) * 4 + 3];
  return (pixel ?? 0) > ALPHA_THRESHOLD;
}
