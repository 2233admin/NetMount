// CLI openlist lifecycle. Mirrors cli/daemon.ts in spirit: bring the openlist
// sidecar up headless (reusing the app's startOpenlist()), register its WebDAV
// gateway as an rclone bridge remote, and track a small state file so repeat
// CLI invocations are idempotent. openlist is reached only on localhost; the
// admin password is random per run (from the app config default) and never
// printed.
//
// Why a separate seeding step: the GUI populates several singletons at startup
// (runtimeEnv.path.homeDir, osInfo, cacheDir) before any business logic runs.
// The CLI must do the same before calling shared openlist code, or path
// helpers (openlistDataDir, temp_dir) resolve wrong.
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { getRuntime } from '../src/runtime/port'
import type { OSInfo } from '../src/type/config'
import { runtimeEnv } from '../src/services/config/roConfig'
import { configService, nmConfig } from '../src/services/ConfigService'
import { useOpenlistStore } from '../src/stores/useOpenlistStore'
import { startOpenlist, stopOpenlist } from '../src/utils/openlist/process'
import { addOpenlistInRclone } from '../src/utils/openlist/openlist'
import { openlist_api_ping } from '../src/utils/openlist/request'
import { updateStorageInfoList } from '../src/controller/storage/allList'
import { ensureDaemon, connectStore, nmPaths, type DaemonState } from './daemon'
import { ensureOpenlistBin } from './bootstrap'

const OPENLIST_STATE_FILE = join(nmPaths.dir, 'openlist-daemon.json')

export interface OpenlistState {
  url: string
  port: number
  token: string
}

// Seed the singletons the shared openlist code assumes the GUI populated.
// Idempotent and cheap; safe to call before every openlist operation.
//
// osType: the GUI gets osType from @tauri-apps/plugin-os os.type(), which on
// Windows returns 'windows' (lowercase). node:os type() returns 'Windows_NT',
// which breaks process.ts's `osInfo.osType === 'windows'` path-format check and
// yields a malformed temp_dir like "/C:/...". Normalize osType to the platform
// value so the shared code formats Windows paths correctly. This is a singleton
// seed, not a change to shared source.
let seeded = false
async function seedOpenlistSingletons(): Promise<void> {
  if (seeded) return
  if (!runtimeEnv.path.homeDir || runtimeEnv.path.homeDir === '~') {
    runtimeEnv.path.homeDir = homedir()
  }
  const os = await getRuntime().osInfo.info()
  // os.platform is the Platform string ('windows'|'macos'|'linux'); on Windows
  // it shares the value the OsType-based check in process.ts expects. Use it for
  // osType too so path formatting takes the correct branch. The runtime returns
  // plain strings (decoupled from the @tauri-apps enums), so cast like the GUI's
  // getOsInfo() does.
  configService.setOsInfo({ ...os, osType: os.platform } as OSInfo)
  if (!nmConfig.settings.path.cacheDir) {
    configService.updatePath(
      'settings.path.cacheDir',
      join(runtimeEnv.path.homeDir, '.cache', 'netmount')
    )
  }
  seeded = true
}

async function readOpenlistState(): Promise<OpenlistState | undefined> {
  try {
    return JSON.parse(await readFile(OPENLIST_STATE_FILE, 'utf8')) as OpenlistState
  } catch {
    return undefined
  }
}

async function writeOpenlistState(s: OpenlistState): Promise<void> {
  await mkdir(nmPaths.dir, { recursive: true })
  // 0o600: the state file holds the openlist admin token in plaintext.
  await writeFile(OPENLIST_STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 })
}

// Push a known endpoint/token into the openlist store so controller code that
// reads openlistInfo (request.ts, providers.ts, StorageManager) talks to the
// already-running server without us re-launching it.
function hydrateOpenlistStore(s: OpenlistState): void {
  useOpenlistStore.getState().updateEndpoint({ url: s.url, auth: { token: s.token } })
  useOpenlistStore.getState().updateOpenlistConfig({ scheme: { http_port: s.port } })
}

// Is a previously-recorded openlist still answering? Hydrate the store first so
// the ping targets the recorded url.
async function pingRecorded(s: OpenlistState): Promise<boolean> {
  hydrateOpenlistStore(s)
  return openlist_api_ping()
}

// Bring openlist up if not already running, plus the rcd it bridges into.
// Idempotent: if a recorded openlist still answers, just hydrate the store.
// Returns the live openlist state. ensureDaemon()+connectStore() are required
// because addOpenlistInRclone() talks to the live rcd.
export async function ensureOpenlist(): Promise<OpenlistState> {
  await seedOpenlistSingletons()

  // rcd must be up and wired so addOpenlistInRclone() (and the bridge remote)
  // can reach it.
  const daemon: DaemonState = await ensureDaemon()
  connectStore(daemon)

  const existing = await readOpenlistState()
  if (existing && (await pingRecorded(existing))) {
    // Already running and reachable; ensure the rclone bridge remote exists in
    // this (possibly fresh) rcd, then return. addOpenlistInRclone() looks up the
    // 'webdav' provider via searchStorageInfo, so the catalog must be populated
    // first.
    await updateStorageInfoList()
    await addOpenlistInRclone()
    return existing
  }

  // Start a fresh openlist (writes config, resets admin pass, spawns server,
  // fetches token, enables WebDAV perms). Uses the singletons seeded above.
  // Make sure the openlist binary is on disk first; the shared spawn path
  // resolves it via NETMOUNT_OPENLIST_BIN, which ensureOpenlistBin() sets.
  await ensureOpenlistBin()
  await startOpenlist()

  const ep = useOpenlistStore.getState().endpoint
  const port = useOpenlistStore.getState().openlistConfig.scheme?.http_port ?? 0
  const state: OpenlistState = { url: ep.url, port, token: ep.auth.token ?? '' }

  // Populate the storage catalog (openlist drivers + rclone providers) so
  // addOpenlistInRclone()'s searchStorageInfo('webdav') resolves; without it the
  // shared StorageCreationService hits a not-found path. openlist is up now, so
  // the openlist driver list query succeeds too.
  await updateStorageInfoList()

  // Register openlist's /dav WebDAV gateway as the single rclone bridge remote.
  await addOpenlistInRclone()

  await writeOpenlistState(state)
  return state
}

// Stop openlist (graceful then hard-kill the sidecar) and drop the state file.
export async function stopOpenlistDaemon(): Promise<boolean> {
  await seedOpenlistSingletons()
  const existing = await readOpenlistState()
  try {
    await stopOpenlist()
  } catch {
    // best-effort; fall through to clearing state
  }
  await rm(OPENLIST_STATE_FILE, { force: true })
  return existing !== undefined
}

// Report whether openlist is running (and where), without starting it.
export async function openlistStatus(): Promise<{ running: boolean; state?: OpenlistState }> {
  await seedOpenlistSingletons()
  const s = await readOpenlistState()
  if (s && (await pingRecorded(s))) return { running: true, state: s }
  return { running: false, state: s }
}

export const openlistPaths = {
  state: OPENLIST_STATE_FILE,
  dataDir: join(nmPaths.dir, 'openlist'),
} as const
