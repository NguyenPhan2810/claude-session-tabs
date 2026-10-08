import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  basename,
  cleanTitle,
  clientShowing,
  descendsFrom,
  firstPrompt,
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
  SPIN_MS,
  spinnerFrame,
  syncTabs,
  tabBadge,
  tabTitle,
  titleFromPrompt,
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
const WIDTH = 40
const REFRESH_MS = 2_000
/** How old the shared `claude agents` answer, or a failed attempt, may be before a session asks again. */
const ROSTER_MAX_AGE_MS = 10_000
const CLOSED_KEEP_MS = 30 * 24 * 3_600_000
/** How a session asks a small model for its title, once, after its first turn. */
const TITLE_SYSTEM =
  "You name coding-assistant chat sessions. Reply with only a title of 3 to 5 words, at most 40 characters, for the conversation that starts with the user's message below: sentence case, no quotes, no trailing punctuation."
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
/** The titles sessions gave themselves, by session id. */
let titles = new Map<string, string>()
let spinner: Timer | null = null
let isTitling = false
/** Sessions this module already asked the model about: one call each, even if saving the title failed. */
const asked = new Set<string>()
/** The sessions taken as running. One missing for less than MISS_GRACE_MS (a registry file caught mid-write) is carried over. */
let carried = new Map<string, { session: Session; missingSince?: number }>()
const MISS_GRACE_MS = 1_500
let drawnKey = ''
let refreshing: Promise<void> | null = null
let isStale = false
let rosterFetch: Promise<Roster> | null = null

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const tabKey = (sessionId: string) => `tab:${sessionId}`
/** Closing lives under a key of its own that a refresh never writes, so another session's refresh can't undo it. */
const closedKey = (sessionId: string) => `closed:${sessionId}`
/** A session's title, written only by that session, so it never races another's write. */
const titleKey = (sessionId: string) => `title:${sessionId}`

/** Whether the sidebar is open, and whether it is actually on screen (placed, and the pane in front). */
async function paneState($: EngineInterface): Promise<{ isOpen: boolean; isVisible: boolean }> {
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  return { isOpen: pane !== undefined, isVisible: pane !== undefined && pane.isPlaced && pane.isShown }
}

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
  const live = found === null ? null : carryOver(found, now)

  // The tabs are kept in the store, one key each, shared by every session running the mod.
  const keys = await $.store.keys()
  const records = new Map<string, TabRecord>()
  const closed = new Map<string, number>()
  const named = new Map<string, string>()
  for (const key of keys) {
    const value = await $.store.get(key)
    if (key.startsWith('tab:') && isTabRecord(value)) records.set(value.sessionId, value)
    if (key.startsWith('closed:') && typeof value === 'number') closed.set(key.slice('closed:'.length), value)
    if (key.startsWith('title:') && typeof value === 'string') named.set(key.slice('title:'.length), value)
  }
  titles = named

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
      await $.store.delete(titleKey(id))
      records.delete(id)
      closed.delete(id)
    }
  }
  tabs = openTabs([...records.values()], new Set(closed.keys()), live ?? [], jobs ?? [])
  const isWorking = tabs.some(t => tabBadge(t).tone === 'working')
  animate($, isWorking && (await paneState($)).isVisible)

  // Redraw when something visible or something a press acts on changed.
  const key = JSON.stringify([
    selfId,
    tabs.map(t => [
      t.record.sessionId,
      tabTitle(t.record, titles.get(t.record.sessionId)),
      t.record.cwd,
      t.record.kind,
      t.record.jobId,
      t.live?.pid,
      t.live?.tmux,
      tabBadge(t).label,
    ]),
  ])
  if (key !== drawnKey) {
    drawnKey = key
    $.ui.invalidate('ui.render')
  }
}

/** Runs the spinner only while a tab is working and the sidebar is on screen: a redraw per frame, nothing otherwise. */
function animate($: EngineInterface, isOn: boolean): void {
  if (isOn && spinner === null) spinner = $.clock.every(SPIN_MS, () => $.ui.invalidate('ui.render'))
  if (!isOn && spinner !== null) {
    spinner.cancel()
    spinner = null
  }
}

/**
 * Gives this session a title once it has a first prompt, as OpenCode titles its sessions: a few
 * words from a small model, or the prompt's first line when that isn't available.
 */
async function ensureTitle($: EngineInterface): Promise<void> {
  if (isTitling) return
  isTitling = true
  try {
    const id = await $.session.id()
    if ((await $.store.get(titleKey(id))) !== undefined) return
    const prompt = firstPrompt(await $.session.messages())
    if (prompt === undefined || asked.has(id)) return
    asked.add(id)
    let title = titleFromPrompt(prompt)
    try {
      const reply = await $.model.complete({ model: 'haiku', system: TITLE_SYSTEM, prompt: prompt.slice(0, 2_000), maxTokens: 24, timeoutMs: 15_000 })
      if (reply.isAnswered) title = cleanTitle(reply.text) ?? title
    } catch {
      // No small model here (another provider, or blocked): the prompt's first line will do.
    }
    await $.store.set(titleKey(id), title)
    void refresh($)
  } finally {
    isTitling = false
  }
}

/** What a window the mod opens needs from this session's environment: PATH, config folder and renderer. */
async function forwardedEnv($: EngineInterface): Promise<string[]> {
  const path = await $.env.get('PATH')
  const fullscreen = await $.env.get('CLAUDE_CODE_NO_FLICKER')
  return [
    ...(path === undefined ? [] : ['-e', `PATH=${path}`]),
    ...(configDir === `${home}/.claude` ? [] : ['-e', `CLAUDE_CONFIG_DIR=${configDir}`]),
    ...(fullscreen === undefined ? [] : ['-e', `CLAUDE_CODE_NO_FLICKER=${fullscreen}`]),
  ]
}

/** Starts a new Claude Code session in a new tmux window, in this session's folder, and shows it. */
async function newSession($: EngineInterface): Promise<void> {
  try {
    if ((await $.env.get('TMUX')) === undefined) {
      $.ui.toast('Not inside tmux: run claude in a new terminal.')
      return
    }
    const cwd = await $.session.cwd()
    const win = await $.process.run([
      'tmux', 'new-window', '-d', '-P', '-F', '#{pane_id}', '-c', tmuxLiteral(cwd),
      ...(await forwardedEnv($)),
      '--', 'claude',
    ])
    const pane = win.stdout.trim()
    if (win.exitCode !== 0 || !/^%\d+$/.test(pane)) {
      $.ui.toast(`tmux: ${win.stderr.trim() || "couldn't open a new window"}`)
      return
    }
    await switchToPane($, pane)
  } catch (error) {
    $.ui.toast(`Couldn't start a session: ${errorText(error)}`)
  }
}

/** The running sessions, plus any missed for the first time (a registry file caught mid-write), as last seen. */
function carryOver(found: Session[], now: number): Session[] {
  const next = new Map<string, { session: Session; missingSince?: number }>(found.map(session => [session.sessionId, { session }]))
  // A process now running another conversation (`/clear`) moved on; that isn't a missed read.
  const processes = new Set(found.map(s => `${s.pid}:${s.procStart}`))
  for (const [id, held] of carried) {
    if (next.has(id) || processes.has(`${held.session.pid}:${held.session.procStart}`)) continue
    const missingSince = held.missingSince ?? now
    if (now - missingSince < MISS_GRACE_MS) next.set(id, { session: held.session, missingSince })
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
    // The new window runs with tmux's environment: hand it this session's.
    const forwarded = await forwardedEnv($)
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
        void paneState($)
          .then(pane => {
            if (pane.isVisible) return refresh($)
            animate($, false)
          })
          .catch(() => {})
      })
      await refresh($)

      if ((await $.store.get('autoOpen')) !== false) {
        void $.ui
          .open({ id: PANE, title: TITLE, columns: WIDTH })
          .then(() => refresh($))
          .catch(() => {})
      }
    } catch (error) {
      $.ui.log(`session-tabs: start failed: ${errorText(error)}`, { to: 'debug' })
    }

    try {
      await $.command.register({
        name: 'tabs',
        description: 'Session tabs: toggle the sidebar, open a tab by number or name, start, close or reopen one',
        argumentHint: '[N | name | new | close N | reopen]',
        immediate: true,
      })
    } catch (error) {
      $.ui.log(`session-tabs: /tabs not registered: ${errorText(error)}`)
    }
    return next(e)
  })

  // After a turn of this session's own conversation, give it a title if it has none yet.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && registryDir !== '') void ensureTitle($).catch(() => {})
    return result
  }).catch(() => undefined)

  on('command.run', { command: 'tabs' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const query = rest.join(' ')
    if (verb === '') {
      // On screen: close it. Open but behind another pane, or closed: bring it up.
      if ((await paneState($)).isVisible) {
        await $.ui.close({ id: PANE })
      } else {
        await $.store.set('autoOpen', true)
        await refresh($)
        await $.ui.open({ id: PANE, title: TITLE, columns: WIDTH, focus: true })
        void refresh($)
      }
      return {}
    }
    if (verb === 'new') {
      await newSession($)
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
    if (e.id === PANE) animate($, false)
    if (e.id === PANE && e.origin.kind !== 'unload') void $.store.set('autoOpen', false).catch(() => {})
    return next(e)
  }).catch(() => undefined) // a failing hook must never keep the pane from closing

  // OpenCode's sidebar: one card per tab, a spinner or dot and the title, the folder under it.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const isDocked = e.props.placement === 'dock'
    const width = Math.max(12, e.props.bodyColumns)
    // Room for the title: the width less the glyph, the close mark and the gaps between them.
    const room = Math.max(8, width - 6)
    const spin = spinnerFrame(now)
    const waiting = tabs.filter(t => t.record.sessionId !== selfId && tabBadge(t).tone === 'needs').length
    const rule = (key: string) => (
      <Box key={key}>
        <Text color="subtle">{'─'.repeat(width)}</Text>
      </Box>
    )

    const cards = tabs.map((t, i) => {
      const b = tabBadge(t)
      const id = t.record.sessionId
      const title = clip(tabTitle(t.record, titles.get(id)), room)
      const folder = basename(t.record.cwd)
      const name =
        id === selfId ? (
          <Text bold wrap="truncate-end">
            {title}
          </Text>
        ) : (
          <Button key={`go-${id}`} label={title} plain dimColor onPress={() => openTab($, t)} />
        )
      const head = (
        <Box flexDirection="row" columnGap={1}>
          <Box key={`glyph-${id}`}>
            <Text color={b.color}>{b.tone === 'working' ? spin : b.glyph}</Text>
          </Box>
          <Box flexGrow={1}>{name}</Box>
          {!isDocked && (
            <Text dimColor wrap="truncate-end">
              {folder}
            </Text>
          )}
          <Button key={`close-${id}`} label="✕" plain dimColor onPress={() => closeTab($, id)} />
        </Box>
      )
      if (!isDocked) return <Box key={`row-${id}`}>{head}</Box>
      return (
        <Box key={`row-${id}`} flexDirection="column">
          {i > 0 && rule(`rule-${id}`)}
          {head}
          <Box key={`folder-${id}`}>
            <Text color="inactive" wrap="truncate-end">
              {`  ${folder}`}
            </Text>
          </Box>
        </Box>
      )
    })

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {`${tabs.length} session${tabs.length === 1 ? '' : 's'}`}
          {waiting > 0 ? ` · ${waiting} need${waiting === 1 ? 's' : ''} you` : ''}
        </Text>
        {isDocked && rule('rule-top')}
        {tabs.length === 0 ? <Text dimColor>No sessions yet.</Text> : cards}
        {isDocked && rule('rule-bottom')}
        <Button key="new" label="+ New session" plain dimColor onPress={() => newSession($)} />
      </Box>
    )
  })
}
