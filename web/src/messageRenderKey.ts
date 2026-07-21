import type { Message } from './types'

/** Keep optimistic and persisted versions of one request on the same React fiber. */
export function messageRenderKey(message: Message): string {
  return `${message.role}:${message.request_id || message.id}`
}
