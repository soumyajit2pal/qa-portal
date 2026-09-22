import { Fragment, jsx as reactJsx, jsxs as reactJsxs } from 'react/jsx-runtime'
import type { CSSProperties, ElementType } from 'react'
import { mergeCspClassName } from './styleRegistry'

function secureProps(type: ElementType, props: Record<string, unknown> | null): Record<string, unknown> | null {
  if (typeof type !== 'string' || !props?.style) return props
  const { style, ...rest } = props
  return { ...rest, className: mergeCspClassName(props.className, style as CSSProperties) }
}

export function jsx(type: ElementType, props: Record<string, unknown> | null, key?: string) {
  return reactJsx(type, secureProps(type, props), key)
}

export function jsxs(type: ElementType, props: Record<string, unknown> | null, key?: string) {
  return reactJsxs(type, secureProps(type, props), key)
}

export { Fragment }
