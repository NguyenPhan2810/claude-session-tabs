import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  badge,
  clientShowing,
  descendsFrom,
  formatAge,
  isRegistryFile,
  orderSessions,
  parseLivePids,
  parseProcessTable,
  parseSession,
  parseStat,
  pick,
  tmuxPane,
} from '../hooks/model'

const NOW = 1_800_000_000_000
const HOME = '/home/u'
const DIR = `${HOME}/.claude/sessions`
const START = { cwd: '/home/u/dev/app', surface: 'terminal' as const, isInteractive: true }

const record = (over: Record<string, unknown>) =>
  JSON.stringify({
    kind: 'interactive',
    cwd: '/home/u/dev/app',
    status: 'idle',
    startedAt: NOW - 3_600_000,
    statusUpdatedAt: NOW - 120_000,
    ...over,
  })

// This session (pid 100, pane %8), and the others the registry holds.
const SELF = record({ pid: 100, procStart: '1000', sessionId: 'self', name: 'app-main', tmux: '0:@4.%8', startedAt: NOW - 7_200_000 })
const OTHER = record({ pid: 200, procStart: '2000', sessionId: 'other', name: 'app-tests', tmux: '0:@4.%7', status: 'busy' })
const ASKING = record({ pid: 300, procStart: '3000', sessionId: 'asking', name: 'docs', waitingFor: 'input needed', status: 'waiting' })
const CRASHED = record({ pid: 400, procStart: '4000', sessionId: 'crashed', name: 'ghost', startedAt: NOW - 9_000_000 })
const REUSED = record({ pid: 500, procStart: '5000', sessionId: 'reused', name: 'recycled' })

const FILES: Record<string, string> = {
  '100.json': SELF,
  '100.abc.key': 'secret',
  '200.json': OTHER,
  '300.json': ASKING,
  '400.json': CRASHED,
  '500.json': REUSED,
}

/** Running processes: pid → parent and start time. 10 and 20 are the tmux panes' shells. */
const PROCS: Record<number, { ppid: number; start: string }> = {
  10: { ppid: 1, start: '10' },
  20: { ppid: 1, start: '20' },
  100: { ppid: 10, start: '1000' },
  200: { ppid: 20, start: '2000' },
  300: { ppid: 1, start: '3000' },
  500: { ppid: 1, start: '9999' }, // pid 500 now belongs to some other program
}

/** A /proc/<pid>/stat line, with a process name holding a space and a parenthesis. */
const statOf = (pid: number, p: { ppid: number; start: string }) =>
  `${pid} (cl (aude) S ${p.ppid} ${Array(17).fill(0).join(' ')} ${p.start} 0 0`

/** A command as typed at the prompt. */
const TYPED = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 200 } }

const PANE = {
  plugin: 'session-tabs',
  component: 'Pane' as const,
  requestId: 'session-tabs',
  props: {
    title: 'Sessions',
    isFocused: false,
    bodyColumns: 30,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
}

type Machine = {
  files?: Record<string, string>
  links?: string[]
  hasProc?: boolean
  /** tmux pane → the pid of the shell it runs; a pane not listed isn't on this server. */
  panes?: Record<string, number>
  env?: Record<string, string>
  stored?: Record<string, unknown>
  /** `claude agents --json` pids, for the machine without /proc. */
  agents?: number[]
  failTmux?: boolean
  failSessionId?: boolean
}

/** Stands in for the computer beneath the plugin: the registry folder, /proc, tmux, ps and the panes. */
function machine(on: On, m: Machine = {}) {
  const files = m.files ?? FILES
  const panes = m.panes ?? { '%7': 20, '%8': 10 }
  const reads: string[] = []
  const runs: string[][] = []
  const open = new Set<string>()
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, m.stored ?? {})
  mock.env(on, m.env ?? { HOME, TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%8' })
  // Nothing beneath the plugin answers these in a test, so the machine does
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => (m.failSessionId ? { deny: 'no session yet' } : { value: 'self' }))
  on('ui.open', async (_$, e) => {
    open.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', async (_$, e) => {
    open.delete(e.id)
    return { value: undefined }
  })
  on('ui.log', async () => ({ value: undefined }))
  on('ui.panes', async () => ({
    value: [...open].map(id => ({ id, title: 'Sessions', isShown: true, isFocused: false, isPlaced: true, plugin: 'session-tabs' })),
  }))
  on('fs.exists', async (_$, e) => ({ value: e.path === '/proc/self/stat' ? (m.hasProc ?? true) : false }))
  on('fs.list', async () => ({
    value: [...Object.keys(files), ...(m.links ?? [])].map(name => ({
      name,
      kind: 'file' as const,
      size: 1,
      mtimeMs: NOW,
      isLink: (m.links ?? []).includes(name),
    })),
  }))
  on('fs.read', async (_$, e) => {
    reads.push(e.path)
    const proc = e.path.match(/^\/proc\/(\d+)\/stat$/)
    if (proc !== null) {
      const p = PROCS[Number(proc[1])]
      return p !== undefined && (m.hasProc ?? true) ? { value: statOf(Number(proc[1]), p) } : { deny: 'ENOENT' }
    }
    const text = files[e.path.slice(DIR.length + 1)]
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const out = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'failed', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (argv[0] === 'claude') return out(JSON.stringify((m.agents ?? []).map(pid => ({ pid }))))
    if (argv[0] === 'ps') return out(Object.entries(PROCS).map(([pid, p]) => `${pid} ${p.ppid}`).join('\n'))
    if (argv[0] !== 'tmux') return out('', 127)
    if (m.failTmux) return { deny: 'tmux is not allowed' }
    if (argv[1] === 'display-message') {
      const pid = panes[argv[4]!]
      return pid === undefined ? out('', 1) : out(`${pid}\n`)
    }
    if (argv[1] === 'list-clients') return out('100 /dev/pts/1 %8\n200 /dev/pts/2 %3\n')
    return out('')
  })
  const switches = () => runs.filter(argv => argv[0] === 'tmux' && argv[1] === 'switch-client')
  return { reads, runs, switches, open, clock }
}

describe('model', () => {
  test('reads a session record and ignores anything else', async () => {
    expect(parseSession(OTHER)).toMatchObject({ pid: 200, sessionId: 'other', name: 'app-tests', procStart: '2000' })
    expect(parseSession('{"pid":1}')).toBeNull()
    expect(parseSession('not json')).toBeNull()
    expect(parseSession(record({ pid: 5, sessionId: 'x', name: undefined }))?.name).toBe('app')
  })

  test('only <pid>.json files count, never the .key secrets beside them', async () => {
    expect(isRegistryFile('1362077.json')).toBe(true)
    expect(isRegistryFile('1362077.5941d4.key')).toBe(false)
    expect(isRegistryFile('notes.json')).toBe(false)
  })

  test('reads /proc stat lines and ps tables', async () => {
    expect(parseStat(statOf(100, { ppid: 10, start: '1000' }))).toEqual({ ppid: 10, startTime: '1000' })
    expect(parseStat('garbage')).toBeNull()
    expect(parseProcessTable('  1     0\n 42  1\nbad line\n')).toEqual(new Map([[1, 0], [42, 1]]))
  })

  test('follows parents to find whether a process runs under another', async () => {
    const parents = new Map([[100, 10], [10, 1]])
    const parentOf = async (pid: number) => parents.get(pid)
    expect(await descendsFrom(100, 10, parentOf)).toBe(true)
    expect(await descendsFrom(100, 100, parentOf)).toBe(true)
    expect(await descendsFrom(100, 20, parentOf)).toBe(false)
  })

  test('an empty or broken claude agents answer is not trusted', async () => {
    expect([...(parseLivePids('[{"pid":1},{"pid":2,"x":3}]') ?? [])]).toEqual([1, 2])
    expect(parseLivePids('[]')).toBeNull()
    expect(parseLivePids('oops')).toBeNull()
  })

  test('keeps the newest record of a session and orders by start time', async () => {
    const older = parseSession(record({ pid: 7, sessionId: 'dup', name: 'old', startedAt: NOW - 5_000 }))!
    const newer = parseSession(record({ pid: 8, sessionId: 'dup', name: 'new', startedAt: NOW - 1_000 }))!
    const first = parseSession(record({ pid: 9, sessionId: 'first', name: 'first', startedAt: NOW - 9_000 }))!
    expect(orderSessions([newer, older, first]).map(s => s.name)).toEqual(['first', 'new'])
    expect(orderSessions([older, newer]).map(s => s.pid)).toEqual([8])
  })

  test('picks the most recently used client showing a pane', async () => {
    expect(clientShowing('5 /dev/pts/1 %8\n9 /dev/pts/4 %8\n7 /dev/pts/2 %3', '%8')).toBe('/dev/pts/4')
    expect(clientShowing('5 /dev/pts/1 %8', '%9')).toBeUndefined()
  })

  test('badges, panes, ages and picking by number or name', async () => {
    expect(badge(parseSession(OTHER)!).tone).toBe('working')
    expect(badge(parseSession(ASKING)!)).toMatchObject({ tone: 'needs', label: 'input needed' })
    expect(badge(parseSession(SELF)!).tone).toBe('idle')
    expect(tmuxPane('0:@4.%7')).toBe('%7')
    expect(tmuxPane('main:@12.%30')).toBe('%30')
    expect(tmuxPane(undefined)).toBeNull()
    expect(tmuxPane('garbage')).toBeNull()
    expect([5_000, 120_000, 7_200_000, 200_000_000].map(formatAge)).toEqual(['<1m', '2m', '2h', '2d'])
    const tabs = orderSessions([SELF, OTHER, ASKING].map(text => parseSession(text)!))
    expect(pick(tabs, '1')?.name).toBe('app-main')
    expect(pick(tabs, 'app-t')?.name).toBe('app-tests')
    expect(pick(tabs, 'DOCS')?.name).toBe('docs')
    expect(pick(tabs, '9')).toBeUndefined()
  })
})

describe('sidebar', () => {
  test('lists the running sessions; hides a crashed one and one whose pid was reused', async ($, on) => {
    const { reads } = machine(on, { links: ['600.json'] })
    await $.session.start(START)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ type: 'Text', text: /3 sessions/ }))?.text).toContain('1 needs you')
      expect(await ui.find({ text: 'ghost' })).toBeUndefined()
      expect(await ui.find({ text: 'recycled' })).toBeUndefined()
      expect(await ui.find({ key: 'go-other' })).toBeDefined()
      expect(await ui.find({ key: 'go-self' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /input needed 2m · app/ })).toBeDefined()
      await ui.unmount()
    }
    expect(reads.some(path => path.endsWith('.key'))).toBe(false)
    expect(reads.some(path => path.endsWith('600.json'))).toBe(false)
  })

  test('pressing a session switches the terminal showing this one to its pane', async ($, on) => {
    const { switches } = machine(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'go-other' })
    expect(switches()).toEqual([['tmux', 'switch-client', '-c', '/dev/pts/1', '-t', '%7']])
    await ui.unmount()
  })

  test('/tabs <name> switches without opening the sidebar', async ($, on) => {
    const { switches } = machine(on)
    await $.session.start(START)
    await $.command.run({ ...TYPED, command: 'tabs', args: 'app-tests' })
    expect(switches()).toEqual([['tmux', 'switch-client', '-c', '/dev/pts/1', '-t', '%7']])
  })

  test('a pane with the same id on this tmux server but another program in it is not switched to', async ($, on) => {
    const { switches } = machine(on, { panes: { '%7': 300, '%8': 10 } })
    await $.session.start(START)
    await $.command.run({ ...TYPED, command: 'tabs', args: 'app-tests' })
    expect(switches()).toEqual([])
  })

  test('a pane that is not on this tmux server is not switched to', async ($, on) => {
    const { switches } = machine(on, { panes: { '%8': 10 } })
    await $.session.start(START)
    await $.command.run({ ...TYPED, command: 'tabs', args: 'app-tests' })
    expect(switches()).toEqual([])
  })

  test('nothing runs tmux for a session outside tmux, from outside tmux, or for this session', async ($, on) => {
    const { runs } = machine(on, { env: { HOME } })
    await $.session.start(START)
    await $.command.run({ ...TYPED, command: 'tabs', args: 'docs' })
    await $.command.run({ ...TYPED, command: 'tabs', args: 'app-tests' })
    await $.command.run({ ...TYPED, command: 'tabs', args: '1' })
    expect(runs.some(argv => argv[0] === 'tmux')).toBe(false)
  })

  test('a tmux failure is reported, not thrown', async ($, on) => {
    const { switches } = machine(on, { failTmux: true })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'go-other' })
    expect(switches()).toEqual([])
    await ui.unmount()
  })

  test('opens by itself in a new session', async ($, on) => {
    const { open, clock } = machine(on)
    await $.session.start(START)
    await clock.settle()
    expect([...open]).toEqual(['session-tabs'])
  })

  test('stays closed when the person closed it, and polls nothing while closed', async ($, on) => {
    const { open, reads, clock } = machine(on, { stored: { autoOpen: false } })
    await $.session.start(START)
    await clock.settle()
    expect([...open]).toEqual([])
    const before = reads.length
    await clock.advance(10_000)
    expect(reads.length).toBe(before)

    await $.command.run({ ...TYPED, command: 'tabs', args: '' })
    expect([...open]).toEqual(['session-tabs'])
    const opened = reads.length
    await clock.advance(2_000)
    expect(reads.length).toBeGreaterThan(opened)
  })

  test('a failing refresh does not stop the session from starting', async ($, on) => {
    const { open, clock } = machine(on, { failSessionId: true })
    await $.session.start(START)
    await clock.settle()
    await $.command.run({ ...TYPED, command: 'tabs', args: '' })
    expect([...open]).toEqual([])
    await $.command.run({ ...TYPED, command: 'tabs', args: '' })
    expect([...open]).toEqual(['session-tabs'])
  })

  test('a headless run does no work', async ($, on) => {
    const { runs, reads } = machine(on)
    await $.session.start({ cwd: '/home/u/dev/app', surface: null, isInteractive: false })
    expect(runs).toEqual([])
    expect(reads).toEqual([])
  })
})

describe('without /proc', () => {
  test('claude agents --json decides which sessions are running; this one always shows', async ($, on) => {
    const { clock } = machine(on, { hasProc: false, agents: [200, 300] })
    await $.session.start(START)
    await clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /3 sessions/ })).toBeDefined()
    expect(await ui.find({ text: 'ghost' })).toBeUndefined()
    expect(await ui.find({ text: /app-main/ })).toBeDefined()
    await ui.unmount()
  })

  test('an empty answer hides nothing', async ($, on) => {
    const { clock } = machine(on, { hasProc: false, agents: [] })
    await $.session.start(START)
    await clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /5 sessions/ })).toBeDefined()
    await ui.unmount()
  })

  test('switching checks the pane with ps', async ($, on) => {
    const { switches, runs } = machine(on, { hasProc: false, agents: [100, 200] })
    await $.session.start(START)
    await $.command.run({ ...TYPED, command: 'tabs', args: 'app-tests' })
    expect(runs).toContainEqual(['ps', '-A', '-o', 'pid=,ppid='])
    expect(switches()).toEqual([['tmux', 'switch-client', '-c', '/dev/pts/1', '-t', '%7']])
  })
})
