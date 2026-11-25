/**
 * 拖拽手势。位移平方小于 9 还算点击。
 *
 * 松手时先问 `shouldRevertDrag`：取消、没有坐标、或者已经拖动过却报到 (0, 0)，
 * 都只把宿主放回按下时的位置。没移动过的 (0, 0) 是一次点击。
 * 真正落下才走 `anchorFromDrop`。
 */
import {
  CLICK_DISTANCE_SQ,
  DEFAULT_SNAP_CONFIG,
  anchorFromDrop,
  clamp,
  shouldRevertDrag,
  type DropAnchor,
  type Viewport,
} from './pet-geometry.ts';

export interface DragGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly origLeft: number;
  readonly origTop: number;
  readonly moved: boolean;
  readonly active: boolean;
}

export interface ReleaseInput {
  readonly gesture: DragGesture;
  readonly cancelled: boolean;
  readonly clientX: number;
  readonly clientY: number;
  readonly sizePx: number;
  readonly viewport: Viewport;
  readonly rightGap: number;
}

export type ReleaseDecision =
  | { readonly kind: 'revert' }
  | { readonly kind: 'click' }
  | { readonly kind: 'drop'; readonly drop: DropAnchor };

export function notePointerMove(
  gesture: DragGesture,
  clientX: number,
  clientY: number,
): DragGesture {
  const dx = clientX - gesture.startX;
  const dy = clientY - gesture.startY;
  // `>=` 才能和原来一致：NaN 比大小是 false，不能把坏坐标当成已经拖动。
  if (!(dx * dx + dy * dy >= CLICK_DISTANCE_SQ)) return gesture;
  if (gesture.moved) return gesture;
  return { ...gesture, moved: true };
}

export function dragPosition(
  gesture: DragGesture,
  clientX: number,
  clientY: number,
  sizePx: number,
  viewport: Viewport,
): { readonly left: number; readonly top: number } {
  const dx = clientX - gesture.startX;
  const dy = clientY - gesture.startY;
  return {
    left: clamp(gesture.origLeft + dx, 0, Math.max(0, viewport.w - sizePx)),
    top: clamp(gesture.origTop + dy, 0, Math.max(0, viewport.h - sizePx)),
  };
}

export function classifyRelease(input: ReleaseInput): ReleaseDecision {
  const revert = shouldRevertDrag({
    cancelled: input.cancelled,
    clientX: input.clientX,
    clientY: input.clientY,
    moved: input.gesture.moved,
  });
  if (revert || !input.gesture.moved) {
    return { kind: !revert && !input.cancelled ? 'click' : 'revert' };
  }
  const pos = dragPosition(
    input.gesture,
    input.clientX,
    input.clientY,
    input.sizePx,
    input.viewport,
  );
  return {
    kind: 'drop',
    drop: anchorFromDrop(
      pos.left,
      pos.top,
      { w: input.sizePx, h: input.sizePx },
      input.viewport,
      DEFAULT_SNAP_CONFIG,
      input.rightGap,
    ),
  };
}
