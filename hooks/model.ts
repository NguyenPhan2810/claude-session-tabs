// Pure logic: no `$`, so the tests can call it directly.

/** One running Claude Code session, as its registry file describes it. */
export type Session = {
  pid: number
  sessionId: string
  name: string
  cwd: string
  /** `interactive` for a terminal session, `bg` for one the supervisor runs. */
  kind: 'interactive' | 'bg'
  status?: string
  waitingFor?: string
  startedAt: number
  statusUpdatedAt?: number
  /** The process's start time in clock ticks, as `/proc/<pid>/stat` field 22 has it (Linux). */
  procStart?: string
  /** `<session>:<window>.<pane>`, present when the session runs inside tmux. */
  tmux?: string
  /** A pre-started background worker with no conversation yet. */
  spare?: boolean
  /** Set on a terminal that handed its conversation to a background session: a client now, not a session. */
  parkedJobId?: string
  /** A background session's id for `claude attach`. */
  jobId?: string
}

/** A background session as `claude agents --json --all` lists it: running, waiting or finished. */
export type Job = {
  id: string
  sessionId: string
  name: string
  cwd: string
  state?: string
  startedAt: number
}

/** A tab, kept in the mod's store until it is closed. Closing is kept apart, under its own key. */
export type TabRecord = {
  sessionId: string
  name: string
  cwd: string
  kind: 'interactive' | 'background'
  jobId?: string
  openedAt: number
  /** The process last seen running the session, to follow a terminal that starts a new conversation. */
  pid?: number
  procStart?: string
  /** When an interactive session's process was found gone. */
  endedAt?: number
  /** When a background session first went missing from the roster. */
  missingSince?: number
}

/** A tab as drawn: its record, plus what is running for it now. */
export type Tab = { record: TabRecord; live?: Session; job?: Job }

export type Tone = 'working' | 'needs' | 'idle' | 'other'

export type Badge = { glyph: string; color: string; label: string; tone: Tone }

/** How long a background session may be missing from the roster before its tab closes. */
export const MISSING_GRACE_MS = 60_000
/** The most tabs kept open; past it, the tabs of sessions that ended longest ago close. */
export const MAX_TABS = 40

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export const isJobId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-z][0-9a-z-]{0,63}$/i.test(v)
export const isSessionId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f][0-9a-f-]{7,63}$/i.test(v)

/** Registry files are named `<pid>.json`; the `<pid>.<hash>.key` files beside them are secrets and never read. */
export const isRegistryFile = (name: string): boolean => /^\d+\.json$/.test(name)

/** Parses one registry file; null for anything that is not a terminal or background conversation's record. */
export function parseSession(text: string): Session | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const pid = num(o.pid)
  const sessionId = o.sessionId
  const cwd = str(o.cwd)
  const kind = o.kind ?? 'interactive'
  if (pid === undefined || !isSessionId(sessionId) || cwd === undefined) return null
  if (kind !== 'interactive' && kind !== 'bg') return null
  const jobId = isJobId(o.jobId) ? o.jobId : undefined
  return {
    pid,
    sessionId,
    cwd,
    name: str(o.name) ?? basename(cwd),
    kind,
    status: str(o.status),
    waitingFor: str(o.waitingFor),
    startedAt: num(o.startedAt) ?? 0,
    statusUpdatedAt: num(o.statusUpdatedAt),
    procStart: str(o.procStart),
    tmux: str(o.tmux),
    spare: o.spare === true,
    parkedJobId: str(o.parkedJobId),
    jobId,
  }
}

/** Whether a registry entry is a conversation worth a tab, not a spare worker or a terminal that only shows a background one. */
export const isConversation = (s: Session): boolean => !s.spare && s.parkedJobId === undefined

/** `claude agents --json --all`: the background sessions, and the pids of running interactive ones. */
export function parseRoster(stdout: string): { jobs: Job[]; livePids: Set<number> } | null {
  let list: unknown
  try {
    list = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(list)) return null
  const jobs: Job[] = []
  const livePids = new Set<number>()
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (o.kind === 'background' && isJobId(o.id) && isSessionId(o.sessionId)) {
      jobs.push({
        id: o.id,
        sessionId: o.sessionId,
        name: str(o.name) ?? o.id,
        cwd: str(o.cwd) ?? '',
        state: str(o.state),
        startedAt: num(o.startedAt) ?? 0,
      })
    } else if (o.kind === 'interactive' && num(o.pid) !== undefined) {
      livePids.add(num(o.pid)!)
    }
  }
  // The session asking is always listed, so an empty answer is not to be trusted.
  return jobs.length === 0 && livePids.size === 0 ? null : { jobs, livePids }
}

/** Parent pid and start time from `/proc/<pid>/stat`. The name in parentheses may hold spaces, so fields count from its `)`. */
export function parseStat(text: string): { ppid: number; startTime: string } | null {
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
  // After the name: field 3 (state) is index 0, so field 4 (ppid) is 1 and field 22 (starttime) is 19.
  const ppid = Number(fields[1])
  const startTime = fields[19]
  return Number.isInteger(ppid) && startTime !== undefined && /^\d+$/.test(startTime) ? { ppid, startTime } : null
}

/** `ps -A -o pid=,ppid=` output as a pid → parent pid map. */
export function parseProcessTable(stdout: string): Map<number, number> {
  const parents = new Map<number, number>()
  for (const line of stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (Number.isInteger(pid) && Number.isInteger(ppid)) parents.set(pid!, ppid!)
  }
  return parents
}

/** Whether `ancestor` is `pid` or one of its parents, following `parentOf` a bounded number of steps. */
export async function descendsFrom(
  pid: number,
  ancestor: number,
  parentOf: (pid: number) => Promise<number | undefined>,
): Promise<boolean> {
  let current: number | undefined = pid
  for (let step = 0; step < 32 && current !== undefined && current > 1; step++) {
    if (current === ancestor) return true
    current = await parentOf(current)
  }
  return current === ancestor
}

/**
 * One record per session id (the newest, when a resumed session left an older one behind),
 * ordered by start time.
 */
export function orderSessions(all: readonly Session[]): Session[] {
  const newest = new Map<string, Session>()
  for (const s of all) {
    const held = newest.get(s.sessionId)
    const isNewer =
      held === undefined ||
      s.startedAt > held.startedAt ||
      (s.startedAt === held.startedAt && (s.statusUpdatedAt ?? 0) > (held.statusUpdatedAt ?? 0))
    if (isNewer) newest.set(s.sessionId, s)
  }
  return [...newest.values()].sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid)
}

export type TabChanges = { upserts: TabRecord[]; closes: string[] }

/**
 * Brings the stored tabs up to date with what is running, OpenCode-style: a tab stays until closed.
 *
 * - A new conversation gets a tab. One a terminal started in place of another (`/clear`, `/resume`)
 *   takes over that tab's place, and the old tab closes.
 * - An interactive tab whose session is no longer `present` is marked ended and stays.
 * - A background tab whose session has been missing from a readable roster for a minute closes, as
 *   OpenCode closes tabs of deleted sessions. `jobs` is null when the roster couldn't be read.
 * - Past MAX_TABS open tabs, those whose sessions ended longest ago close.
 *
 * `present` holds the ids to treat as still there (the live ones, plus any missed only once, so a
 * half-written registry file doesn't end a tab). Only records that changed are returned.
 */
export function syncTabs(
  stored: readonly TabRecord[],
  closed: ReadonlySet<string>,
  live: readonly Session[],
  present: ReadonlySet<string>,
  jobs: readonly Job[] | null,
  now: number,
): TabChanges {
  const original = new Map(stored.map(r => [r.sessionId, r]))
  const changed = new Map<string, TabRecord>()
  const closes = new Set<string>()
  const current = (id: string) => changed.get(id) ?? original.get(id)
  const put = (next: TabRecord) => {
    const before = original.get(next.sessionId)
    if (before !== undefined && sameRecord(before, next)) changed.delete(next.sessionId)
    else changed.set(next.sessionId, next)
  }
  const isOpen = (id: string) => !closed.has(id) && !closes.has(id)
  const jobById = new Map((jobs ?? []).map(j => [j.sessionId, j]))
  const liveIds = new Set(live.map(s => s.sessionId))

  for (const s of live) {
    if (closed.has(s.sessionId)) continue
    const job = jobById.get(s.sessionId)
    const kind = s.kind === 'bg' || job !== undefined ? 'background' : 'interactive'
    let held = current(s.sessionId)
    if (held === undefined && kind === 'interactive' && s.procStart !== undefined) {
      // The same process with a new conversation: the terminal's tab moves on to it.
      const before = stored.find(
        r => r.kind === 'interactive' && r.pid === s.pid && r.procStart === s.procStart && !liveIds.has(r.sessionId) && isOpen(r.sessionId),
      )
      if (before !== undefined) {
        closes.add(before.sessionId)
        held = { ...before, sessionId: s.sessionId }
      }
    }
    const jobId = s.jobId ?? job?.id
    put({
      sessionId: s.sessionId,
      name: s.name,
      cwd: s.cwd,
      kind,
      openedAt: held?.openedAt ?? (s.startedAt || now),
      pid: s.pid,
      ...(s.procStart === undefined ? {} : { procStart: s.procStart }),
      ...(jobId === undefined ? {} : { jobId }),
    })
  }

  for (const job of jobs ?? []) {
    if (closed.has(job.sessionId) || liveIds.has(job.sessionId)) continue
    const held = current(job.sessionId)
    put({
      sessionId: job.sessionId,
      name: job.name,
      cwd: job.cwd || held?.cwd || '',
      kind: 'background',
      jobId: job.id,
      openedAt: held?.openedAt ?? (job.startedAt || now),
      ...(held?.pid === undefined ? {} : { pid: held.pid }),
      ...(held?.procStart === undefined ? {} : { procStart: held.procStart }),
    })
  }

  for (const r of stored) {
    if (!isOpen(r.sessionId) || present.has(r.sessionId) || jobById.has(r.sessionId)) continue
    const held = current(r.sessionId)!
    if (held.kind === 'interactive' && held.endedAt === undefined) put({ ...held, endedAt: now })
    if (held.kind === 'background' && jobs !== null) {
      if (held.missingSince === undefined) put({ ...held, missingSince: now })
      else if (now - held.missingSince >= MISSING_GRACE_MS) closes.add(r.sessionId)
    }
  }

  // Past the cap, the tabs whose sessions ended longest ago close.
  const open = new Map<string, TabRecord>()
  for (const r of [...stored, ...changed.values()]) if (isOpen(r.sessionId)) open.set(r.sessionId, current(r.sessionId)!)
  const ended = [...open.values()].filter(r => r.endedAt !== undefined).sort((a, b) => a.endedAt! - b.endedAt!)
  for (let excess = open.size - MAX_TABS; excess > 0 && ended.length > 0; excess--) closes.add(ended.shift()!.sessionId)

  return { upserts: [...changed.values()].filter(r => !closes.has(r.sessionId)), closes: [...closes] }
}

function sameRecord(a: TabRecord, b: TabRecord): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof TabRecord>
  for (const key of keys) if (a[key] !== b[key]) return false
  return true
}

/** The open tabs, oldest first, each with what is running for it. */
export function openTabs(
  records: readonly TabRecord[],
  closed: ReadonlySet<string>,
  live: readonly Session[],
  jobs: readonly Job[],
): Tab[] {
  const liveById = new Map(live.map(s => [s.sessionId, s]))
  const jobById = new Map(jobs.map(j => [j.sessionId, j]))
  return records
    .filter(r => !closed.has(r.sessionId))
    .sort((a, b) => a.openedAt - b.openedAt || a.sessionId.localeCompare(b.sessionId))
    .map(record => ({ record, live: liveById.get(record.sessionId), job: jobById.get(record.sessionId) }))
}

/** The tmux client showing `pane` that was used last, from `list-clients -F '#{client_activity} #{client_name} #{pane_id}'`. */
export function clientShowing(stdout: string, pane: string): string | undefined {
  let best: { activity: number; name: string } | undefined
  for (const line of stdout.split('\n')) {
    const [activity, name, shown] = line.trim().split(' ')
    if (name === undefined || shown !== pane) continue
    const at = Number(activity)
    if (best === undefined || at > best.activity) best = { activity: at, name }
  }
  return best?.name
}

export function badge(s: Session): Badge {
  if (s.waitingFor !== undefined || s.status === 'waiting' || s.status === 'blocked') {
    return { glyph: '●', color: 'warning', label: s.waitingFor ?? 'needs input', tone: 'needs' }
  }
  if (s.status === 'busy') return { glyph: '●', color: 'claude', label: 'working', tone: 'working' }
  if (s.status === 'idle') return { glyph: '○', color: 'inactive', label: 'idle', tone: 'idle' }
  return { glyph: '·', color: 'subtle', label: s.status ?? s.kind, tone: 'other' }
}

/**
 * How a tab's status is drawn: a background job's settled state (waiting, done, failed, stopped)
 * first, as agent view shows it; then a running process's own status; then the job's.
 */
export function tabBadge(tab: Tab): Badge {
  const state = tab.job?.state
  if (state === 'blocked') return { glyph: '●', color: 'warning', label: tab.live?.waitingFor ?? 'needs input', tone: 'needs' }
  if (tab.live !== undefined && (state === undefined || state === 'running')) return badge(tab.live)
  if (state === 'running') return { glyph: '●', color: 'claude', label: 'working', tone: 'working' }
  if (state === 'done') return { glyph: '✓', color: 'success', label: 'done', tone: 'other' }
  if (state === 'failed') return { glyph: '✗', color: 'error', label: 'failed', tone: 'other' }
  if (state === 'stopped') return { glyph: '■', color: 'inactive', label: 'stopped', tone: 'other' }
  if (tab.record.kind === 'background') return { glyph: '○', color: 'inactive', label: 'paused', tone: 'idle' }
  return { glyph: '–', color: 'inactive', label: 'exited', tone: 'other' }
}

export function formatAge(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.at(-1) ?? path
}

/** The `%pane` part of a registry `tmux` field, a pane id that is unique on its tmux server. */
export function tmuxPane(field: string | undefined): string | null {
  const [, pane] = field?.match(/\.(%\d+)$/) ?? []
  return pane ?? null
}

/** Finds an item by its 1-based tab number or by (a prefix of) its name. */
export function pick<T>(items: readonly T[], query: string, nameOf: (item: T) => string): T | undefined {
  const q = query.trim()
  if (/^\d+$/.test(q)) return items[Number(q) - 1]
  const lower = q.toLowerCase()
  const name = (item: T) => nameOf(item).toLowerCase()
  return items.find(item => name(item) === lower) ?? items.find(item => name(item).startsWith(lower))
}

/** The folder under `~/.claude/projects` that holds a directory's transcripts: every non-alphanumeric becomes `-`. */
export const projectDirName = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

/** A window name tmux shows as typed: no format characters, no control characters, not too long. */
export const windowName = (name: string): string => name.replace(/[#\p{Cc}]/gu, '').slice(0, 40) || 'claude'

/** tmux expands formats in a start directory, so a `#` in a path is written `##`. */
export const tmuxLiteral = (text: string): string => text.replace(/#/g, '##')
