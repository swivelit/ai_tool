import { Fragment, isValidElement } from 'react'
import type { ReactNode } from 'react'


export function codeNodeText(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return `${node}`
  if (Array.isArray(node)) return node.map(codeNodeText).join('')
  if (
    isValidElement<{ children?: ReactNode }>(node)
    && node.type === Fragment
  ) {
    return codeNodeText(node.props.children)
  }
  return ''
}
