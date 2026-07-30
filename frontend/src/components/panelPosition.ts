// Shared by every searchable dropdown that renders its option panel with
// `position: fixed` (UserAssignSelect, MultiUserAssignSelect,
// SearchableSelect) -- computes where that panel should sit relative to its
// trigger.
//
// Reported bug: all three previously always opened downward
// (`top: rect.bottom + 4`), unconditionally. When the trigger sits near the
// bottom of the viewport -- e.g. the last control in a request detail
// drawer's "Workflow Actions" panel -- the option list renders below the
// visible browser window with no way to scroll it into view (it's
// `position: fixed`, so page scrolling doesn't help either), making the
// dropdown look empty/broken even though it opened correctly. This flips the
// panel to open upward (anchored to the trigger's top instead of its bottom)
// whenever there isn't enough room below it to fit but there's more room
// above.
export interface PanelPos {
  top: number | 'auto'
  bottom: number | 'auto'
  left: number
  width: number
}

// Rough max height of the search box + option list (see
// .searchable-select-search/.searchable-select-list in index.css).
const PANEL_EST_HEIGHT = 280

export function computePanelPos(rect: DOMRect, minWidth = 0): PanelPos {
  const spaceBelow = window.innerHeight - rect.bottom
  const spaceAbove = rect.top
  const openUp = spaceBelow < PANEL_EST_HEIGHT && spaceAbove > spaceBelow
  const width = Math.max(rect.width, minWidth)
  return openUp
    ? { top: 'auto', bottom: window.innerHeight - rect.top + 4, left: rect.left, width }
    : { top: rect.bottom + 4, bottom: 'auto', left: rect.left, width }
}
