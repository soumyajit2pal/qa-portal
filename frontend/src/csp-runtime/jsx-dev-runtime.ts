import { Fragment, jsxDEV as reactJsxDEV } from 'react/jsx-dev-runtime'
import type { CSSProperties, ElementType } from 'react'
import { mergeCspClassName } from './styleRegistry'

function secureProps(type: ElementType, props: Record<string, unknown> | null): Record<string, unknown> | null {
  if (typeof type !== 'string' || !props?.style) return props
  const { style, ...rest } = props
  return { ...rest, className: mergeCspClassName(props.className, style as CSSProperties) }
}

export function jsxDEV(
  type: ElementType,
  props: Record<string, unknown> | null,
  key: string | undefined,
  isStaticChildren: boolean,
  source: unknown,
  self: unknown,
) {
  return reactJsxDEV(type, secureProps(type, props), key, isStaticChildren, source as any, self as any)
}

export { Fragment }
