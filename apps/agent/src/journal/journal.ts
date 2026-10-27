/**
 * The agents' journal of Okolos Agent: every answer an agent gets is written here first.
 */
import { mkdirSync } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'

import type { BridgeRefusal, BridgeVerb } from '@okolos/contracts'

import type { RefusalReason } from '../service/http.js'

export type AnyBridgeVerb = BridgeVerb | 'session.open' | 'hygiene.census'
export type DoorRejection = RefusalReason | 'bad_content_type'

export type JournalEntry =
  | {
      readonly at: string
      readonly agent: string
      readonly task?: string
      readonly verb: AnyBridgeVerb
      readonly origin?: string
      readonly outcome: 'answered' | 'refused'
      readonly code?: BridgeRefusal
      readonly bytes?: number
      readonly verdict?: 'clean' | 'finding'
    }
  | {
      readonly at: string
      readonly outcome: 'rejected'
      readonly code: DoorRejection | BridgeRefusal
      readonly origin?: string
      readonly bytes?: number
    }

export class Journal {
  private constructor(
    readonly dir: string,
    readonly retentionDays: number,
  ) {}

  static open(dir: string, options: { retentionDays: number }): Journal {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return new Journal(dir, options.retentionDays)
  }

  async record(entry: JournalEntry): Promise<void> {
    const handle = await open(path.join(this.dir, `${entry.at.slice(0, 10)}.jsonl`), 'a', 0o600)
    try {
      await handle.write(`${JSON.stringify(entry)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}
