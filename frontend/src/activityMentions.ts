export interface ActivityMentionUser { id: number; username: string; full_name?: string | null }

/** Read only the token immediately before the caret, retaining its DOM range. */
export function activityMentionAtCaret(editor: HTMLDivElement | null): { query: string; range: Range } | null {
  const selection = editor?.ownerDocument?.getSelection?.()
  if (!editor || !selection?.isCollapsed || !selection.rangeCount) return null
  const caret = selection.getRangeAt(0)
  const node = caret.startContainer
  if (node.nodeType !== 3 || !editor.contains(node) || node.parentElement?.closest('a, code, pre')) return null
  const before = (node.textContent || '').slice(0, caret.startOffset)
  const match = /(?:^|[\s(])@([A-Za-z0-9._-]{0,64})$/.exec(before)
  if (!match) return null
  const range = caret.cloneRange()
  range.setStart(node, caret.startOffset - match[1].length - 1)
  return { query: match[1], range }
}

export function insertActivityMention(editor: HTMLDivElement | null, range: Range | null, username: string): boolean {
  if (!editor || !range || !editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return false
  // Directory usernames may include a domain or email-style login. Brackets
  // distinguish an explicit mention from an ordinary pasted email address.
  const token = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(username) && !username.endsWith('.')
    ? `@${username}` : `@[${username}]`
  const text = editor.ownerDocument.createTextNode(`${token} `)
  range.deleteContents()
  range.insertNode(text)
  range.setStartAfter(text)
  range.collapse(true)
  const selection = editor.ownerDocument.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  editor.focus()
  return true
}
