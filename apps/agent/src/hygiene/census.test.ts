import { describe, expect, it } from 'vitest'

import { census, readCensus } from './census.js'

const NOW = new Date(2026, 10, 19, 12, 0, 0).getTime()
const PROFILE = '/Users/p/Library/Application Support/okolos-agent/profiles/agent'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

interface Proc {
  readonly ps: string
  readonly command: string
}

/** A process as both `ps` readings show it, started `ago` seconds before NOW. */
function proc(pid: number, ppid: number, ago: number, executable: string, args = ''): Proc {
  const d = new Date(NOW - ago * 1000)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const t = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
  const start = `${days[d.getDay()]} ${months[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${t} ${d.getFullYear()}`
  return {
    ps: `${String(pid).padStart(6)} ${String(ppid).padStart(6)} ${start}     ${executable}`,
    command: `${String(pid).padStart(6)} ${executable}${args === '' ? '' : ` ${args}`}`,
  }
}

const LAUNCHCTL = ['PID\tStatus\tLabel', '-\t0\tcom.apple.idle', '700\t0\tcom.example.render-farm', ''].join('\n')

function run(procs: Proc[]): ReturnType<typeof census> {
  return census(
    { ps: procs.map((p) => p.ps).join('\n'), commands: procs.map((p) => p.command).join('\n'), launchctl: LAUNCHCTL },
    { selfPid: 50, agentProfileDir: PROFILE, now: NOW },
  )
}

describe('census (N-012, REQ-62)', () => {
  it('keeps a debugging browser whose session parent runs, and names the session as its owner', () => {
    const [entry] = run([
      proc(300, 1, 900, '/usr/local/bin/claude', '--resume'),
      proc(310, 300, 600, CHROME, '--remote-debugging-port=9222 --user-data-dir=/tmp/x'),
    ])
    expect(entry).toEqual({
      pid: 310,
      ppid: 300,
      executable: CHROME,
      owner: 'claude',
      ageSeconds: 600,
      flags: ['--remote-debugging-port'],
      keep: true,
      reason: 'live-session',
    })
  })

  it('keeps a browser a launchd job runs with ppid 1, as an OS service', () => {
    const [entry] = run([proc(700, 1, 60, '/opt/bin/chrome-headless-shell', '--headless --remote-debugging-pipe')])
    expect(entry).toMatchObject({ owner: 'com.example.render-farm', keep: true, reason: 'os-service' })
  })

  it("keeps the person's Chrome without automation flags", () => {
    const [entry] = run([proc(400, 1, 86_400, CHROME, '--restore-last-session')])
    expect(entry).toMatchObject({ owner: null, keep: true, reason: 'persons-browser', flags: [] })
  })

  it('marks a headless shell on a $TMPDIR profile whose parent is gone an orphan, and ends nothing', () => {
    const [entry] = run([
      proc(500, 1, 7200, '/Users/p/Library/Caches/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell', '--headless --remote-debugging-pipe --user-data-dir=/var/folders/xy/T/playwright_profile'),
    ])
    expect(entry).toMatchObject({ keep: false, reason: 'orphan', owner: null, ageSeconds: 7200 })
  })

  it('keeps the agents own Chrome, and never reports the daemon itself or a browser helper', () => {
    const entries = run([
      proc(50, 1, 10, CHROME, '--remote-debugging-pipe --user-data-dir=/elsewhere'),
      proc(600, 50, 10, CHROME, `--no-startup-window --remote-debugging-pipe --user-data-dir=${PROFILE}`),
      proc(601, 600, 10, `${CHROME} Helper (Renderer)`, `--type=renderer --user-data-dir=${PROFILE}`),
      proc(602, 600, 10, '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/chrome_crashpad_handler', '--database=/x'),
    ])
    expect(entries).toEqual([expect.objectContaining({ pid: 600, owner: 'okolos-agent', keep: true, reason: 'agents-browser' })])
  })

  it('never carries a token or any other value from the command line', () => {
    const entries = run([
      proc(300, 1, 900, '/usr/local/bin/node', 'runner.js --token=SECRET-ABC'),
      proc(310, 300, 60, CHROME, '--remote-debugging-port=9222 --token=SECRET-XYZ --user-data-dir=/Users/p/secret-profile https://bank.example/?sid=SECRET-SID'),
    ])
    const text = JSON.stringify(entries)
    expect(text).not.toContain('SECRET')
    expect(text).not.toContain('9222')
    expect(text).not.toContain('bank.example')
    expect(entries[0]).toMatchObject({ pid: 310, executable: CHROME, owner: 'node', ageSeconds: 60, flags: ['--remote-debugging-port'] })
  })

  it('skips lines it cannot read and processes it does not watch', () => {
    expect(run([{ ps: 'garbage', command: 'garbage' }, proc(1, 0, 10, '/sbin/launchd'), proc(9, 1, 10, '/usr/bin/vim', 'notes')])).toEqual([])
  })

  it('reads this machine without failing (launchctl optional)', async () => {
    const entries = await readCensus({ selfPid: process.pid, agentProfileDir: PROFILE })
    expect(Array.isArray(entries)).toBe(true)
    for (const entry of entries) expect(entry.executable).not.toMatch(/\s--/)
  })
})
