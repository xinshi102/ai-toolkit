// 适配面板尺寸 = 滚动 + 重排，而不是把字缩到看不清（与 DSH plan-map 同一套取法）。
//  - 「适宽」：把整棵树缩到面板宽度，但只缩到可读下限 MIN_ZOOM；仍放不下就横向滚动。
//  - 手动缩放夹在 MIN_ZOOM–MAX_ZOOM；SVG 用 viewBox + preserveAspectRatio 等比缩放，
//    缩放到多少都不裁切，内边距也不会跟着被缩放（旧版 transform+scale 会把 padding 一起缩）。
//  - 高度不设可读下限：深计划优先纵向滚动（画布最多 CANVAS_MAX 高，交给宿主 size-changed）。
export const MIN_ZOOM = 0.7;
export const MAX_ZOOM = 2;
export const PADDING = 12;
export const CANVAS_MIN = 80;
export const CANVAS_MAX = 280;

/** 把任意输入夹到可读缩放区间（保留两位小数）。 */
export function clampZoom(value) {
  const zoom = Number(value);
  if (!Number.isFinite(zoom)) return 1;
  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) * 100) / 100;
}

/**
 * @param layout layoutTree 的结果（width/height 是内容尺寸）
 * @param availableWidth 面板/画布可用宽度（px）
 * @param options {fit?: boolean, zoom?: number}
 * @returns {zoom, padding, viewBox:{width,height}, width, height, canvasHeight, overflowing, offsetX}
 */
export function graphViewport(layout, availableWidth, { fit = true, zoom = 1 } = {}) {
  const width = Math.max(120, Number(layout?.width) || 0) + PADDING * 2;
  const height = Math.max(24, Number(layout?.height) || 0) + PADDING * 2;
  const panel = Math.max(160, (Number(availableWidth) || 0) - 24);
  const widthFit = Math.min(1, panel / width);
  const scale = fit ? Math.max(MIN_ZOOM, widthFit) : clampZoom(zoom);
  const scaledWidth = width * scale;
  const scaledHeight = height * scale;
  return {
    zoom: scale,
    padding: PADDING,
    viewBox: { width: Math.ceil(width), height: Math.ceil(height) },
    width: Math.max(120, Math.round(scaledWidth)),
    height: Math.max(60, Math.round(scaledHeight)),
    canvasHeight: Math.min(CANVAS_MAX, Math.max(CANVAS_MIN, Math.ceil(scaledHeight) + 2)),
    overflowing: scaledWidth > (Number(availableWidth) || 0) + 1,
    offsetX: Math.max(0, Math.round(((Number(availableWidth) || 0) - scaledWidth) / 2)),
  };
}
