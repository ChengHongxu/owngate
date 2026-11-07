export interface HelpAnchor { left: number; top: number; right: number; bottom: number }

/** Keep short help readable next to its trigger, including near viewport edges. */
export function helpPosition(anchor: HelpAnchor, box: { width: number; height: number }, viewport: { width: number; height: number }) {
  const margin = 12, gap = 8
  const width = Math.min(box.width, Math.max(0, viewport.width - margin * 2))
  const maxHeight = Math.max(0, viewport.height - margin * 2)
  const height = Math.min(box.height, maxHeight)
  const left = Math.min(Math.max(margin, (anchor.left + anchor.right - width) / 2), Math.max(margin, viewport.width - width - margin))
  const below = anchor.bottom + gap
  const preferredTop = below + height <= viewport.height - margin ? below : anchor.top - gap - height
  const top = Math.min(Math.max(margin, preferredTop), Math.max(margin, viewport.height - height - margin))
  return { left, top, maxHeight }
}
