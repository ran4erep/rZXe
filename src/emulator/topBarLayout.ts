/**
 * Computes how many fixed-width action icon buttons fit inline in the top bar
 * without overflowing, moving only the buttons that genuinely do not fit into
 * the collapsible sub-bar behind the toggle button.
 */
export function computeVisibleTopBarActionCount(
  availableWidth: number,
  totalCount: number,
  itemWidth: number,
  gap: number,
  toggleWidth: number = itemWidth
): number {
  if (totalCount <= 0) return 0;
  const fullWidth = totalCount * itemWidth + Math.max(0, totalCount - 1) * gap;
  if (availableWidth >= fullWidth) {
    return totalCount;
  }

  const remainingForItems = availableWidth - toggleWidth;
  if (remainingForItems <= 0) {
    return 1;
  }

  const slotWidth = itemWidth + gap;
  const maxFittingWithToggle = Math.floor(remainingForItems / slotWidth);
  return Math.max(1, Math.min(totalCount - 1, maxFittingWithToggle));
}
