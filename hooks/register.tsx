import type { EngineInterface, Register } from 'claude-code'

import {
  basename,
  clientShowing,
  descendsFrom,
  formatAge,
  isConversation,
  isJobId,
  isRegistryFile,
  isSessionId,
  openTabs,
  orderSessions,
  parseProcessTable,
  parseRoster,
  parseSession,
  parseStat,
  pick,
  projectDirName,
  syncTabs,
  tabBadge,
  tmuxLiteral,
  tmuxPane,
  windowName,
  type Job,
  type Session,
  type Tab,
  type TabRecord,
} from './model'

const PANE = 'session-tabs'
const TITLE = 'Sessions'
const WIDTH = 30
const REFRESH_MS = 2_000
/** How old the shared `claude agents` answer, or a failed attempt, may be before a session asks again. */
const ROSTER_MAX_AGE_MS = 10_000
const CLOSED_KEEP_MS = 30 * 24 * 3_600_000
/** The tmux pane option that marks a window this mod opened for a session. */
const PANE_TAG = '@session-tabs'

/** The shared `claude agents --json --all` answer; no `jobs` when the last attempt failed. */
type Roster = { at: number; jobs?: Job[]; livePids?: number[] }

// Module state: rebuilt from disk and the store on every refresh, so losing it on reload is harmless.
let configDir = ''
let registryDir = ''
let home = ''
/** Linux: liveness and process ancestry come from /proc. Elsewhere: `claude agents --json` and `ps`. */
let hasProc = false
let selfId: string | undefined
let tabs: Tab[] = []
/** The sessions taken as running at the last refresh. One missed refresh isn't an exit: the session is carried over once. */
let carried = new Map<string, { session: Session; isMissed: boolean }>()
let drawnKey = ''
let refreshing: Promise<void> | null = null
let isStale = false
let rosterFetch: Promise<Roster> | null = null

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const tabKey = (sessionId: string) => `tab:${sessionId}`
/** Closing lives under a key of its own that a refresh never writes, so another session's refresh can't undo it. */
const closedKey = (sessionId: string) => `closed:${sessionId}`

const isPaneOpen = async ($: EngineInterface): Promise<boolean> =>
  (await $.ui.panes()).some(pane => pane.id === PANE)

/** Re-reads everything; never rejects. A call made while one runs makes that one go round again. */
function refresh($: EngineInterface): Promise<void> {
  if (registryDir === '') return Promise.resolve()
  if (refreshing !== null) {
    isStale = true
    return refreshing
  }
  refreshing = (async () => {
    do {
      isStale = false
      try {
        await load($)
      } catch (error) {
        $.ui.log(`session-tabs: refresh failed: ${errorText(error)}`, { to: 'debug' })
      }
    } while (isStale)
  })().finally(() => {
    refreshing = null
  })
  return refreshing
}

async function load($: EngineInterface): Promise<void> {
  selfId = await $.session.id()
  const now = await $.clock.now()
  const roster = await getRoster($, now)
  const jobs = roster.jobs ?? null
  const found = await liveSessions($, roster)
  const live = found === null ? null : carryOver(found)

  // The tabs are kept in the store, one key each, shared by every session running the mod.
  const keys = await $.store.keys()
  const records = new Map<string, TabRecord>()
  const closed = new Map<string, number>()
  for (const key of keys) {
    const value = await $.store.get(key)
    if (key.startsWith('tab:') && isTabRecord(value)) records.set(value.sessionId, value)
    if (key.startsWith('closed:') && typeof value === 'number') closed.set(key.slice('closed:'.length), value)
  }

  // Without a registry listing, nothing can be told about what ended, so the tabs are left as they are.
  if (live !== null) {
    const liveIds = new Set(live.map(s => s.sessionId))
    const { upserts, closes } = syncTabs([...records.values()], new Set(closed.keys()), live, liveIds, jobs, now)
    for (const id of closes) {
      await $.store.set(closedKey(id), now)
      closed.set(id, now)
    }
    for (const next of upserts) {
      // An interactive session that ended before its first message left nothing to reopen: its tab goes.
      if (next.kind === 'interactive' && next.endedAt === now && (await hasTranscript($, next)) === false) {
        await $.store.set(closedKey(next.sessionId), now)
        closed.set(next.sessionId, now)
      }
      await $.store.set(tabKey(next.sessionId), next)
      records.set(next.sessionId, next)
    }

    // A month after closing, a tab is forgotten, unless its session is around and would only come back.
    const around = new Set([...liveIds, ...(jobs ?? []).map(j => j.sessionId)])
    for (const [id, closedAt] of closed) {
      if (now - closedAt <= CLOSED_KEEP_MS || around.has(id)) continue
      await $.store.delete(tabKey(id))
      await $.store.delete(closedKey(id))
      records.delete(id)
      closed.delete(id)
    }
  }
  tabs = openTabs([...records.values()], new Set(closed.keys()), live ?? [], jobs ?? [])

  // Redraw when something visible or something a press acts on changed (ages are shown in minutes).
  const key = JSON.stringify([
    selfId,
    tabs.map(t => [
      t.record.sessionId,
      t.record.name,
      t.record.cwd,
      t.record.kind,
      t.record.jobId,
      t.live?.pid,
      t.live?.tmux,
      tabBadge(t).label,
      formatAge(now - sinceOf(t)),
    ]),
  ])
  if (key !== drawnKey) {
    drawnKey = key
    $.ui.invalidate('ui.render')
  }
}

/** The running sessions, plus any missed for the first time (a registry file caught mid-write), as last seen. */
function carryOver(found: Session[]): Session[] {
  const next = new Map(found.map(session => [session.sessionId, { session, isMissed: false }]))
  // A process now running another conversation (`/clear`) moved on; that isn't a missed read.
  const processes = new Set(found.map(s => `${s.pid}:${s.procStart}`))
  for (const [id, held] of carried) {
    if (next.has(id) || held.isMissed || processes.has(`${held.session.pid}:${held.session.procStart}`)) continue
    next.set(id, { session: held.session, isMissed: true })
  }
  carried = next
  return [...next.values()].map(held => held.session)
}

function isTabRecord(v: unknown): v is TabRecord {
  if (v === null || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (
    isSessionId(r.sessionId) &&
    typeof r.name === 'string' &&
    typeof r.cwd === 'string' &&
    (r.kind === 'interactive' || r.kind === 'background') &&
    typeof r.openedAt === 'number'
  )
}

/** Whether Claude Code saved the session's conversation; undefined when its project folder isn't where expected. */
async function hasTranscript($: EngineInterface, r: TabRecord): Promise<boolean | undefined> {
  const dir = `${configDir}/projects/${projectDirName(r.cwd)}`
  if (!(await $.fs.exists(dir).catch(() => false))) return undefined
  return $.fs.exists(`${dir}/${r.sessionId}.jsonl`).catch(() => undefined)
}

const sinceOf = (t: Tab): number =>
  t.live?.statusUpdatedAt ?? t.live?.startedAt ?? t.record.endedAt ?? t.job?.startedAt ?? t.record.openedAt

/** The running sessions from Claude Code's registry: one record each, conversations only, processes alive. Null when the registry can't be listed. */
async function liveSessions($: EngineInterface, roster: Roster): Promise<Session[] | null> {
  const entries = await $.fs.list(registryDir).catch(() => null)
  if (entries === null) return null
  const found = await Promise.all(
    entries
      .filter(entry => entry.kind === 'file' && !entry.isLink && isRegistryFile(entry.name))
      .map(entry =>
        $.fs
          .read(`${registryDir}/${entry.name}`)
          .then(text => (typeof text === 'string' ? parseSession(text) : null))
          .catch(() => null),
      ),
  )
  const records = orderSessions(found.filter((s): s is Session => s !== null && isConversation(s)))
  const alive = await Promise.all(records.map(s => isAlive($, s, roster)))
  return records.filter((_, i) => alive[i])
}

/** A registry file can outlive a crashed session, and its pid can be reused: check the process is that session. */
async function isAlive($: EngineInterface, s: Session, roster: Roster): Promise<boolean> {
  if (s.sessionId === selfId) return true
  if (hasProc) {
    const stat = await $.fs.read(`/proc/${s.pid}/stat`).catch(() => null)
    if (typeof stat !== 'string') return false
    return s.procStart === undefined || parseStat(stat)?.startTime === s.procStart
  }
  if (roster.jobs === undefined || roster.livePids === undefined) return true
  return s.kind === 'bg' ? roster.jobs.some(j => j.sessionId === s.sessionId) : roster.livePids.includes(s.pid)
}

/**
 * The background sessions, from `claude agents --json --all`. Every session running the mod shares
 * one answer through the store, a failed attempt included, so the machine runs the command at most
 * about once per 10 seconds.
 */
async function getRoster($: EngineInterface, now: number): Promise<Roster> {
  const cached = (await $.store.get('roster')) as Roster | undefined
  if (cached !== undefined && typeof cached.at === 'number' && now - cached.at < ROSTER_MAX_AGE_MS) return cached
  rosterFetch ??= (async () => {
    let roster: Roster = { at: now }
    try {
      const run = await $.process.run(['claude', 'agents', '--json', '--all'], { timeoutMs: 10_000 })
      const parsed = run.exitCode === 0 ? parseRoster(run.stdout) : null
      if (parsed !== null) roster = { at: now, jobs: parsed.jobs, livePids: [...parsed.livePids] }
    } catch {
      // `claude` not on PATH or too slow: recorded as a failure, tried again in 10 seconds.
    }
    await $.store.set('roster', roster).catch(() => {})
    return roster
  })().finally(() => {
    rosterFetch = null
  })
  return rosterFetch
}

async function parentOf($: EngineInterface): Promise<(pid: number) => Promise<number | undefined>> {
  if (hasProc) {
    return async pid => {
      const stat = await $.fs.read(`/proc/${pid}/stat`).catch(() => null)
      return typeof stat === 'string' ? parseStat(stat)?.ppid : undefined
    }
  }
  const run = await $.process.run(['ps', '-A', '-o', 'pid=,ppid='])
  const table = parseProcessTable(run.stdout)
  return async pid => table.get(pid)
}

/** Shows `pane` in the terminal that shows this session, not whichever one tmux would guess. */
async function switchToPane($: EngineInterface, pane: string): Promise<void> {
  const ownPane = await $.env.get('TMUX_PANE')
  const clients =
    ownPane === undefined
      ? undefined
      : await $.process.run(['tmux', 'list-clients', '-F', '#{client_activity} #{client_name} #{pane_id}'])
  const client = clients?.exitCode === 0 && ownPane !== undefined ? clientShowing(clients.stdout, ownPane) : undefined
  const sw = await $.process.run(['tmux', 'switch-client', ...(client === undefined ? [] : ['-c', client]), '-t', pane])
  if (sw.exitCode !== 0) $.ui.toast(`tmux: ${sw.stderr.trim() || 'switch failed'}`)
}

/** A pane this mod opened for the session earlier and that is still there. */
async function taggedPane($: EngineInterface, sessionId: string): Promise<string | undefined> {
  const run = await $.process.run(['tmux', 'list-panes', '-a', '-F', `#{pane_id} #{${PANE_TAG}}`])
  if (run.exitCode !== 0) return undefined
  for (const line of run.stdout.split('\n')) {
    const [pane, tag] = line.trim().split(' ')
    if (tag === sessionId && pane !== undefined && /^%\d+$/.test(pane)) return pane
  }
  return undefined
}

/** How to open a tab's session: attach to a background one, resume an interactive one. */
function openCommand(r: TabRecord): string[] {
  return r.kind === 'background' && isJobId(r.jobId) ? ['claude', 'attach', r.jobId] : ['claude', '--resume', r.sessionId]
}

/**
 * Brings a tab's session up in this terminal: jumps to the tmux pane it runs or shows in, or opens
 * it in a new tmux window (attaching to a background session, resuming one that exited).
 */
async function openTab($: EngineInterface, tab: Tab): Promise<void> {
  const r = tab.record
  try {
    if (r.sessionId === selfId) {
      $.ui.toast("You're already in this session.")
      return
    }
    if (!isSessionId(r.sessionId)) return
    if (r.kind === 'background' && !isJobId(r.jobId)) {
      $.ui.toast(`${r.name} is still starting in the background. Try again in a moment.`)
      return
    }
    if ((await $.env.get('TMUX')) === undefined) {
      $.ui.toast(`Not inside tmux. To open ${r.name}, run: ${openCommand(r).join(' ')}`)
      return
    }

    // An interactive session running right now: its own pane, if that pane is on this tmux server.
    if (tab.live !== undefined && tab.live.kind !== 'bg') {
      const pane = tmuxPane(tab.live.tmux)
      if (pane === null) {
        $.ui.toast(`${r.name} is running in a terminal outside tmux.`)
        return
      }
      const where = await $.process.run(['tmux', 'display-message', '-p', '-t', pane, '#{pane_pid}'])
      const panePid = Number(where.stdout.trim())
      const isThere =
        where.exitCode === 0 && Number.isInteger(panePid) && (await descendsFrom(tab.live.pid, panePid, await parentOf($)))
      if (!isThere) {
        $.ui.toast(`${r.name} isn't in a pane of this tmux server.`)
        return
      }
      await switchToPane($, pane)
      return
    }

    // A window opened for it before, then a new one.
    const opened = await taggedPane($, r.sessionId)
    if (opened !== undefined) {
      await switchToPane($, opened)
      return
    }
    if (r.kind === 'interactive' && (await hasTranscript($, r)) === false) {
      $.ui.toast(`${r.name} ended before its first message, so there is nothing to reopen.`)
      await closeTab($, r.sessionId)
      return
    }
    // `--resume` finds a conversation by the folder it ran in.
    if (r.cwd === '' || !(await $.fs.exists(r.cwd).catch(() => false))) {
      $.ui.toast(`${r.name}'s folder ${r.cwd || '(unknown)'} is gone, so it can't be reopened from here.`)
      return
    }
    // The new window runs with tmux's environment: hand it this session's PATH, config folder and renderer.
    const path = await $.env.get('PATH')
    const fullscreen = await $.env.get('CLAUDE_CODE_NO_FLICKER')
    const forwarded = [
      ...(path === undefined ? [] : ['-e', `PATH=${path}`]),
      ...(configDir === `${home}/.claude` ? [] : ['-e', `CLAUDE_CONFIG_DIR=${configDir}`]),
      ...(fullscreen === undefined ? [] : ['-e', `CLAUDE_CODE_NO_FLICKER=${fullscreen}`]),
    ]
    const win = await $.process.run([
      'tmux',
      'new-window',
      '-d',
      '-P',
      '-F',
      '#{pane_id}',
      '-n',
      windowName(r.name),
      '-c',
      tmuxLiteral(r.cwd),
      ...forwarded,
      '--',
      ...openCommand(r),
    ])
    const pane = win.stdout.trim()
    if (win.exitCode !== 0 || !/^%\d+$/.test(pane)) {
      $.ui.toast(`tmux: ${win.stderr.trim() || `couldn't open ${r.name}`}`)
      return
    }
    const tagged = await $.process.run(['tmux', 'set-option', '-p', '-t', pane, PANE_TAG, r.sessionId])
    if (tagged.exitCode !== 0) {
      $.ui.toast(`${r.name} closed as it opened. Try in a shell: ${openCommand(r).join(' ')}`)
      return
    }
    await switchToPane($, pane)
    // A command that fails a moment later takes its window with it: say so rather than leave a flash.
    $.clock.after(2_000, () => {
      void $.process
        .run(['tmux', 'display-message', '-p', '-t', pane, '#{pane_id}'])
        .then(check => {
          if (check.exitCode !== 0) $.ui.toast(`${r.name} closed as it opened. Try in a shell: ${openCommand(r).join(' ')}`)
        })
        .catch(() => {})
    })
  } catch (error) {
    $.ui.toast(`Couldn't open ${r.name}: ${errorText(error)}`)
  }
}

/** Hides a tab. The session itself is left alone: a background one keeps running, and any can be resumed. */
async function closeTab($: EngineInterface, sessionId: string): Promise<void> {
  try {
    await $.store.set(closedKey(sessionId), await $.clock.now())
    const stack = await $.store.get('reopen')
    const ids = Array.isArray(stack) ? stack.filter(isSessionId).filter(id => id !== sessionId) : []
    await $.store.set('reopen', [...ids, sessionId].slice(-25))
    await refresh($)
  } catch (error) {
    $.ui.toast(`Couldn't close the tab: ${errorText(error)}`)
  }
}

/** Opens the most recently closed tab again. */
async function reopenTab($: EngineInterface): Promise<void> {
  try {
    const stack = await $.store.get('reopen')
    const ids = Array.isArray(stack) ? stack.filter(isSessionId) : []
    while (ids.length > 0) {
      const id = ids.pop()!
      if ((await $.store.get(closedKey(id))) === undefined || !isTabRecord(await $.store.get(tabKey(id)))) continue
      await $.store.delete(closedKey(id))
      await $.store.set('reopen', ids)
      await refresh($)
      return
    }
    await $.store.set('reopen', [])
    $.ui.toast('No closed tabs to reopen.')
  } catch (error) {
    $.ui.toast(`Couldn't reopen the tab: ${errorText(error)}`)
  }
}

const clip = (text: string, room: number): string =>
  text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1))}…`

const findTab = (query: string) => pick(tabs, query, t => t.record.name)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Headless runs (`claude -p`, the SDK) draw nothing, so there is nothing to keep fresh.
    if (!e.isInteractive) return next(e)

    try {
      home = (await $.env.get('HOME')) ?? ''
      configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
      registryDir = `${configDir}/sessions`
      hasProc = await $.fs.exists('/proc/self/stat').catch(() => false)

      // Poll only while the sidebar is open; `/tabs` refreshes on demand.
      $.clock.every(REFRESH_MS, () => {
        void isPaneOpen($)
          .then(isOpen => (isOpen ? refresh($) : undefined))
          .catch(() => {})
      })
      await refresh($)

      if ((await $.store.get('autoOpen')) !== false) {
        void $.ui.open({ id: PANE, title: TITLE, columns: WIDTH }).catch(() => {})
      }
    } catch (error) {
      $.ui.log(`session-tabs: start failed: ${errorText(error)}`, { to: 'debug' })
    }

    try {
      await $.command.register({
        name: 'tabs',
        description: 'Session tabs: toggle the sidebar, open a tab by number or name, close or reopen a tab',
        argumentHint: '[N | name | close N | reopen]',
        immediate: true,
      })
    } catch (error) {
      $.ui.log(`session-tabs: /tabs not registered: ${errorText(error)}`)
    }
    return next(e)
  })

  on('command.run', { command: 'tabs' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const query = rest.join(' ')
    if (verb === '') {
      if (await isPaneOpen($)) {
        await $.ui.close({ id: PANE })
      } else {
        await $.store.set('autoOpen', true)
        await refresh($)
        await $.ui.open({ id: PANE, title: TITLE, columns: WIDTH, focus: true })
      }
      return {}
    }
    await refresh($)
    if (verb === 'reopen') {
      await reopenTab($)
      return {}
    }
    if (verb === 'close') {
      const found = query === '' ? undefined : findTab(query)
      if (found === undefined) $.ui.toast(query === '' ? 'Usage: /tabs close N' : `No tab matches "${query}".`)
      else await closeTab($, found.record.sessionId)
      return {}
    }
    const found = findTab(e.args)
    if (found === undefined) $.ui.toast(`No tab matches "${e.args.trim()}".`)
    else await openTab($, found)
    return {}
  })

  // Closing the sidebar yourself keeps it closed in new sessions until `/tabs` opens it again.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind !== 'unload') void $.store.set('autoOpen', false).catch(() => {})
    return next(e)
  }).catch(() => undefined) // a failing hook must never keep the pane from closing

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const isDocked = e.props.placement === 'dock'
    const room = Math.max(8, e.props.bodyColumns - 8)
    const waiting = tabs.filter(t => t.record.sessionId !== selfId && tabBadge(t).tone === 'needs').length

    const rows = tabs.map((t, i) => {
      const b = tabBadge(t)
      const id = t.record.sessionId
      const isSelf = id === selfId
      const label = clip(t.record.name, isSelf ? room - 2 : room)
      const name = isSelf ? (
        <Text bold color="claude">
          {`${i < 9 ? `${i + 1}: ` : ''}${label} ◂`}
        </Text>
      ) : (
        <Button
          key={`go-${id}`}
          label={label}
          plain
          {...(i < 9 ? { hotkey: String(i + 1) } : {})}
          onPress={() => openTab($, t)}
        />
      )
      const status = `${b.label} ${formatAge(now - sinceOf(t))}`
      return (
        <Box key={`row-${id}`} flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Text color={b.color}>{b.glyph}</Text>
            <Box flexGrow={1}>{name}</Box>
            {!isDocked && (
              <Text dimColor wrap="truncate-end">
                {status}
              </Text>
            )}
            <Button key={`close-${id}`} label="✕" plain dimColor onPress={() => closeTab($, id)} />
          </Box>
          {isDocked && (
            <Text dimColor wrap="truncate-end">
              {`  ${status} · ${basename(t.record.cwd)}`}
            </Text>
          )}
        </Box>
      )
    })

    return (
      <Box flexDirection="column" rowGap={isDocked ? 1 : 0}>
        <Text dimColor>
          {`${tabs.length} tab${tabs.length === 1 ? '' : 's'}`}
          {waiting > 0 ? ` · ${waiting} need${waiting === 1 ? 's' : ''} you` : ''}
        </Text>
        {tabs.length === 0 ? <Text dimColor>No sessions yet.</Text> : rows}
        {isDocked && <Text dimColor>/tabs N · close N · reopen</Text>}
      </Box>
    )
  })
}
