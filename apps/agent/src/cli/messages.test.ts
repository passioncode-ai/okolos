import { describe, expect, it } from 'vitest'

import { CLI_KEYS, cliMessages } from './messages.js'

describe('what the CLI says to the person', () => {
  it('has every sentence in both catalogues, with its values put in', () => {
    for (const locale of ['ru', 'en'] as const) {
      const say = cliMessages(locale)
      expect(say.code('claude-code', 'ABCD-1234')).toContain('ABCD-1234')
      expect(say.notPaired('claude-code')).toContain('okolos-agent pair --name')
      expect(say.saved('/tmp/x.key')).toContain('/tmp/x.key')
      expect(say.exists('scout')).toContain('okolos-agent pair --name "scout" --replace')
      expect(say.releaseFailed('scout', '503')).toContain('503')
    }
    expect(CLI_KEYS.length).toBe(7)
  })
})
