import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  badge,
  clientShowing,
  cleanTitle,
  descendsFrom,
  firstPrompt,
  isConversation,
  isRegistryFile,
  MAX_TABS,
  MISSING_GRACE_MS,
  openTabs,
  orderSessions,
  parseProcessTable,
  parseRoster,
  parseSession,
  parseStat,
  pick,
  SPINNER,
  SPIN_MS,
  syncTabs,
  tabBadge,
  tabTitle,
  titleFromPrompt,
  tmuxLiteral,
  tmuxPane,
  windowName,
  type Session,
  type TabRecord,
} from '../hooks/model'

const NOW = 1_800_000_000_000
const HOME = '/home/u'
const DIR = `${HOME}/.claude/sessions`
const START = { cwd: '/home/u/dev/app', surface: 'terminal' as const, isInteractive: true }

const id = (n: number) => `a${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`
const SELF_ID = id(1)
const OTHER_ID = id(2)
const ASKING_ID = id(3)
const CRASHED_ID = id(4)
const REUSED_ID = id(5)
const JOB_ID = id(6)

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
const SELF = record({ pid: 100, procStart: '1000', sessionId: SELF_ID, name: 'app-main', tmux: '0:@4.%8', startedAt: NOW - 7_200_000 })
const OTHER = record({ pid: 200, procStart: '2000', sessionId: OTHER_ID, name: 'app-tests', tmux: '0:@4.%7', status: 'busy', cwd: '/home/u/dev/tests' })
const ASKING = record({ pid: 300, procStart: '3000', sessionId: ASKING_ID, name: 'docs', waitingFor: 'input needed', status: 'waiting' })
const CRASHED = record({ pid: 400, procStart: '4000', sessionId: CRASHED_ID, name: 'ghost', startedAt: NOW - 9_000_000 })
const REUSED = record({ pid: 500, procStart: '5000', sessionId: REUSED_ID, name: 'recycled' })
const SPARE = record({ pid: 600, procStart: '6000', sessionId: id(7), name: 'spare', kind: 'bg', spare: true })
const PARKED = record({ pid: 700, procStart: '7000', sessionId: id(8), name: 'client', parkedJobId: 'job1' })
const HEADLESS = record({ pid: 800, procStart: '8000', sessionId: id(10), name: 'script', kind: 'print' })

const files = (): Record<string, string> => ({
  '100.json': SELF,
  '100.abc.key': 'secret',
  '200.json': OTHER,
  '300.json': ASKING,
  '400.json': CRASHED,
  '500.json': REUSED,
  '600.json': SPARE,
  '700.json': PARKED,
  '800.json': HEADLESS,
})

/** A background session the supervisor runs, as `claude agents --json --all` lists it. */
const JOB = { id: 'b6e1f00d', kind: 'background', sessionId: JOB_ID, name: 'nightly-refactor', cwd: '/home/u/dev/api', state: 'running', startedAt: NOW - 600_000 }

/** Running processes: pid → parent and start time. 10 and 20 are the tmux panes' shells. */
const PROCS: Record<number, { ppid: number; start: string }> = {
  10: { ppid: 1, start: '10' },
  20: { ppid: 1, start: '20' },
  100: { ppid: 10, start: '1000' },
  200: { ppid: 20, start: '2000' },
  300: { ppid: 1, start: '3000' },
  500: { ppid: 1, start: '9999' }, // pid 500 now belongs to some other program
  600: { ppid: 1, start: '6000' },
  700: { ppid: 1, start: '7000' },
  800: { ppid: 1, start: '8000' },
}

/** A /proc/<pid>/stat line, with a process name holding a space and a parenthesis. */
const statOf = (pid: number, p: { ppid: number; start: string }) =>
  `${pid} (cl (aude) S ${p.ppid} ${Array(17).fill(0).join(' ')} ${p.start} 0 0`

/** A command as typed at the prompt. */
const TYPED = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 200 } }
const tabs = (args: string) => ({ ...TYPED, command: 'tabs', args })

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
  /** The background sessions `claude agents` lists; the array can change during a test. */
  jobs?: object[]
  failClaude?: boolean
  failTmux?: boolean
  failSessionId?: boolean
  /** Sessions whose conversation Claude Code saved. */
  transcripts?: string[]
  /** Folders that no longer exist. */
  gone?: string[]
  /** This session's conversation, as `$.session.messages()` returns it. */
  messages?: { role: 'user' | 'assistant'; text: string }[]
  /** What the small model answers when asked for a title; undefined refuses the call. */
  modelReply?: string
  /** False: the sidebar is open but not on screen (too narrow, or behind another pane). */
  placed?: boolean
}

/** Stands in for the computer beneath the plugin: the registry, /proc, claude agents, tmux, ps and the panes. */
function machine(on: On, m: Machine = {}) {
  const registry = m.files ?? files()
  const panes = m.panes ?? { '%7': 20, '%8': 10 }
  const tags = new Map<string, string>()
  const jobs = m.jobs ?? []
  const transcripts = m.transcripts ?? [SELF_ID, OTHER_ID, ASKING_ID]
  const reads: string[] = []
  const runs: string[][] = []
  const toasts: string[] = []
  const prompts: string[] = []
  let redraws = 0
  const open = new Set<string>()
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, m.stored ?? {})
  mock.env(on, m.env ?? { HOME, PATH: '/usr/bin', TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%8' })
  // Nothing beneath the plugin answers these in a test, so the machine does
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => (m.failSessionId ? { deny: 'no session yet' } : { value: SELF_ID }))
  on('ui.open', async (_$, e) => {
    open.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', async (_$, e) => {
    open.delete(e.id)
    return { value: undefined }
  })
  on('ui.log', async () => ({ value: undefined }))
  on('session.cwd', async () => ({ value: '/home/u/dev/app' }))
  on('session.messages', async () => ({ value: (m.messages ?? []).map(msg => ({ ...msg, toolUses: [] })) }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('model.complete', async (_$, e) => {
    prompts.push(typeof e.prompt === 'string' ? e.prompt : '')
    if (m.modelReply === undefined) return { deny: 'no model here' }
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: { isAnswered: true as const, text: m.modelReply, usage } }
  })
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.panes', async () => ({
    value: [...open].map(id => ({ id, title: 'Sessions', isShown: m.placed ?? true, isFocused: false, isPlaced: m.placed ?? true, plugin: 'session-tabs' })),
  }))
  on('ui.invalidate', async (_$, e, next) => {
    redraws += 1
    return next(e)
  })
  on('fs.exists', async (_$, e) => {
    if (e.path === '/proc/self/stat') return { value: m.hasProc ?? true }
    const transcript = e.path.match(/^\/home\/u\/\.claude\/projects\/[^/]+(?:\/([^/]+)\.jsonl)?$/)
    if (transcript !== null) return { value: transcript[1] === undefined || transcripts.includes(transcript[1]) }
    return { value: e.path.startsWith('/home/u/dev/') && !(m.gone ?? []).includes(e.path) }
  })
  on('fs.list', async () => ({
    value: [...Object.keys(registry), ...(m.links ?? [])].map(name => ({
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
    const text = registry[e.path.slice(DIR.length + 1)]
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const out = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'failed', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (argv[0] === 'claude') {
      if (m.failClaude) return out('', 1)
      const interactive = Object.values(registry)
        .map(text => parseSession(text))
        .filter((s): s is Session => s !== null && s.kind === 'interactive' && PROCS[s.pid]?.start === s.procStart)
        .map(s => ({ pid: s.pid, kind: 'interactive', sessionId: s.sessionId }))
      return out(JSON.stringify([...interactive, ...jobs]))
    }
    if (argv[0] === 'ps') return out(Object.entries(PROCS).map(([pid, p]) => `${pid} ${p.ppid}`).join('\n'))
    if (argv[0] !== 'tmux') return out('', 127)
    if (m.failTmux) return { deny: 'tmux is not allowed' }
    if (argv[1] === 'display-message') {
      const pid = panes[argv[4]!]
      return pid === undefined ? out('', 1) : out(`${pid}\n`)
    }
    if (argv[1] === 'list-clients') return out('100 /dev/pts/1 %8\n200 /dev/pts/2 %3\n')
    if (argv[1] === 'list-panes') return out([...tags].map(([pane, tag]) => `${pane} ${tag}`).join('\n'))
    if (argv[1] === 'new-window') return out(`%${40 + runs.filter(a => a[1] === 'new-window').length}\n`)
    if (argv[1] === 'set-option') tags.set(argv[4]!, argv[6]!)
    return out('')
  })
  const tmux = (verb: string) => runs.filter(argv => argv[0] === 'tmux' && argv[1] === verb)
  const claudeRuns = () => runs.filter(argv => argv[0] === 'claude').length
  /** Redraws asked for while the clock moves on by `ms`. */
  const redrawsOver = async (ms: number) => {
    const before = redraws
    await clock.advance(ms)
    return redraws - before
  }
  return { registry, jobs, reads, runs, tmux, claudeRuns, toasts, prompts, open, clock, redrawsOver }
}

const mountPane = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal', bodyColumns = 30) =>
  $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns }, surface })

/** A refresh runs every 2 seconds, and a session must be missed twice to count as ended. */
const ENDED_AFTER_MS = 4_000

const session = (text: string) => parseSession(text)!
const none = new Set<string>()

describe('model', () => {
  test('reads a terminal or background session record and ignores anything else', async () => {
    expect(parseSession(OTHER)).toMatchObject({ pid: 200, sessionId: OTHER_ID, name: 'app-tests', procStart: '2000' })
    expect(parseSession(record({ pid: 5, sessionId: id(9), name: undefined }))?.name).toBe('app')
    expect(parseSession(record({ pid: 5, sessionId: 'not-a-session-id!' }))).toBeNull()
    expect(parseSession(HEADLESS)).toBeNull()
    expect(parseSession('{"pid":1}')).toBeNull()
    expect(parseSession('not json')).toBeNull()
  })

  test('only conversations get tabs: not spare workers, not terminals showing a background session', async () => {
    expect(isConversation(session(OTHER))).toBe(true)
    expect(isConversation(session(SPARE))).toBe(false)
    expect(isConversation(session(PARKED))).toBe(false)
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

  test('reads the roster from claude agents --json --all, and distrusts an empty one', async () => {
    const roster = parseRoster(JSON.stringify([{ pid: 9, kind: 'interactive' }, JOB, { kind: 'background', id: '-x', sessionId: JOB_ID }]))
    expect(roster?.jobs.map(j => j.id)).toEqual(['b6e1f00d'])
    expect([...(roster?.livePids ?? [])]).toEqual([9])
    expect(parseRoster('[]')).toBeNull()
    expect(parseRoster('oops')).toBeNull()
  })

  test('keeps the newest record of a session and orders by start time', async () => {
    const older = session(record({ pid: 7, sessionId: id(20), name: 'old', startedAt: NOW - 5_000 }))
    const newer = session(record({ pid: 8, sessionId: id(20), name: 'new', startedAt: NOW - 1_000 }))
    const first = session(record({ pid: 9, sessionId: id(21), name: 'first', startedAt: NOW - 9_000 }))
    expect(orderSessions([newer, older, first]).map(s => s.name)).toEqual(['first', 'new'])
    expect(orderSessions([older, newer]).map(s => s.pid)).toEqual([8])
  })

  test('tabs: a new session opens one; gone and no longer present ends it; back again clears that', async () => {
    const other = session(OTHER)
    const { upserts: [opened] } = syncTabs([], none, [other], new Set([OTHER_ID]), [], NOW)
    expect(opened).toMatchObject({ sessionId: OTHER_ID, name: 'app-tests', kind: 'interactive', pid: 200, procStart: '2000' })
    expect(syncTabs([opened!], none, [other], new Set([OTHER_ID]), [], NOW + 1)).toEqual({ upserts: [], closes: [] })
    // Missed once, still present: nothing changes yet.
    expect(syncTabs([opened!], none, [], new Set([OTHER_ID]), [], NOW + 1).upserts).toEqual([])
    const { upserts: [ended] } = syncTabs([opened!], none, [], none, [], NOW + 2)
    expect(ended?.endedAt).toBe(NOW + 2)
    const { upserts: [resumed] } = syncTabs([ended!], none, [other], new Set([OTHER_ID]), [], NOW + 3)
    expect(resumed?.endedAt).toBeUndefined()
  })

  test('tabs: a closed tab is never written, whatever its session does', async () => {
    const other = session(OTHER)
    const { upserts: [opened] } = syncTabs([], none, [other], new Set([OTHER_ID]), [], NOW)
    const closed = new Set([OTHER_ID])
    expect(syncTabs([opened!], closed, [{ ...other, name: 'renamed' }], closed, [], NOW)).toEqual({ upserts: [], closes: [] })
    expect(syncTabs([opened!], closed, [], none, [], NOW)).toEqual({ upserts: [], closes: [] })
  })

  test('tabs: a terminal that starts a new conversation (/clear) keeps one tab, in the same place', async () => {
    const other = session(OTHER)
    const { upserts: [before] } = syncTabs([], none, [other], new Set([OTHER_ID]), [], NOW)
    const cleared = { ...other, sessionId: id(30), name: 'app-tests-2' }
    const { upserts, closes } = syncTabs([before!], none, [cleared], new Set([id(30)]), [], NOW + 1)
    expect(closes).toEqual([OTHER_ID])
    expect(upserts).toEqual([expect.objectContaining({ sessionId: id(30), name: 'app-tests-2', openedAt: before!.openedAt })])
  })

  test('tabs: a background session gets one; it closes only after a minute missing from a readable roster', async () => {
    const job = parseRoster(JSON.stringify([JOB]))!.jobs[0]!
    const { upserts: [opened] } = syncTabs([], none, [], none, [job], NOW)
    expect(opened).toMatchObject({ sessionId: JOB_ID, kind: 'background', jobId: 'b6e1f00d', name: 'nightly-refactor' })
    expect(syncTabs([opened!], none, [], none, null, NOW + 1)).toEqual({ upserts: [], closes: [] })
    const { upserts: [missing] } = syncTabs([opened!], none, [], none, [], NOW + 1)
    expect(missing?.missingSince).toBe(NOW + 1)
    expect(syncTabs([missing!], none, [], none, [], NOW + MISSING_GRACE_MS).closes).toEqual([])
    expect(syncTabs([missing!], none, [], none, [], NOW + 1 + MISSING_GRACE_MS).closes).toEqual([JOB_ID])
    const { upserts: [back] } = syncTabs([missing!], none, [], none, [job], NOW + 2)
    expect(back?.missingSince).toBeUndefined()
  })

  test('tabs: past the cap, the tabs whose sessions ended longest ago close', async () => {
    const ended: TabRecord[] = Array.from({ length: MAX_TABS + 3 }, (_, i) => ({
      sessionId: id(100 + i),
      name: `t${i}`,
      cwd: '/',
      kind: 'interactive',
      openedAt: i,
      endedAt: 1_000 + i,
    }))
    expect(syncTabs(ended, none, [], none, [], NOW).closes).toEqual([id(100), id(101), id(102)])
  })

  test('open tabs are the unclosed ones, oldest first', async () => {
    const a: TabRecord = { sessionId: id(1), name: 'a', cwd: '/', kind: 'interactive', openedAt: 2 }
    const b: TabRecord = { sessionId: id(2), name: 'b', cwd: '/', kind: 'interactive', openedAt: 1 }
    const c: TabRecord = { sessionId: id(3), name: 'c', cwd: '/', kind: 'interactive', openedAt: 0 }
    expect(openTabs([a, b, c], new Set([id(3)]), [], []).map(t => t.record.name)).toEqual(['b', 'a'])
  })

  test('badges for running, waiting, finished and exited tabs', async () => {
    const rec: TabRecord = { sessionId: JOB_ID, name: 'j', cwd: '/', kind: 'background', openedAt: 0 }
    const job = (state: string) => ({ id: 'j', sessionId: JOB_ID, name: 'j', cwd: '/', state, startedAt: 0 })
    expect(tabBadge({ record: rec, job: job('running') }).label).toBe('working')
    expect(tabBadge({ record: rec, job: job('blocked') }).tone).toBe('needs')
    expect(tabBadge({ record: rec, job: job('done') }).label).toBe('done')
    expect(tabBadge({ record: rec, job: job('failed') }).label).toBe('failed')
    expect(tabBadge({ record: rec, job: job('stopped') }).label).toBe('stopped')
    expect(tabBadge({ record: rec }).label).toBe('paused')
    // A finished job whose worker is still up, idle, reads as done, as agent view shows it.
    const idleWorker = { ...session(OTHER), kind: 'bg' as const, status: 'idle' }
    expect(tabBadge({ record: rec, job: job('done'), live: idleWorker }).label).toBe('done')
    expect(tabBadge({ record: rec, job: job('running'), live: { ...idleWorker, status: 'busy' } }).label).toBe('working')
    expect(tabBadge({ record: { ...rec, kind: 'interactive' } }).label).toBe('exited')
    expect(badge(session(OTHER)).tone).toBe('working')
    expect(badge(session(ASKING))).toMatchObject({ tone: 'needs', label: 'input needed' })
  })

  test("titles: a real name wins, then the session's own title, then the made-up name", async () => {
    const rec: TabRecord = { sessionId: id(1), name: 'app-3f', cwd: '/', kind: 'interactive', openedAt: 0 }
    expect(tabTitle(rec, 'Fix flaky tests')).toBe('Fix flaky tests')
    expect(tabTitle(rec, undefined)).toBe('app-3f')
    expect(tabTitle({ ...rec, name: 'auth refactor', isNamed: true }, 'Fix flaky tests')).toBe('auth refactor')
    expect(syncTabs([], none, [{ ...session(OTHER), nameSource: 'user' }], none, [], NOW).upserts[0]?.isNamed).toBe(true)
    expect(syncTabs([], none, [{ ...session(OTHER), nameSource: 'derived' }], none, [], NOW).upserts[0]?.isNamed).toBeUndefined()
  })

  test('titles from a first prompt: skip wrapped messages, tidy a model reply, cut a long line', async () => {
    const messages = [
      { role: 'user', text: '<command-name>/tabs</command-name>' },
      { role: 'user', text: '\n  why do the tests flake on CI?\nthey pass locally' },
    ]
    expect(firstPrompt(messages)).toBe('why do the tests flake on CI?\nthey pass locally')
    expect(firstPrompt([{ role: 'assistant', text: 'hi' }])).toBeUndefined()
    expect(titleFromPrompt('why do the tests flake on CI?\nthey pass locally')).toBe('why do the tests flake on CI?')
    expect(titleFromPrompt('x'.repeat(80))).toHaveLength(60)
    expect(cleanTitle('"Flaky CI tests."\n')).toBe('Flaky CI tests')
    expect(cleanTitle('Title: Debug flaky tests')).toBe('Debug flaky tests')
    expect(cleanTitle('  ')).toBeUndefined()
    // A pasted escape sequence never reaches the sidebar.
    expect(titleFromPrompt('\x1b[31mERROR\x1b[0m\tdisk full')).toBe('[31mERROR [0m disk full')
    expect(cleanTitle('Disk\u200b full\r')).toBe('Disk full')
    expect(tabTitle({ sessionId: id(1), name: 'x', cwd: '/', kind: 'interactive', openedAt: 0 }, '\x1b[2Jboom')).toBe('[2Jboom')
  })

  test('panes, clients, tmux text, ages and picking by number or name', async () => {
    expect(tmuxPane('0:@4.%7')).toBe('%7')
    expect(tmuxPane(undefined)).toBeNull()
    expect(tmuxPane('garbage')).toBeNull()
    expect(clientShowing('5 /dev/pts/1 %8\n9 /dev/pts/4 %8\n7 /dev/pts/2 %3', '%8')).toBe('/dev/pts/4')
    expect(clientShowing('5 /dev/pts/1 %8', '%9')).toBeUndefined()
    expect(windowName('fix #{pane_id} now')).toBe('fix {pane_id} now')
    expect(windowName('')).toBe('claude')
    expect(tmuxLiteral('/home/u/#tag')).toBe('/home/u/##tag')
    const names = ['app-main', 'app-tests', 'docs']
    expect(pick(names, '1', n => n)).toBe('app-main')
    expect(pick(names, 'app-t', n => n)).toBe('app-tests')
    expect(pick(names, 'DOCS', n => n)).toBe('docs')
    expect(pick(names, '9', n => n)).toBeUndefined()
  })
})

describe('sidebar', () => {
  test('a tab per running conversation; never a crashed one, a reused pid, a spare, a client or a script', async ($, on) => {
    const { reads } = machine(on, { links: ['900.json'] })
    await $.session.start(START)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await mountPane($, surface)
      expect((await ui.find({ type: 'Text', text: /3 sessions/ }))?.text).toContain('1 needs you')
      for (const hidden of ['ghost', 'recycled', 'spare', 'client', 'script']) expect(await ui.find({ text: hidden })).toBeUndefined()
      expect(await ui.find({ key: `go-${OTHER_ID}` })).toBeDefined()
      expect(await ui.find({ key: `go-${SELF_ID}` })).toBeUndefined()
      expect((await ui.find({ key: `glyph-${ASKING_ID}` }))?.text).toBe('●')
      expect((await ui.find({ key: `folder-${ASKING_ID}` }))?.text).toContain('app')
      await ui.unmount()
    }
    expect(reads.some(path => path.endsWith('.key'))).toBe(false)
    expect(reads.some(path => path.endsWith('900.json'))).toBe(false)
  })

  test('a tab stays after its session exits, and opening it resumes the session in a new tmux window', async ($, on) => {
    const { registry, tmux, clock } = machine(on)
    await $.session.start(START)
    await clock.settle() // the refresh after the sidebar opens
    delete registry['200.json']
    await clock.advance(2_000)
    const ui = await mountPane($)
    expect(SPINNER).toContain((await ui.find({ key: `glyph-${OTHER_ID}` }))?.text) // missed once: shown as last seen
    await clock.advance(2_000)
    expect((await ui.find({ key: `glyph-${OTHER_ID}` }))?.text).toBe('–')
    expect((await ui.find({ key: `folder-${OTHER_ID}` }))?.text).toContain('tests')
    await ui.press({ key: `go-${OTHER_ID}` })
    expect(tmux('new-window')).toEqual([
      [
        'tmux', 'new-window', '-d', '-P', '-F', '#{pane_id}', '-n', 'app-tests', '-c', '/home/u/dev/tests',
        '-e', 'PATH=/usr/bin', '--', 'claude', '--resume', OTHER_ID,
      ],
    ])
    expect(tmux('switch-client')).toEqual([['tmux', 'switch-client', '-c', '/dev/pts/1', '-t', '%41']])

    // Pressed again while it starts up, it goes to the same window rather than opening another.
    await ui.press({ key: `go-${OTHER_ID}` })
    expect(tmux('new-window').length).toBe(1)
    expect(tmux('switch-client').at(-1)).toEqual(['tmux', 'switch-client', '-c', '/dev/pts/1', '-t', '%41'])
    await ui.unmount()
  })

  test('/clear in a terminal keeps one tab in the same place, now on the new conversation', async ($, on) => {
    const { registry, clock } = machine(on)
    await $.session.start(START)
    registry['200.json'] = record({ pid: 200, procStart: '2000', sessionId: id(30), name: 'fresh-start', tmux: '0:@4.%7', cwd: '/home/u/dev/tests' })
    await clock.advance(ENDED_AFTER_MS)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /3 sessions/ })).toBeDefined()
    expect((await ui.find({ key: `go-${id(30)}` }))?.text).toContain('fresh-start')
    expect(await ui.find({ key: `go-${OTHER_ID}` })).toBeUndefined()
    await ui.unmount()
  })

  test('a session that ended before its first message leaves no tab behind', async ($, on) => {
    const { registry, clock } = machine(on, { transcripts: [SELF_ID, OTHER_ID] })
    await $.session.start(START)
    delete registry['300.json']
    await clock.advance(ENDED_AFTER_MS)
    const ui = await mountPane($)
    expect(await ui.find({ text: 'docs' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /2 sessions/ })).toBeDefined()
    await ui.unmount()
  })

  test('opening a tab with nothing saved says so and closes it, without opening a window', async ($, on) => {
    const ended = { sessionId: id(9), name: 'lost', cwd: '/home/u/dev/app', kind: 'interactive', openedAt: 1, endedAt: 2 }
    const { tmux, toasts } = machine(on, { stored: { [`tab:${id(9)}`]: ended } })
    await $.session.start(START)
    await $.command.run(tabs('lost'))
    expect(tmux('new-window')).toEqual([])
    expect(toasts.at(-1)).toContain('nothing to reopen')
    const ui = await mountPane($)
    expect(await ui.find({ text: 'lost' })).toBeUndefined()
    await ui.unmount()
  })

  test("a tab whose folder is gone isn't opened", async ($, on) => {
    const { registry, tmux, toasts, clock } = machine(on, { gone: ['/home/u/dev/tests'] })
    await $.session.start(START)
    delete registry['200.json']
    await clock.advance(ENDED_AFTER_MS)
    await $.command.run(tabs('app-tests'))
    expect(tmux('new-window')).toEqual([])
    expect(toasts.at(-1)).toContain('is gone')
  })

  test('a window that dies as it opens is reported', async ($, on) => {
    const { registry, toasts, clock } = machine(on)
    await $.session.start(START)
    delete registry['200.json']
    await clock.advance(ENDED_AFTER_MS)
    await $.command.run(tabs('app-tests'))
    expect(toasts.some(text => text.includes('closed as it opened'))).toBe(false)
    await clock.advance(2_000)
    expect(toasts.some(text => text.includes('closed as it opened'))).toBe(true)
  })

  test('a background session gets a tab; opening it attaches in a new tmux window', async ($, on) => {
    const { tmux } = machine(on, { jobs: [JOB] })
    await $.session.start(START)
    const ui = await mountPane($)
    expect(SPINNER).toContain((await ui.find({ key: `glyph-${JOB_ID}` }))?.text)
    expect((await ui.find({ key: `folder-${JOB_ID}` }))?.text).toContain('api')
    await ui.press({ key: `go-${JOB_ID}` })
    expect(tmux('new-window')[0]?.slice(-4)).toEqual(['--', 'claude', 'attach', 'b6e1f00d'])
    await ui.unmount()
  })

  test("a background session not yet in the roster isn't resumed in a second process", async ($, on) => {
    const registry = { ...files(), '950.json': record({ pid: 950, procStart: '950', sessionId: id(40), name: 'starting', kind: 'bg' }) }
    PROCS[950] = { ppid: 1, start: '950' }
    const { tmux, toasts } = machine(on, { files: registry })
    await $.session.start(START)
    await $.command.run(tabs('starting'))
    expect(tmux('new-window')).toEqual([])
    expect(toasts.at(-1)).toContain('still starting')
    delete PROCS[950]
  })

  test('a deleted background session closes its tab after a minute; a brief gap does not', async ($, on) => {
    const { jobs, clock } = machine(on, { jobs: [JOB] })
    await $.session.start(START)
    jobs.length = 0
    await clock.advance(30_000)
    const ui = await mountPane($)
    expect(await ui.find({ text: 'nightly-refactor' })).toBeDefined()
    await clock.advance(50_000)
    expect(await ui.find({ text: 'nightly-refactor' })).toBeUndefined()
    await ui.unmount()
  })

  test('closing a tab hides it for good, even while its session runs; /tabs reopen brings it back', async ($, on) => {
    const { clock } = machine(on)
    await $.session.start(START)
    const ui = await mountPane($)
    await ui.press({ key: `close-${OTHER_ID}` })
    await clock.advance(2_000)
    expect(await ui.find({ key: `go-${OTHER_ID}` })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /2 sessions/ })).toBeDefined()
    await $.command.run(tabs('reopen'))
    expect(await ui.find({ key: `go-${OTHER_ID}` })).toBeDefined()
    await $.command.run(tabs('close docs'))
    expect(await ui.find({ key: `go-${ASKING_ID}` })).toBeUndefined()
    await ui.unmount()
  })

  test('opening a running session switches the terminal showing this one to its pane', async ($, on) => {
    const { tmux } = machine(on)
    await $.session.start(START)
    await $.command.run(tabs('app-tests'))
    expect(tmux('switch-client')).toEqual([['tmux', 'switch-client', '-c', '/dev/pts/1', '-t', '%7']])
    expect(tmux('new-window')).toEqual([])
  })

  test('a pane with the same id but another program in it is not switched to', async ($, on) => {
    const { tmux, toasts } = machine(on, { panes: { '%7': 300, '%8': 10 } })
    await $.session.start(START)
    await $.command.run(tabs('app-tests'))
    expect(tmux('switch-client')).toEqual([])
    expect(toasts.at(-1)).toContain("isn't in a pane of this tmux server")
  })

  test('a running session missing from this tmux server is not switched to', async ($, on) => {
    const { tmux } = machine(on, { panes: { '%8': 10 } })
    await $.session.start(START)
    await $.command.run(tabs('app-tests'))
    expect(tmux('switch-client')).toEqual([])
    expect(tmux('new-window')).toEqual([])
  })

  test('nothing runs tmux from outside tmux, for a session outside tmux, or for this session', async ($, on) => {
    const outside = machine(on, { env: { HOME } })
    await $.session.start(START)
    for (const query of ['docs', 'app-tests', '1']) await $.command.run(tabs(query))
    expect(outside.runs.some(argv => argv[0] === 'tmux')).toBe(false)
    expect(outside.toasts.some(text => text.includes('claude --resume'))).toBe(true)
  })

  test('a tmux failure is reported, not thrown', async ($, on) => {
    const { tmux, toasts } = machine(on, { failTmux: true })
    await $.session.start(START)
    const ui = await mountPane($)
    await ui.press({ key: `go-${OTHER_ID}` })
    expect(tmux('switch-client')).toEqual([])
    expect(toasts.at(-1)).toContain("Couldn't open app-tests")
    await ui.unmount()
  })

  test('a failed claude agents run is shared too: no retry for 10 seconds', async ($, on) => {
    const { claudeRuns, clock } = machine(on, { failClaude: true })
    await $.session.start(START)
    await clock.advance(9_000)
    expect(claudeRuns()).toBe(1)
    await clock.advance(2_000)
    expect(claudeRuns()).toBe(2)
  })

  test('opens by itself in a new session', async ($, on) => {
    const { open, clock } = machine(on)
    await $.session.start(START)
    await clock.settle()
    expect([...open]).toEqual(['session-tabs'])
  })

  test('stays closed when the person closed it, and polls nothing while closed', async ($, on) => {
    const { open, reads, claudeRuns, clock } = machine(on, { stored: { autoOpen: false } })
    await $.session.start(START)
    await clock.settle()
    expect([...open]).toEqual([])
    const [readsBefore, runsBefore] = [reads.length, claudeRuns()]
    await clock.advance(30_000)
    expect([reads.length, claudeRuns()]).toEqual([readsBefore, runsBefore])

    await $.command.run(tabs(''))
    expect([...open]).toEqual(['session-tabs'])
    const opened = reads.length
    await clock.advance(2_000)
    expect(reads.length).toBeGreaterThan(opened)
  })

  test('a failing refresh does not stop the session from starting', async ($, on) => {
    const { open, clock } = machine(on, { failSessionId: true })
    await $.session.start(START)
    await clock.settle()
    await $.command.run(tabs(''))
    expect([...open]).toEqual([])
    await $.command.run(tabs(''))
    expect([...open]).toEqual(['session-tabs'])
  })

  test('a headless run does no work', async ($, on) => {
    const { runs, reads } = machine(on)
    await $.session.start({ cwd: '/home/u/dev/app', surface: null, isInteractive: false })
    expect(runs).toEqual([])
    expect(reads).toEqual([])
  })
})

describe('titles, new sessions and the spinner', () => {
  const turn = { answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' as const }

  test('a session titles itself after its first turn, with a small model', async ($, on) => {
    const { prompts, clock } = machine(on, { messages: [{ role: 'user', text: 'why do the tests flake on CI?' }], modelReply: '"Flaky CI tests"' })
    await $.session.start(START)
    await $.turn.complete(turn)
    await clock.settle()
    expect(prompts).toEqual(['why do the tests flake on CI?'])
    const ui = await mountPane($)
    expect(await ui.find({ text: 'Flaky CI tests' })).toBeDefined()
    // Once titled, later turns ask nothing more.
    await $.turn.complete({ ...turn, turnId: 't2' })
    await clock.settle()
    expect(prompts.length).toBe(1)
    await ui.unmount()
  })

  test('without a small model, the first line of the first prompt is the title', async ($, on) => {
    const { clock } = machine(on, { messages: [{ role: 'user', text: 'port the billing job to the new queue\nsee notes' }] })
    await $.session.start(START)
    await $.turn.complete(turn)
    await clock.settle()
    const ui = await mountPane($, 'terminal', 80)
    expect((await ui.find({ type: 'Text', text: /^port the billing job/ }))?.text).toBe('port the billing job to the new queue')
    await ui.unmount()
  })

  test('a session asks the model once, even when the call fails', async ($, on) => {
    const { prompts, clock } = machine(on, { messages: [{ role: 'user', text: 'hello' }] })
    await $.session.start(START)
    for (const turnId of ['t1', 't2', 't3']) {
      await $.turn.complete({ ...turn, turnId })
      await clock.settle()
    }
    expect(prompts).toEqual(['hello'])
  })

  test('other sessions show the titles they gave themselves; a /rename wins', async ($, on) => {
    const registry = { ...files(), '300.json': record({ pid: 300, procStart: '3000', sessionId: ASKING_ID, name: 'release notes', nameSource: 'user' }) }
    machine(on, { files: registry, stored: { [`title:${OTHER_ID}`]: 'Fix flaky tests', [`title:${ASKING_ID}`]: 'Docs pass' } })
    await $.session.start(START)
    const ui = await mountPane($)
    expect((await ui.find({ key: `go-${OTHER_ID}` }))?.text).toBe('Fix flaky tests')
    expect((await ui.find({ key: `go-${ASKING_ID}` }))?.text).toBe('release notes')
    await ui.unmount()
  })

  test('+ New session starts claude in a new tmux window in this folder and shows it', async ($, on) => {
    const { tmux } = machine(on)
    await $.session.start(START)
    const ui = await mountPane($)
    await ui.press({ key: 'new' })
    expect(tmux('new-window')).toEqual([
      ['tmux', 'new-window', '-d', '-P', '-F', '#{pane_id}', '-c', '/home/u/dev/app', '-e', 'PATH=/usr/bin', '--', 'claude'],
    ])
    expect(tmux('switch-client').at(-1)?.at(-1)).toBe('%41')
    await $.command.run(tabs('new'))
    expect(tmux('new-window').length).toBe(2)
    await ui.unmount()
  })

  test('a working tab spins while the sidebar is on screen', async ($, on) => {
    const { clock, redrawsOver } = machine(on)
    await $.session.start(START)
    await clock.settle()
    const ui = await mountPane($)
    const before = (await ui.find({ key: `glyph-${OTHER_ID}` }))?.text
    expect(await redrawsOver(11 * SPIN_MS)).toBeGreaterThanOrEqual(9) // 11 frames: not back to the same glyph
    expect(SPINNER).toContain(before)
    expect((await ui.find({ key: `glyph-${OTHER_ID}` }))?.text).not.toBe(before)
    expect((await ui.find({ key: `glyph-${SELF_ID}` }))?.text).toBe('○')
    await ui.unmount()
  })

  test('nothing redraws when no tab is working', async ($, on) => {
    const idle = { ...files(), '200.json': record({ pid: 200, procStart: '2000', sessionId: OTHER_ID, name: 'app-tests', tmux: '0:@4.%7' }) }
    const { clock, redrawsOver } = machine(on, { files: idle })
    await $.session.start(START)
    await clock.settle()
    expect(await redrawsOver(1_000)).toBe(0)
  })

  test('nothing spins while the sidebar is closed or off screen', async ($, on) => {
    const closed = machine(on, { stored: { autoOpen: false } })
    await $.session.start(START)
    await closed.clock.settle()
    expect(await closed.redrawsOver(1_000)).toBe(0)
  })

  test('nothing spins for a sidebar too narrow to be placed', async ($, on) => {
    const { clock, redrawsOver } = machine(on, { placed: false })
    await $.session.start(START)
    await clock.settle()
    expect(await redrawsOver(1_000)).toBe(0)
  })

  test('closing the sidebar stops the spinner', async ($, on) => {
    const { clock, redrawsOver } = machine(on)
    await $.session.start(START)
    await clock.settle()
    expect(await redrawsOver(1_000)).toBeGreaterThan(0)
    await $.command.run(tabs(''))
    expect(await redrawsOver(1_000)).toBe(0)
  })
})

describe('without /proc', () => {
  test('claude agents --json --all decides which sessions run; this one always shows', async ($, on) => {
    const { clock } = machine(on, { hasProc: false })
    await $.session.start(START)
    await clock.settle()
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /3 sessions/ })).toBeDefined()
    expect(await ui.find({ text: 'ghost' })).toBeUndefined()
    expect(await ui.find({ text: /app-main/ })).toBeDefined()
    await ui.unmount()
  })

  test('switching checks the pane with ps', async ($, on) => {
    const { tmux, runs } = machine(on, { hasProc: false })
    await $.session.start(START)
    await $.command.run(tabs('app-tests'))
    expect(runs).toContainEqual(['ps', '-A', '-o', 'pid=,ppid='])
    expect(tmux('switch-client')).toEqual([['tmux', 'switch-client', '-c', '/dev/pts/1', '-t', '%7']])
  })
})
