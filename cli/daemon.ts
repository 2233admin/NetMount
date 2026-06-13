// CLI daemon lifecycle: spawn rclone rcd as a detached background process,
// bound to 127.0.0.1 with random credentials (never --rc-no-auth), and track
// it via ~/.netmount/daemon.json. The CLI entrypoint is node-only, so this
// uses node APIs directly rather than the runtime port (which exists to let
// shared controller/services run on both GUI and CLI).
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { useRcloneStore } from '../src/stores/useRcloneStore'
import { nmConfig } from '../src/services/ConfigService'

const NM_DIR = join(homedir(), '.netmount')
const STATE_FILE = join(NM_DIR, 'daemon.json')
const CONFIG_FILE = join(NM_DIR, 'rclone.conf')
const LOG_FILE = join(NM_DIR, 'rclone.log')

// Where the CLI keeps its state. config.json is the NMConfig app settings
// (written by the node runtime's configIO); the rest are daemon-owned.
export const nmPaths = {
  dir: NM_DIR,
  appConfig: join(NM_DIR, 'config.json'),
  daemonState: STATE_FILE,
  rcloneConf: CONFIG_FILE,
  rcloneLog: LOG_FILE,
} as const

export interface DaemonState {
  pid: number
  url: string
  port: number
  user: string
  pass: string
}

function randCred(): string {
  return randomBytes(18).toString('base64url')
}

function authHeader(s: Pick<DaemonState, 'user' | 'pass'>): string {
  return `Basic ${Buffer.from(`${s.user}:${s.pass}`).toString('base64')}`
}

function resolveRcloneBin(): string {
  const env = process.env.NETMOUNT_RCLONE_BIN
  if (env) return env
  return process.platform === 'win32' ? 'rclone.exe' : 'rclone'
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

async function readState(): Promise<DaemonState | undefined> {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8')) as DaemonState
  } catch {
    return undefined
  }
}

async function writeState(s: DaemonState): Promise<void> {
  await mkdir(NM_DIR, { recursive: true })
  // 0o600: the state file holds the RC credentials in plaintext.
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 })
}

export async function ping(s: Pick<DaemonState, 'url' | 'user' | 'pass'>): Promise<boolean> {
  try {
    const res = await fetch(`${s.url}/rc/noop`, {
      method: 'POST',
      headers: { Authorization: authHeader(s) },
      signal: AbortSignal.timeout(800),
    })
    return res.ok
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Start rcd if not already healthy. Returns the live daemon state.
export async function ensureDaemon(): Promise<DaemonState> {
  const existing = await readState()
  if (existing && (await ping(existing))) return existing

  const bin = resolveRcloneBin()
  const port = await freePort()
  const state: DaemonState = {
    pid: 0,
    url: `http://127.0.0.1:${port}`,
    port,
    user: randCred(),
    pass: randCred(),
  }
  await mkdir(NM_DIR, { recursive: true })

  const args = [
    'rcd',
    `--rc-addr=127.0.0.1:${port}`,
    `--rc-user=${state.user}`,
    `--rc-pass=${state.pass}`,
    `--config=${CONFIG_FILE}`,
    `--log-file=${LOG_FILE}`,
    '--log-level=INFO',
  ]

  let child
  try {
    child = spawn(bin, args, { detached: true, stdio: 'ignore' })
  } catch (e) {
    throw new DaemonError(
      `Failed to spawn rclone (${bin}): ${(e as Error).message}`,
      'Set NETMOUNT_RCLONE_BIN to the rclone binary path, or put rclone on PATH.'
    )
  }
  child.on('error', () => {}) // surfaced via the ping timeout below
  child.unref()
  state.pid = child.pid ?? 0

  for (let i = 0; i < 40; i++) {
    if (await ping(state)) {
      await writeState(state)
      return state
    }
    await sleep(150)
  }
  throw new DaemonError(
    `rclone rcd did not become ready on ${state.url}`,
    `Check ${LOG_FILE}. If rclone is missing, set NETMOUNT_RCLONE_BIN.`
  )
}

export async function daemonStatus(): Promise<{ running: boolean; state?: DaemonState }> {
  const s = await readState()
  if (s && (await ping(s))) return { running: true, state: s }
  return { running: false, state: s }
}

export async function stopDaemon(): Promise<boolean> {
  const s = await readState()
  if (!s) return false
  try {
    await fetch(`${s.url}/core/quit`, {
      method: 'POST',
      headers: { Authorization: authHeader(s) },
      signal: AbortSignal.timeout(2000),
    })
  } catch {
    // fall through to kill
  }
  if (s.pid) {
    try {
      process.kill(s.pid)
    } catch {
      // already gone
    }
  }
  await rm(STATE_FILE, { force: true })
  return true
}

// Wire a live daemon into the shared store + config so controller/services
// read the right endpoint and Basic-auth credentials.
export function connectStore(s: DaemonState): void {
  useRcloneStore.getState().setEndpoint({
    url: s.url,
    isLocal: true,
    auth: {},
    localhost: { port: s.port },
  })
  nmConfig.framework.rclone.user = s.user
  nmConfig.framework.rclone.password = s.pass
}

export class DaemonError extends Error {
  hint: string
  constructor(message: string, hint: string) {
    super(message)
    this.name = 'DaemonError'
    this.hint = hint
  }
}
