import type { EngineInterface, Register } from 'claude-code'

import {
  badge,
  basename,
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
  type Session,
} from './model'

const PANE = 'session-tabs'
const TITLE = 'Sessions'
const WIDTH = 30
const REFRESH_MS = 2_000
const LIVE_CHECK_MS = 15_000

// Module state: rebuilt from disk on every refresh, so losing it on reload is harmless.
let registryDir = ''
/** Linux: liveness and process ancestry come from /proc. Elsewhere: `claude agents --json` and `ps`. */
let hasProc = false
let selfId: string | undefined
let sessions: Session[] = []
let livePids: Set<number> | null = null
let liveCheckedAt = 0
let drawnKey = ''
let refreshing: Promise<void> | null = null
let isStale = false

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const since = (s: Session): number => s.statusUpdatedAt ?? s.startedAt

const isPaneOpen = async ($: EngineInterface): Promise<boolean> =>
  (await $.ui.panes()).some(pane => pane.id === PANE)

/** Re-reads the registry; never rejects. A call made while one runs makes that one go round again. */
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
  const entries = await $.fs.list(registryDir).catch(() => [])
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
  selfId = await $.session.id()
  const records = orderSessions(found.filter((s): s is Session => s !== null))
  const alive = await Promise.all(records.map(s => isAlive($, s)))
  sessions = records.filter((_, i) => alive[i])

  // Redraw only when something visible changed (ages are shown in minutes).
  const now = await $.clock.now()
  const key = JSON.stringify([
    selfId,
    sessions.map(s => [s.sessionId, s.name, s.cwd, badge(s).label, s.tmux, formatAge(now - since(s))]),
  ])
  if (key !== drawnKey) {
    drawnKey = key
    $.ui.invalidate('ui.render')
  }
}

/** A registry file can outlive a crashed session, and its pid can be reused: check the process is that session. */
async function isAlive($: EngineInterface, s: Session): Promise<boolean> {
  if (s.sessionId === selfId) return true
  if (hasProc) {
    const stat = await $.fs.read(`/proc/${s.pid}/stat`).catch(() => null)
    if (typeof stat !== 'string') return false
    return s.procStart === undefined || parseStat(stat)?.startTime === s.procStart
  }
  return livePids === null || livePids.has(s.pid) || s.startedAt > liveCheckedAt
}

/** Without /proc, asks Claude Code which sessions are running. */
async function checkLive($: EngineInterface): Promise<void> {
  const startedAt = await $.clock.now()
  try {
    const run = await $.process.run(['claude', 'agents', '--json'], { timeoutMs: 10_000 })
    const pids = run.exitCode === 0 ? parseLivePids(run.stdout) : null
    if (pids !== null) {
      livePids = pids
      liveCheckedAt = startedAt
    }
  } catch {
    // `claude` not on PATH or too slow: keep the last answer.
  }
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

async function switchTo($: EngineInterface, s: Session): Promise<void> {
  try {
    if (s.sessionId === selfId) {
      $.ui.toast("You're already in this session.")
      return
    }
    const pane = tmuxPane(s.tmux)
    if (pane === null) {
      $.ui.toast(
        s.kind === 'interactive'
          ? `${s.name} isn't running in tmux, so it can't be switched to from here.`
          : `${s.name} is a ${s.kind} session: open it from \`claude agents\`.`,
      )
      return
    }
    if ((await $.env.get('TMUX')) === undefined) {
      $.ui.toast("This session isn't inside tmux, so it can't switch panes.")
      return
    }
    // Pane ids are only unique per tmux server: make sure this server's pane is the one running that session.
    const where = await $.process.run(['tmux', 'display-message', '-p', '-t', pane, '#{pane_pid}'])
    const panePid = Number(where.stdout.trim())
    if (where.exitCode !== 0 || !Number.isInteger(panePid) || !(await descendsFrom(s.pid, panePid, await parentOf($)))) {
      $.ui.toast(`${s.name} isn't in a pane of this tmux server.`)
      return
    }
    // Switch the terminal that shows this session, not whichever one tmux would guess.
    const ownPane = await $.env.get('TMUX_PANE')
    const clients =
      ownPane === undefined
        ? undefined
        : await $.process.run(['tmux', 'list-clients', '-F', '#{client_activity} #{client_name} #{pane_id}'])
    const client = clients?.exitCode === 0 && ownPane !== undefined ? clientShowing(clients.stdout, ownPane) : undefined
    const sw = await $.process.run(['tmux', 'switch-client', ...(client === undefined ? [] : ['-c', client]), '-t', pane])
    if (sw.exitCode !== 0) $.ui.toast(`tmux: ${sw.stderr.trim() || 'switch failed'}`)
  } catch (error) {
    $.ui.toast(`Couldn't switch to ${s.name}: ${errorText(error)}`)
  }
}

const clip = (text: string, room: number): string =>
  text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1))}…`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Headless runs (`claude -p`, the SDK) draw nothing, so there is nothing to keep fresh.
    if (!e.isInteractive) return next(e)

    try {
      const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
      registryDir = `${configDir}/sessions`
      hasProc = await $.fs.exists('/proc/self/stat').catch(() => false)

      // Poll only while the sidebar is open; `/tabs N` refreshes on demand.
      $.clock.every(REFRESH_MS, () => {
        void isPaneOpen($)
          .then(isOpen => (isOpen ? refresh($) : undefined))
          .catch(() => {})
      })
      if (!hasProc) {
        $.clock.every(LIVE_CHECK_MS, () => {
          void isPaneOpen($)
            .then(isOpen => (isOpen ? checkLive($).then(() => refresh($)) : undefined))
            .catch(() => {})
        })
        void checkLive($).then(() => refresh($))
      }
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
        description: 'Toggle the sessions sidebar, or switch to a session by number or name',
        argumentHint: '[number|name]',
        immediate: true,
      })
    } catch (error) {
      $.ui.log(`session-tabs: /tabs not registered: ${errorText(error)}`)
    }
    return next(e)
  })

  on('command.run', { command: 'tabs' }, async ($, e) => {
    const query = e.args.trim()
    if (query === '') {
      if (await isPaneOpen($)) {
        await $.ui.close({ id: PANE })
      } else {
        await $.store.set('autoOpen', true)
        await refresh($)
        await $.ui.open({ id: PANE, title: TITLE, columns: WIDTH, focus: true })
      }
      return {}
    }
    if (!hasProc) await checkLive($)
    await refresh($)
    const found = pick(sessions, query)
    if (found === undefined) $.ui.toast(`No session matches "${query}".`)
    else await switchTo($, found)
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
    const room = Math.max(8, e.props.bodyColumns - 5)
    const waiting = sessions.filter(s => s.sessionId !== selfId && badge(s).tone === 'needs').length

    const rows = sessions.map((s, i) => {
      const b = badge(s)
      const isSelf = s.sessionId === selfId
      const label = clip(s.name, isSelf ? room - 2 : room)
      const name = isSelf ? (
        <Text bold color="claude">
          {`${i < 9 ? `${i + 1}: ` : ''}${label} ◂`}
        </Text>
      ) : (
        <Button
          key={`go-${s.sessionId}`}
          label={label}
          plain
          {...(i < 9 ? { hotkey: String(i + 1) } : {})}
          onPress={() => switchTo($, s)}
        />
      )
      const status = `${b.label} ${formatAge(now - since(s))}`
      return (
        <Box key={`row-${s.sessionId}`} flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Text color={b.color}>{b.glyph}</Text>
            {name}
            {!isDocked && (
              <Text dimColor wrap="truncate-end">
                {status}
              </Text>
            )}
          </Box>
          {isDocked && (
            <Text dimColor wrap="truncate-end">
              {`  ${status} · ${basename(s.cwd)}`}
            </Text>
          )}
        </Box>
      )
    })

    return (
      <Box flexDirection="column" rowGap={isDocked ? 1 : 0}>
        <Text dimColor>
          {`${sessions.length} session${sessions.length === 1 ? '' : 's'}`}
          {waiting > 0 ? ` · ${waiting} need${waiting === 1 ? 's' : ''} you` : ''}
        </Text>
        {sessions.length === 0 ? <Text dimColor>No running sessions found.</Text> : rows}
        {isDocked && <Text dimColor>/tabs N to switch</Text>}
      </Box>
    )
  })
}
