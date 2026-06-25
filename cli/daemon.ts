import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { nmConfig } from '../src/services/ConfigService'
import { useRcloneStore } from '../src/stores/useRcloneStore'

const execFileAsync = promisify(execFile)

const NM_DIR = join(homedir(), '.netmount')
const STATE_FILE = join(NM_DIR, 'daemon.json')
const CONFIG_FILE = join(NM_DIR, 'rclone.conf')
const LOG_FILE = join(NM_DIR, 'rclone.log')

export const nmPaths = {
  dir: NM_DIR,
  appConfig: join(NM_DIR, 'config.json'),
  daemonState: STATE_FILE,
  rcloneConf: CONFIG_FILE,
  rcloneLog: LOG_FILE,
}

export interface DaemonState {
  pid: number
  url: string
  port: number
  user: string
  pass: string
}

export interface PublicDaemonState {
  pid: number
  url: string
  port: number
}

export class DaemonError extends Error {
  hint: string

  constructor(message: string, hint: string) {
    super(message)
    this.name = 'DaemonError'
    this.hint = hint
  }
}

function randCred(): string {
  return randomBytes(18).toString('base64url')
}

function authHeader(s: Pick<DaemonState, 'user' | 'pass'>): string {
  return `Basic ${Buffer.from(`${s.user}:${s.pass}`).toString('base64')}`
}

export function resolveRcloneBin(): string {
  if (process.env.NETMOUNT_RCLONE_BIN) return process.env.NETMOUNT_RCLONE_BIN
  return process.platform === 'win32' ? 'rclone.exe' : 'rclone'
}

export function publicDaemonState(s: DaemonState): PublicDaemonState {
  return { pid: s.pid, url: s.url, port: s.port }
}

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

async function readState(): Promise<DaemonState | undefined> {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8')) as DaemonState
  } catch {
    return undefined
  }
}

async function writeState(s: DaemonState): Promise<void> {
  await mkdir(NM_DIR, { recursive: true })
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 })
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      server.close(() => {
        if (addr && typeof addr === 'object') resolve(addr.port)
        else reject(new Error('failed to allocate local port'))
      })
    })
  })
}

async function ping(s: DaemonState): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 800)
  try {
    const res = await fetch(`${s.url}/rc/noop`, {
      method: 'POST',
      headers: { Authorization: authHeader(s) },
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function killProcessTree(pid: number): Promise<boolean> {
  try {
    process.kill(pid)
  } catch {
    return true
  }

  await sleep(250)
  try {
    process.kill(pid, 0)
  } catch {
    return true
  }

  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'])
      return true
    } catch {
      return false
    }
  }

  return false
}

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

  let spawnError: Error | undefined
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
  child.once('error', error => {
    spawnError = error
  })
  child.unref()
  state.pid = child.pid ?? 0

  for (let i = 0; i < 40; i += 1) {
    if (spawnError) {
      throw new DaemonError(
        `failed to start rclone (${bin}): ${spawnError.message}`,
        'Run `netmount config doctor`, then set NETMOUNT_RCLONE_BIN to the rclone binary path or put rclone on PATH.'
      )
    }
    if (await ping(state)) {
      await writeState(state)
      return state
    }
    await sleep(150)
  }

  throw new DaemonError(
    `rclone rcd did not become ready on ${state.url}`,
    `Run \`netmount config doctor\`, check ${LOG_FILE}, and set NETMOUNT_RCLONE_BIN if rclone is missing.`
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
  const stopped = await killProcessTree(s.pid)
  await rm(STATE_FILE, { force: true })
  return stopped
}
