export const NATIVE_MESSAGE_LIMIT: number

export function splitFrames(pending: string, chunk: string): { messages: string[]; pending: string }

export function compactAxTree(
  nodes: Array<{ nodeId: string; ignored?: boolean; role?: { value?: string }; name?: { value?: string } }>,
  nameLimit?: number,
): { text: string; kept: number }

export function chunksNeeded(bytes: number, limit?: number): number
