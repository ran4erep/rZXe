export interface CatalogGridBounds {
  minCardWidth?: number;
  maxCardWidth?: number;
  minCardHeight?: number;
  maxCardHeight?: number;
  gap?: number;
}

export interface CatalogGridLayout {
  cols: number;
  rows: number;
  cardWidth: number;
  cardHeight: number;
  gap: number;
  pageSize: number;
}

const DEFAULT_MIN_CARD_WIDTH = 134;
const DEFAULT_MAX_CARD_WIDTH = 228;
const DEFAULT_MIN_CARD_HEIGHT = 172;
const DEFAULT_MAX_CARD_HEIGHT = 276;

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Dynamically computes optimal grid columns, rows, and card dimensions from
 * the current catalog container width & height, bounded only by min/max limits.
 */
export function computeCatalogGrid(
  containerWidth: number,
  containerHeight: number,
  bounds: CatalogGridBounds = {}
): CatalogGridLayout {
  const minW = bounds.minCardWidth ?? DEFAULT_MIN_CARD_WIDTH;
  const maxW = bounds.maxCardWidth ?? DEFAULT_MAX_CARD_WIDTH;
  const minH = bounds.minCardHeight ?? DEFAULT_MIN_CARD_HEIGHT;
  const maxH = bounds.maxCardHeight ?? DEFAULT_MAX_CARD_HEIGHT;

  const safeW = Math.max(120, Math.floor(containerWidth));
  const safeH = Math.max(120, Math.floor(containerHeight));
  const gap = bounds.gap ?? (safeW < 520 ? 10 : 12);

  // Target card width scales smoothly with available viewport area, clamped to [minW, maxW]
  const areaIdealW = Math.sqrt(safeW * safeH) * 0.215;
  const targetW = clamp(areaIdealW, minW, maxW);

  let cols = Math.max(1, Math.floor((safeW + gap) / (targetW + gap)));

  // If current cols produces cards wider than maxW, increase cols until within bounds
  while (cols < 16) {
    const candidateW = (safeW - gap * (cols - 1)) / cols;
    if (candidateW <= maxW) break;
    cols++;
  }

  // If current cols produces cards narrower than minW, reduce cols (down to 1)
  while (cols > 1) {
    const candidateW = (safeW - gap * (cols - 1)) / cols;
    if (candidateW >= minW) break;
    cols--;
  }

  const rawCardWidth = Math.floor((safeW - gap * (cols - 1)) / cols);
  const cardWidth = safeW < minW ? safeW : clamp(rawCardWidth, minW, maxW);

  // Target aspect ratio ~ 1 : 1.18 (box/cassette cover + 2-line title footer)
  const idealCardHeight = clamp(Math.round(cardWidth * 1.18), minH, maxH);

  let rows = Math.max(1, Math.round((safeH + gap) / (idealCardHeight + gap)));

  // Ensure cardHeight stays >= minH if container has room, otherwise fit minH cleanly
  while (rows > 1) {
    const candidateH = (safeH - gap * (rows - 1)) / rows;
    if (candidateH >= minH) break;
    rows--;
  }

  // If container is tall enough that rows would exceed maxH, add another row
  while (rows < 12) {
    const candidateH = (safeH - gap * (rows - 1)) / rows;
    if (candidateH <= maxH) break;
    const nextRowH = (safeH - gap * rows) / (rows + 1);
    if (nextRowH < minH) break;
    rows++;
  }

  const rawCardHeight = Math.floor((safeH - gap * (rows - 1)) / rows);
  const cardHeight = safeH < minH ? minH : clamp(rawCardHeight, minH, maxH);

  return {
    cols,
    rows,
    cardWidth,
    cardHeight,
    gap,
    pageSize: cols * rows,
  };
}
