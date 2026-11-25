/**
 * 桌宠几何：吸附区、相对边锚点、拖拽回退、不透明凸包。
 *
 * 纯函数，模块加载时不读 DOM、不读 Node，浏览器包和 `node:test` 跑同一份。
 * 吸附和锚点口径来自 dsh-whale-widget@0.3.16（MIT, Copyright (c) 2026 MeteorNOX）：
 * 右缘距离是扣掉 `rightGap` 的净距离，恢复时再把当前避让加回去。
 * 默认不镜像立绘——异色瞳和星形发卡留在原来的那一侧。
 */

/** 位移平方小于 9（约 3px）算点击，大于等于 9 算拖拽。 */
export const CLICK_DISTANCE_SQ = 9;

/** 按下时的果冻压扁。原点在盒底，底部坐标不动。 */
export const PRESS_SQUISH_TRANSFORM = 'scaleY(0.88) scaleX(1.05)';

/** 松手弹回。和按压是同一条 transform 过渡。 */
export const PRESS_SPRING_TRANSITION = 'transform 0.22s cubic-bezier(.34, 1.56, .64, 1)';

export interface SnapConfig {
  readonly mode: 'ratio' | 'px' | 'off';
  readonly ratio: { readonly L: number; readonly T: number; readonly R: number; readonly B: number; readonly F: number };
  readonly px: { readonly L: number; readonly T: number; readonly R: number; readonly B: number; readonly F: number };
}

/**
 * v3 默认：上吸附是 0（视口内吸不到顶）。比例档左右 10%、下 15%、翻转线在半宽。
 * 像素档是独立的一组默认，切到 `mode: 'px'` 才用。
 */
export const DEFAULT_SNAP_CONFIG: SnapConfig = {
  mode: 'ratio',
  ratio: { L: 10, T: 0, R: 10, B: 15, F: 50 },
  px: { L: 120, T: 0, R: 120, B: 120, F: 640 },
};

export interface Viewport {
  readonly w: number;
  readonly h: number;
}

export interface PetSize {
  readonly w: number;
  readonly h: number;
}

/** `min > max` 时仍按鲸鱼那份写法：只在越界时夹，NaN 原样返回。 */
export function clamp(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

export interface SnapBounds {
  readonly L: number;
  readonly T: number;
  readonly R: number;
  readonly B: number;
  readonly F: number;
}

/**
 * 吸附区在屏幕上的边界。L/T 是距左/上的宽度；R/B 是右/下吸附区的内侧坐标
 * （视口尺寸减去那一侧的边距），不是边距本身。F 是翻转线的 x。
 * `off` 没有吸附区，翻转线落在视口中线。
 */
export function computeSnapBounds(vp: Viewport, cfg: SnapConfig): SnapBounds {
  if (cfg.mode === 'off') {
    return { L: 0, T: 0, R: vp.w, B: vp.h, F: vp.w / 2 };
  }
  if (cfg.mode === 'px') {
    return {
      L: cfg.px.L,
      T: cfg.px.T,
      R: vp.w - cfg.px.R,
      B: vp.h - cfg.px.B,
      F: cfg.px.F,
    };
  }
  return {
    L: (vp.w * cfg.ratio.L) / 100,
    T: (vp.h * cfg.ratio.T) / 100,
    R: (vp.w * (100 - cfg.ratio.R)) / 100,
    B: (vp.h * (100 - cfg.ratio.B)) / 100,
    F: (vp.w * cfg.ratio.F) / 100,
  };
}

export interface SnapZones {
  readonly zH: 'left' | 'right' | null;
  readonly zV: 'top' | 'bottom' | null;
  readonly onLeftHalf: boolean;
}

/**
 * 左右看 `cx`，上沿看盒中心 `cyBox`，下沿看画心 `cyArt`。
 * 比较都是严格不等：贴在边界上不算进入吸附区。
 * `off` 不吸附；人在不在左半边仍按视口中线，不读配置里的 F。
 */
export function evaluateSnapZones(
  cx: number,
  cyBox: number,
  cyArt: number,
  vp: Viewport,
  cfg: SnapConfig,
): SnapZones {
  if (cfg.mode === 'off') {
    return { zH: null, zV: null, onLeftHalf: cx < vp.w / 2 };
  }
  const bounds = computeSnapBounds(vp, cfg);
  return {
    onLeftHalf: cx < bounds.F,
    zH: cx < bounds.L ? 'left' : cx > bounds.R ? 'right' : null,
    zV: cyBox < bounds.T ? 'top' : cyArt > bounds.B ? 'bottom' : null,
  };
}

/**
 * 气泡朝屏幕内侧长。人在左侧（吸左，或自由位落在翻转线左边）时气泡朝右。
 * `shouldMirrorArt` 只有在调用方显式打开 `mirrorOnLeft` 并且气泡朝右时才镜像。
 */
export function shouldMirrorArt(bubbleSide: 'left' | 'right', mirrorOnLeft = false): boolean {
  return mirrorOnLeft && bubbleSide === 'right';
}

function bubbleSideFrom(zH: 'left' | 'right' | null, onLeftHalf: boolean): 'left' | 'right' {
  if (zH === 'left' || (zH === null && onLeftHalf)) return 'right';
  return 'left';
}

export interface SavedAnchorPos {
  readonly v: 2;
  readonly hAnchor: 'left' | 'right';
  readonly hDist: number;
  readonly vAnchor: 'top' | 'bottom';
  readonly vDist: number;
  readonly hSnapped: 'left' | 'right' | null;
  readonly vSnapped: 'top' | 'bottom' | null;
}

export interface DropAnchor {
  readonly left: number;
  readonly top: number;
  readonly anchor: SavedAnchorPos;
  readonly bubbleSide: 'left' | 'right';
}

export interface ResolvedAnchor extends DropAnchor {
  readonly healed: boolean;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeGap(rightGap: number): number {
  if (!Number.isFinite(rightGap) || rightGap <= 0) return 0;
  return rightGap;
}

function normalizeViewport(vp: Viewport): Viewport {
  return {
    w: Number.isFinite(vp.w) && vp.w > 0 ? vp.w : 0,
    h: Number.isFinite(vp.h) && vp.h > 0 ? vp.h : 0,
  };
}

function normalizeSize(size: PetSize): PetSize {
  return {
    w: Number.isFinite(size.w) && size.w > 0 ? size.w : 0,
    h: Number.isFinite(size.h) && size.h > 0 ? size.h : 0,
  };
}

function isHorizontalAnchor(value: unknown): value is 'left' | 'right' {
  return value === 'left' || value === 'right';
}

function isVerticalAnchor(value: unknown): value is 'top' | 'bottom' {
  return value === 'top' || value === 'bottom';
}

function isHorizontalSnap(value: unknown): value is 'left' | 'right' | null {
  return value === 'left' || value === 'right' || value === null;
}

function isVerticalSnap(value: unknown): value is 'top' | 'bottom' | null {
  return value === 'top' || value === 'bottom' || value === null;
}

function isSavedAnchor(value: SavedAnchorPos | null): value is SavedAnchorPos {
  if (value === null || typeof value !== 'object') return false;
  return value.v === 2
    && isHorizontalAnchor(value.hAnchor)
    && isVerticalAnchor(value.vAnchor)
    && isHorizontalSnap(value.hSnapped)
    && isVerticalSnap(value.vSnapped)
    && typeof value.hDist === 'number'
    && typeof value.vDist === 'number';
}

function maxLeft(vpW: number, width: number): number {
  return Math.max(0, vpW - width);
}

function maxTop(vpH: number, height: number): number {
  return Math.max(0, vpH - height);
}

/** 右锚点的净距离上限要扣掉避让，否则加回 gap 后会再次落到视口外。 */
function maxHDist(hAnchor: 'left' | 'right', vpW: number, width: number, gap: number): number {
  const span = maxLeft(vpW, width);
  if (hAnchor === 'right') return Math.max(0, span - gap);
  return span;
}

/**
 * 非有限值先归 0。`clamp(Infinity)` 会落到最远边，脏数据不该把挂件钉到对面。
 * 返回值和原值不同（含 NaN）时 `changed` 为 true。
 */
function cleanDist(value: number, maxOff: number): { readonly dist: number; readonly changed: boolean } {
  if (!Number.isFinite(value)) return { dist: 0, changed: true };
  const dist = clamp(value, 0, maxOff);
  return { dist, changed: dist !== value };
}

function placeLeft(
  hAnchor: 'left' | 'right',
  hDist: number,
  vpW: number,
  width: number,
  gap: number,
): number {
  const raw = hAnchor === 'left' ? hDist : vpW - width - gap - hDist;
  return clamp(raw, 0, maxLeft(vpW, width));
}

function placeTop(vAnchor: 'top' | 'bottom', vDist: number, vpH: number, height: number): number {
  const raw = vAnchor === 'top' ? vDist : vpH - height - vDist;
  return clamp(raw, 0, maxTop(vpH, height));
}

function defaultAnchor(): SavedAnchorPos {
  return {
    v: 2,
    hAnchor: 'right',
    hDist: 0,
    vAnchor: 'bottom',
    vDist: 0,
    hSnapped: 'right',
    vSnapped: 'bottom',
  };
}

function horizontalFromDrop(
  left: number,
  width: number,
  vpW: number,
  gap: number,
): { readonly hAnchor: 'left' | 'right'; readonly hDist: number } {
  const leftDist = Math.max(0, left);
  const rightDist = Math.max(0, vpW - left - width);
  if (leftDist <= rightDist) {
    return { hAnchor: 'left', hDist: Math.max(0, Math.round(leftDist)) };
  }
  return { hAnchor: 'right', hDist: Math.max(0, Math.round(rightDist) - gap) };
}

function verticalFromDrop(
  top: number,
  height: number,
  vpH: number,
): { readonly vAnchor: 'top' | 'bottom'; readonly vDist: number } {
  const topDist = Math.max(0, top);
  const bottomDist = Math.max(0, vpH - top - height);
  if (topDist <= bottomDist) {
    return { vAnchor: 'top', vDist: Math.max(0, Math.round(topDist)) };
  }
  return { vAnchor: 'bottom', vDist: Math.max(0, Math.round(bottomDist)) };
}

/**
 * 把存下来的相对边距放回视口。`anchor` 缺失或字段不对时落到右下角
 * （右缘让出 `rightGap`）。负数、NaN、Infinity、缩窗之后放不下的距离夹回合法区间，
 * `healed` 为 true，调用方用返回的 `anchor` 覆盖旧档。
 */
export function resolveAnchorPosition(
  anchor: SavedAnchorPos | null,
  size: PetSize,
  vp: Viewport,
  rightGap: number,
): ResolvedAnchor {
  const gap = normalizeGap(rightGap);
  const box = normalizeSize(size);
  const view = normalizeViewport(vp);
  const source = isSavedAnchor(anchor) ? anchor : null;
  let healed = source === null;
  const base = source ?? defaultAnchor();
  const hClean = cleanDist(base.hDist, maxHDist(base.hAnchor, view.w, box.w, gap));
  const vClean = cleanDist(base.vDist, maxTop(view.h, box.h));
  if (hClean.changed || vClean.changed) healed = true;
  const clean: SavedAnchorPos = {
    v: 2,
    hAnchor: base.hAnchor,
    hDist: hClean.dist,
    vAnchor: base.vAnchor,
    vDist: vClean.dist,
    hSnapped: base.hSnapped,
    vSnapped: base.vSnapped,
  };
  const left = placeLeft(clean.hAnchor, clean.hDist, view.w, box.w, gap);
  const top = placeTop(clean.vAnchor, clean.vDist, view.h, box.h);
  const onLeftHalf = left + box.w / 2 < view.w / 2;
  return {
    left,
    top,
    healed,
    anchor: clean,
    bubbleSide: bubbleSideFrom(clean.hSnapped, onLeftHalf),
  };
}

/**
 * 松手落点。先夹进视口（右缘先不扣避让，吸附判定才和拖拽中的坐标一致），
 * 再按区贴边；自由位记下离最近边的距离，右锚点存的是扣掉 `rightGap` 的净距离。
 * 立绘铺满挂件盒，盒中心同时充当上吸附的盒心和下吸附的画心。
 */
export function anchorFromDrop(
  left: number,
  top: number,
  size: PetSize,
  vp: Viewport,
  cfg: SnapConfig,
  rightGap: number,
): DropAnchor {
  const gap = normalizeGap(rightGap);
  const box = normalizeSize(size);
  const view = normalizeViewport(vp);
  const dragLeft = clamp(finiteOr(left, 0), 0, maxLeft(view.w, box.w));
  const dragTop = clamp(finiteOr(top, 0), 0, maxTop(view.h, box.h));
  const zones = evaluateSnapZones(
    dragLeft + box.w / 2,
    dragTop + box.h / 2,
    dragTop + box.h / 2,
    view,
    cfg,
  );
  const freeLeft = clamp(dragLeft, 0, Math.max(0, view.w - box.w - gap));
  const horizontal = zones.zH === 'left'
    ? { hAnchor: 'left' as const, hDist: 0, hSnapped: 'left' as const }
    : zones.zH === 'right'
      ? { hAnchor: 'right' as const, hDist: 0, hSnapped: 'right' as const }
      : { ...horizontalFromDrop(freeLeft, box.w, view.w, gap), hSnapped: null };
  const vertical = zones.zV === 'top'
    ? { vAnchor: 'top' as const, vDist: 0, vSnapped: 'top' as const }
    : zones.zV === 'bottom'
      ? { vAnchor: 'bottom' as const, vDist: 0, vSnapped: 'bottom' as const }
      : { ...verticalFromDrop(dragTop, box.h, view.h), vSnapped: null };
  const draft: SavedAnchorPos = { v: 2, ...horizontal, ...vertical };
  const resolved = resolveAnchorPosition(draft, box, view, gap);
  return {
    left: resolved.left,
    top: resolved.top,
    anchor: resolved.anchor,
    bubbleSide: bubbleSideFrom(zones.zH, zones.onLeftHalf),
  };
}

/**
 * 取消的手势、没有坐标、或已经拖动过却报到 (0, 0) 的松手，都不能写入锚点。
 * 真的点在原点上（没移动）要保留。
 */
export function shouldRevertDrag(input: {
  readonly cancelled?: boolean;
  readonly clientX?: number;
  readonly clientY?: number;
  readonly moved: boolean;
}): boolean {
  if (input.cancelled === true) return true;
  const x = input.clientX;
  const y = input.clientY;
  if (typeof x !== 'number' || typeof y !== 'number') return true;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
  return x === 0 && y === 0 && input.moved;
}

export type Point2D = readonly [number, number];

function cross(origin: Point2D, a: Point2D, b: Point2D): number {
  return (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0]);
}

function monotoneChain(points: readonly Point2D[]): Point2D[] {
  const chain: Point2D[] = [];
  for (const point of points) {
    let count = chain.length;
    while (count >= 2) {
      const origin = chain[count - 2];
      const previous = chain[count - 1];
      if (origin === undefined || previous === undefined || cross(origin, previous, point) > 0) break;
      chain.pop();
      count -= 1;
    }
    chain.push(point);
  }
  return chain;
}

/**
 * Andrew 单调链。先按 x 再按 y 排序并去掉重复点；少于 3 个点时原样返回，不补点。
 * 共线的中间点会去掉（叉积 <= 0 就弹栈）。
 */
export function convexHull(points: readonly Point2D[]): Point2D[] {
  const sorted: Point2D[] = [];
  for (const point of points) {
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
    sorted.push(point);
  }
  sorted.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const unique: Point2D[] = [];
  for (const point of sorted) {
    const previous = unique[unique.length - 1];
    if (previous !== undefined && previous[0] === point[0] && previous[1] === point[1]) continue;
    unique.push(point);
  }
  if (unique.length < 3) return unique;
  const lower = monotoneChain(unique);
  const upper = monotoneChain([...unique].reverse());
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function alphaAt(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
): number {
  const value = rgba[(y * width + x) * 4 + 3];
  return value === undefined ? 0 : value;
}

/**
 * 每一行取最左、最右不透明像素，再求凸包，写成 CSS `polygon()` 百分比。
 * 凸包包住全部不透明像素，点数少，外层 `scaleX(-1)` 会一起镜像。
 * 不足 3 个顶点（全透明、或隐私功能把画布抹空）返回空串，调用方不裁切。
 */
export function buildAlphaClipPath(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  alphaThreshold = 10,
): string {
  const widthPx = Math.floor(width);
  const heightPx = Math.floor(height);
  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) return '';
  const samples: Point2D[] = [];
  for (let y = 0; y < heightPx; y += 1) {
    let left = -1;
    let right = -1;
    for (let x = 0; x < widthPx; x += 1) {
      if (alphaAt(rgba, widthPx, x, y) > alphaThreshold) {
        if (left < 0) left = x;
        right = x;
      }
    }
    if (left >= 0) {
      samples.push([left, y]);
      if (right !== left) samples.push([right, y]);
    }
  }
  const hull = convexHull(samples);
  if (hull.length < 3) return '';
  const parts: string[] = [];
  for (const point of hull) {
    const x = point[0];
    const y = point[1];
    parts.push(`${(x / widthPx * 100).toFixed(2)}% ${(y / heightPx * 100).toFixed(2)}%`);
  }
  return `polygon(${parts.join(', ')})`;
}

/**
 * 6×6 格子各取中心像素。一个不透明点都没有，就当画布被抹空
 * （Firefox `resistFingerprinting` 会让 getImageData 全透明）。
 */
export function hasOpaqueProbePixels(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  alphaThreshold = 10,
): boolean {
  const widthPx = Math.floor(width);
  const heightPx = Math.floor(height);
  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) return false;
  for (let gy = 0; gy < 6; gy += 1) {
    for (let gx = 0; gx < 6; gx += 1) {
      const x = Math.min(widthPx - 1, Math.floor((widthPx * (gx + 0.5)) / 6));
      const y = Math.min(heightPx - 1, Math.floor((heightPx * (gy + 0.5)) / 6));
      if (alphaAt(rgba, widthPx, x, y) > alphaThreshold) return true;
    }
  }
  return false;
}
