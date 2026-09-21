export const TABLE_ROW_INTERACTIVE_SELECTOR =
  "button,a,input,select,textarea,[role='button'],[role='link']"

type ClosestTarget = {
  closest: (selector: string) => unknown
}

/**
 * A clickable table row has role="button" for keyboard accessibility. The
 * row itself must not be mistaken for a nested interactive control when a
 * cell or its plain content is clicked.
 */
export function shouldActivateTableRow(target: ClosestTarget, row: unknown): boolean {
  const interactive = target.closest(TABLE_ROW_INTERACTIVE_SELECTOR)
  return interactive == null || interactive === row
}
