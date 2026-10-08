// Pure logic: no `$`, so the tests can call it directly.

/** One running Claude Code session, as its registry file describes it. */
export type Session = {
  pid: number
  sessionId: string
  name: string
  cwd: string
  kind: string
  status?: string
  waitingFor?: string
  startedAt: number
  statusUpdatedAt?: number
  /** The process's start time in clock ticks, as `/proc/<pid>/stat` field 22 has it (Linux). */
  procStart?: string
  /** `<session>:<window>.<pane>`, present when the session runs inside tmux. */
  tmux?: string
}

export type Tone = 'working' | 'needs' | 'idle' | 'other'

export type Badge = { glyph: string; color: string; label: string; tone: Tone }

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Registry files are named `<pid>.json`; the `<pid>.<hash>.key` files beside them are secrets and never read. */
export const isRegistryFile = (name: string): boolean => /^\d+\.json$/.test(name)

/** Parses one registry file; null for anything that is not a usable session record. */
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
  const sessionId = str(o.sessionId)
  const cwd = str(o.cwd)
  if (pid === undefined || sessionId === undefined || cwd === undefined) return null
  return {
    pid,
    sessionId,
    cwd,
    name: str(o.name) ?? basename(cwd),
    kind: str(o.kind) ?? 'interactive',
    status: str(o.status),
    waitingFor: str(o.waitingFor),
    startedAt: num(o.startedAt) ?? 0,
    statusUpdatedAt: num(o.statusUpdatedAt),
    procStart: str(o.procStart),
    tmux: str(o.tmux),
  }
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

/** The pids `claude agents --json` reports as running; null when the output is unusable or empty. */
export function parseLivePids(stdout: string): Set<number> | null {
  try {
    const list: unknown = JSON.parse(stdout)
    if (!Array.isArray(list)) return null
    const pids = new Set<number>()
    for (const item of list) {
      const pid = num((item as Record<string, unknown> | null)?.pid)
      if (pid !== undefined) pids.add(pid)
    }
    // There is always at least the session asking, so an empty answer is not to be trusted.
    return pids.size > 0 ? pids : null
  } catch {
    return null
  }
}

/**
 * One record per session id (the newest, when a resumed session left an older one behind),
 * ordered by start time so tabs don't jump around.
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

/** Finds a session by its 1-based tab number or by (a prefix of) its name. */
export function pick(sessions: readonly Session[], query: string): Session | undefined {
  const q = query.trim()
  if (/^\d+$/.test(q)) return sessions[Number(q) - 1]
  const lower = q.toLowerCase()
  return sessions.find(s => s.name.toLowerCase() === lower) ?? sessions.find(s => s.name.toLowerCase().startsWith(lower))
}
