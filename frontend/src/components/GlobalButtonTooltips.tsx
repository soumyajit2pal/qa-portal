import { useEffect } from 'react'

const AUTO_TITLE_ATTRIBUTE = 'data-auto-button-title'

function normalizedButtonLabel(button: HTMLButtonElement): string {
  // innerText reflects what the user can actually see (unlike textContent,
  // which can include hidden accessibility/layout copy). Collapse line breaks
  // from icon + label or multi-line buttons into one readable tooltip.
  const visibleText = button.innerText.replace(/\s+/g, ' ').trim()
  const accessibleLabel = (button.getAttribute('aria-label') || '').trim()
  // A lone icon glyph (×, i, ‹, etc.) is technically visible text but not a
  // useful explanation. Prefer its authored accessible name in that case.
  const iconOnly = visibleText.length <= 1 || /^[×+\-‹›⌄⌃✓↩→←⋮…]+$/.test(visibleText)
  return (iconOnly && accessibleLabel) ? accessibleLabel : (visibleText || accessibleLabel)
}

function applyTooltip(button: HTMLButtonElement) {
  // Preserve deliberately authored titles such as disabled-state explanations.
  // Titles generated here are marked so changing labels like Saving…/Saved can
  // keep the hover text synchronized automatically.
  if (button.hasAttribute('title') && !button.hasAttribute(AUTO_TITLE_ATTRIBUTE)) return

  const label = normalizedButtonLabel(button)
  if (!label) {
    if (button.hasAttribute(AUTO_TITLE_ATTRIBUTE)) {
      button.removeAttribute('title')
      button.removeAttribute(AUTO_TITLE_ATTRIBUTE)
    }
    return
  }

  button.title = label
  button.setAttribute(AUTO_TITLE_ATTRIBUTE, 'true')
}

function applyWithin(root: ParentNode) {
  if (root instanceof HTMLButtonElement) applyTooltip(root)
  root.querySelectorAll<HTMLButtonElement>('button').forEach(applyTooltip)
}

// Application-wide button hover labels. A MutationObserver is required
// because most workflow actions, table controls and modal buttons render
// after route changes rather than existing in the initial document tree.
export default function GlobalButtonTooltips() {
  useEffect(() => {
    applyWithin(document)

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          const button = mutation.target.parentElement?.closest('button')
          if (button) applyTooltip(button)
          continue
        }
        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element) applyWithin(node)
        })
        const changedButton = (mutation.target as Element).closest?.('button')
        if (changedButton) applyTooltip(changedButton as HTMLButtonElement)
      }
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    return () => observer.disconnect()
  }, [])

  return null
}
