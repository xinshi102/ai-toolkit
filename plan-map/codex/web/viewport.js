// Default to a complete overview; manual zoom is for reading individual branches.
export function graphViewport(layout, availableWidth, { fit = true, zoom = 1 } = {}) {
  const padding = 12;
  const naturalWidth = layout.width + padding * 2;
  const naturalHeight = layout.height + padding * 2;
  const maxHeight = 280;
  const scale = fit ? Math.min(1, Math.max(1, availableWidth - 2) / naturalWidth, (maxHeight - 2) / naturalHeight) : zoom;
  const height = Math.ceil(naturalHeight * scale);
  return {
    zoom: scale,
    padding,
    width: fit ? Math.ceil(availableWidth) : Math.ceil(Math.max(availableWidth, naturalWidth * scale)),
    height,
    canvasHeight: Math.min(maxHeight, Math.max(80, height + 2)),
    offsetX: Math.max(0, (availableWidth - naturalWidth * scale) / 2),
  };
}
