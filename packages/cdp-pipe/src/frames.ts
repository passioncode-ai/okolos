/**
 * Splits the pipe's byte stream into CDP messages.
 *
 * Chrome writes each message as JSON followed by a NUL byte
 * (`--remote-debugging-pipe`). A read can end in the middle of a message, so
 * whatever follows the last NUL is carried into the next call rather than
 * parsed or dropped. Empty pieces between two NULs carry no message and are
 * skipped.
 *
 * Moved here from the Б0 spike (`tools/agent-window-spike.mjs`), which imports
 * it from this file.
 */
export function splitFrames(pending: string, chunk: string): { messages: string[]; pending: string } {
  const parts = (pending + chunk).split('\0')
  const rest = parts.pop() ?? ''
  return { messages: parts.filter((p) => p.length > 0), pending: rest }
}
