import type { CSSProperties } from 'react'

const registered = new Map<string, string>()
const classDeclarations = new Map<string, string>()
const pendingRules = new Map<string, string>()
let flushScheduled = false

// CSS properties for which React accepts a unitless number. Every other
// non-zero numeric value receives px, matching React's style serialization.
const unitless = new Set([
  'animationIterationCount', 'aspectRatio', 'borderImageOutset', 'borderImageSlice',
  'borderImageWidth', 'boxFlex', 'boxFlexGroup', 'boxOrdinalGroup', 'columnCount',
  'columns', 'flex', 'flexGrow', 'flexNegative', 'flexOrder', 'flexPositive',
  'flexShrink', 'floodOpacity', 'fontWeight', 'gridArea', 'gridColumn',
  'gridColumnEnd', 'gridColumnSpan', 'gridColumnStart', 'gridRow', 'gridRowEnd',
  'gridRowSpan', 'gridRowStart', 'lineClamp', 'lineHeight', 'opacity', 'order',
  'orphans', 'scale', 'stopOpacity', 'strokeDasharray', 'strokeDashoffset',
  'strokeMiterlimit', 'strokeOpacity', 'strokeWidth', 'tabSize', 'widows',
  'zIndex', 'zoom', 'fillOpacity',
])

function cssPropertyName(name: string): string {
  if (name.startsWith('--')) return name
  const hyphenated = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
  // The lower-case ms prefix is the one vendor prefix that does not acquire
  // a leading dash from the camel-case conversion above.
  return hyphenated.replace(/^ms-/, '-ms-')
}

function cssValue(name: string, value: unknown): string | null {
  if (value == null || value === '' || typeof value === 'boolean') return null
  if (typeof value === 'number') {
    if (value === 0 || name.startsWith('--') || unitless.has(name)) return String(value)
    return `${value}px`
  }
  return String(value)
}

function hash(value: string): string {
  let current = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    current ^= value.charCodeAt(index)
    current = Math.imul(current, 16777619)
  }
  return (current >>> 0).toString(36)
}

function runtimeSheet(): CSSStyleSheet | null {
  if (typeof document === 'undefined') return null
  const link = document.getElementById('qap-csp-runtime-styles') as HTMLLinkElement | null
  try { return link?.sheet as CSSStyleSheet | null }
  catch { return null }
}

function flushRules(): void {
  flushScheduled = false
  const sheet = runtimeSheet()
  if (!sheet) {
    if (pendingRules.size) scheduleFlush()
    return
  }
  for (const [className, declaration] of pendingRules) {
    try {
      sheet.insertRule(`.${className}{${declaration}}`, sheet.cssRules.length)
      pendingRules.delete(className)
    } catch {
      // Invalid CSS is ignored exactly as an invalid React style value would
      // be; never fall back to an inline style attribute.
      pendingRules.delete(className)
    }
  }
}

function scheduleFlush(): void {
  if (flushScheduled || typeof window === 'undefined') return
  flushScheduled = true
  window.requestAnimationFrame(flushRules)
}

function declarationFor(style: CSSProperties): string {
  if (typeof document === 'undefined') return ''
  // Use the browser's CSS parser instead of concatenating raw values. This
  // prevents a data-derived value from escaping its declaration and turning
  // into another CSS rule.
  const parsed = document.createElement('span').style
  Object.entries(style).sort(([left], [right]) => left.localeCompare(right)).forEach(([name, rawValue]) => {
    const value = cssValue(name, rawValue)
    if (value == null) return
    try { parsed.setProperty(cssPropertyName(name), value, 'important') }
    catch { /* Ignore unsupported properties. */ }
  })
  return parsed.cssText
}

/** Convert a React style object to a class without emitting a style attribute. */
export function cspStyleClass(style?: CSSProperties | null): string {
  if (!style || !Object.keys(style).length) return ''
  const declaration = declarationFor(style)
  if (!declaration) return ''
  const existing = registered.get(declaration)
  if (existing) return existing
  const baseClassName = `qap-is-${hash(declaration)}`
  let className = baseClassName
  let collision = 1
  while (classDeclarations.has(className) && classDeclarations.get(className) !== declaration) {
    className = `${baseClassName}-${collision}`
    collision += 1
  }
  registered.set(declaration, className)
  classDeclarations.set(className, declaration)
  pendingRules.set(className, declaration)
  flushRules()
  return className
}

export function mergeCspClassName(className: unknown, style?: CSSProperties | null): string | undefined {
  const generated = cspStyleClass(style)
  return [typeof className === 'string' ? className : '', generated].filter(Boolean).join(' ') || undefined
}
