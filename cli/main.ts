#!/usr/bin/env bun
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { Command } from 'commander'
import { setAutoFreeze } from 'immer'
import { rclone_api_post } from '../src/utils/rclone/request'
import { setRuntime, getRuntime } from '../src/runtime/port'
import { nodeRuntime } from '../src/runtime/node'
import { configService } from '../src/services/ConfigService'
import { reupStorage } from '../src/services/storage/StorageManager'
import { useStorageStore } from '../src/stores/storageStore'
import { createStorage } from '../src/controller/storage/create'
import { updateStorageInfoList, searchStorageInfo, storageInfoList } from '../src/controller/storage/allList'
import {
  getFileList,
  mkDir,
  delFile,
  delDir,
} from '../src/services/storage/FileManager'
import {
  convertStoragePath,
  delStorage,
  getStorageParams,
  searchStorage,
} from '../src/services/storage/StorageManager'
import { reupRcloneVersion } from '../src/controller/versionCheck'
import { reupStats } from '../src/controller/stats/stats'
import { rcloneInfo } from '../src/services/rclone'
import {
  addMountStorage,
  mountStorage,
  unmountStorage,
} from '../src/controller/storage/mount/mount'
import type {
  VfsOptions,
  MountOptions,
} from '../src/type/rclone/storage/mount/parameters'
import {
  ensureDaemon,
  connectStore,
  daemonStatus,
  stopDaemon,
  DaemonError,
  nmPaths,
  type DaemonState,
} from './daemon'
import {
  ensureOpenlist,
  stopOpenlistDaemon,
  openlistStatus,
} from './openlist'
import {
  EXIT,
  resolveMode,
  fail,
  ok,
  info,
  fmtBytes,
  printJson,
  printTable,
} from './output'

// Shared store mutators (e.g. startOpenlist) assign directly into zustand/immer
// state. immer auto-freezes produced state in dev (running .ts directly), which
// turns those legitimate assignments into "Attempted to assign to readonly
// property" throws on the openlist restart path. Production GUI builds ship with
// auto-freeze off; match that so the CLI behaves identically.
setAutoFreeze(false)

// Install the node runtime before any shared controller/services run.
setRuntime(nodeRuntime)

type CmdOpts = { json?: boolean; format?: string }

function addOutputOpts(cmd: Command): Command {
  return cmd
    .option('--json', 'output stable JSON to stdout')
    .option('--format <mode>', 'output mode: human | json | plain', 'human')
}

// Bring the daemon up, wire it into the shared store, and fill the bits of
// rcloneInfo that controller/services assume the GUI populated at startup.
async function prep(
  need: { version?: boolean; catalog?: boolean; storages?: boolean; openlist?: boolean } = {}
): Promise<DaemonState> {
  let state: DaemonState
  try {
    state = await ensureDaemon()
  } catch (e) {
    if (e instanceof DaemonError) fail(EXIT.DAEMON, e.message, e.hint)
    fail(EXIT.DAEMON, `Failed to start rclone daemon: ${(e as Error).message}`)
  }
  connectStore(state)
  // openlist storages live in a separate sidecar. When openlist is explicitly
  // needed (creating/listing openlist-backed disks), bring it up + register the
  // rclone bridge remote. Otherwise, if openlist already happens to be running,
  // hydrate the store so reupStorage()/catalog include its drivers + storages —
  // but never auto-START it for plain rclone commands.
  if (need.openlist) {
    try {
      await ensureOpenlist()
    } catch (e) {
      fail(EXIT.DAEMON, `Failed to start openlist: ${(e as Error).message}`, 'Set NETMOUNT_OPENLIST_BIN to the openlist binary path.')
    }
  } else {
    const ol = await openlistStatus()
    if (ol.running) await ensureOpenlist()
  }
  if (need.version) await reupRcloneVersion()
  if (need.catalog) await updateStorageInfoList()
  // storageList must be populated for convertStoragePath() to resolve a name
  // to its "name:" rclone remote; without it mount falls back to a local path.
  if (need.storages) await reupStorage()
  return state
}

// Read a secret from --pass, --password-stdin, or an env var — never echoed.
function resolveSecret(opts: { pass?: string; passwordStdin?: boolean; passwordEnv?: string }): string | undefined {
  if (opts.passwordStdin) return readFileSync(0, 'utf8').trim()
  if (opts.passwordEnv) return process.env[opts.passwordEnv]
  return opts.pass
}

// Mask secret-looking config values so `storage info`/`config show` never print
// credentials to stdout/logs. Recurses so nested config (framework.rclone.password,
// settings.proxy.password) is masked too. rclone stores passwords obscured, but
// tokens/keys are not, and the app config keeps proxy creds in cleartext in memory.
const SECRET_KEY = /pass|secret|token|key|credential/i
function redactParams(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactParams)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && v ? '***' : redactParams(v)
    }
    return out
  }
  return value
}

// Split an rclone-style "storage:path" arg into its parts. Path defaults to ''.
// Only the first ':' separates storage from path, so paths may not contain it
// at the front but that matches rclone remote syntax.
function parseRemote(arg: string): { storage: string; path: string } {
  const i = arg.indexOf(':')
  if (i < 0) return { storage: arg, path: '' }
  return { storage: arg.slice(0, i), path: arg.slice(i + 1) }
}

// Resolve a storage+path to rclone RC {fs, remote}, framework-agnostic, the same
// way FileManager does. Pass the FULL path (dir + filename) as one string so
// convertStoragePath formats it correctly — do NOT concat a filename onto its
// result (that loses the separator: convertStoragePath strips trailing slashes
// and its _isDir param is a no-op upstream).
function rcPath(storage: string, path: string): { fs: string; remote: string } {
  return {
    fs: convertStoragePath(storage, undefined, undefined, undefined, true),
    remote: convertStoragePath(storage, path, false, true),
  }
}

// Full rclone fs string ("storage:dir/sub") for /sync/* directory ops.
function rcFs(storage: string, path: string): string {
  return convertStoragePath(storage, path)
}

// Join a destination directory and a leaf name with exactly one separator.
function joinRemote(dir: string, leaf: string): string {
  return dir ? `${dir.replace(/\/+$/, '')}/${leaf}` : leaf
}

const program = new Command()
program
  .name('netmount')
  .description('NetMount CLI — unified management of cloud storage over rclone + openlist')
  .version('1.2.4')

// Load persisted config before any command runs. Without this, commands that
// don't explicitly load it (storage/file/mount/daemon) fall back to roConfig's
// per-process randomString() defaults — most damagingly framework.openlist.password,
// which is generated fresh each process. That desyncs the openlist admin password
// (set by `storage add`) from the rclone webdav bridge password (rebuilt by a later
// `file ls`/mount process), producing 401 Unauthorized on every openlist data-plane
// op. Loading here makes the decoded persisted password stable across processes.
program.hook('preAction', async () => {
  await configService.loadConfig()
})

// ---- storage ----
const storage = program.command('storage').description('manage cloud storages')

addOutputOpts(storage.command('list').alias('ls').description('list configured storages')).action(
  async (opts: CmdOpts) => {
    const mode = resolveMode(opts)
    await prep()
    try {
      await reupStorage()
    } catch (e) {
      fail(EXIT.NETWORK, `Failed to list storages: ${(e as Error).message}`)
    }
    const list = useStorageStore.getState().storageList
    if (mode === 'json') {
      printJson(list)
      return
    }
    if (mode === 'plain') {
      for (const s of list) process.stdout.write(`${s.name}\t${s.type}\t${s.framework}\n`)
      return
    }
    printTable(
      list.map(s => ({
        NAME: s.name,
        FRAMEWORK: s.framework,
        TYPE: s.type,
        USED: fmtBytes(s.space?.used),
        TOTAL: fmtBytes(s.space?.total),
      })),
      'No storage configured yet. Add one with: netmount storage add <type> <name> ...'
    )
  }
)

// Collect a repeatable --option key=value into an array (commander reducer).
const collect = (v: string, acc: string[]): string[] => {
  acc.push(v)
  return acc
}

// Read an OAuth token JSON from --token, --token-stdin, or an env var. The token
// is what `rclone authorize <type>` prints on a machine that HAS a browser; you
// paste it here so a headless box can use the backend without an interactive flow.
function resolveToken(opts: { token?: string; tokenStdin?: boolean; tokenEnv?: string }): string | undefined {
  if (opts.tokenStdin) return readFileSync(0, 'utf8').trim()
  if (opts.tokenEnv) return process.env[opts.tokenEnv]
  return opts.token
}

// Read an openlist netdisk refresh_token from --refresh-token, --refresh-token-stdin,
// or an env var. Same stdin/env discipline as the OAuth token and password channels
// so the credential stays out of shell history. Used by drivers whose auth is a
// refresh_token (Baidu/Aliyundrive/Yandex/...).
function resolveRefreshToken(opts: { refreshToken?: string; refreshTokenStdin?: boolean; refreshTokenEnv?: string }): string | undefined {
  if (opts.refreshTokenStdin) return readFileSync(0, 'utf8').trim()
  if (opts.refreshTokenEnv) return process.env[opts.refreshTokenEnv]
  return opts.refreshToken
}

// Map CLI flags to the rclone config keys each backend expects. The shared
// secret channel (--pass/--password-stdin/--password-env) lands on the right
// key per type: webdav/smb -> `pass` (IsPassword, rclone obscures it), s3 ->
// `secret_access_key` (not IsPassword, stored plaintext, obscure leaves it).
// `--option key=value` is a generic passthrough so ALL 70+ rclone backends are
// configurable without a per-backend flag; OAuth backends take a pre-fetched
// token JSON + optional custom client app.
function buildStorageParams(
  type: string,
  opts: {
    url?: string; vendor?: string; user?: string
    provider?: string; accessKey?: string; endpoint?: string; region?: string
    host?: string; domain?: string; port?: string
    clientId?: string; clientSecret?: string; option?: string[]
  },
  secret?: string,
  token?: string
): Record<string, string> {
  const p: Record<string, string> = {}
  const set = (k: string, v?: string) => { if (v) p[k] = v }
  switch (type) {
    case 's3':
      set('provider', opts.provider ?? 'Other')
      set('access_key_id', opts.accessKey)
      if (secret) p.secret_access_key = secret
      set('endpoint', opts.endpoint ?? opts.url)
      set('region', opts.region)
      break
    case 'smb':
      set('host', opts.host ?? opts.url)
      set('user', opts.user)
      if (secret) p.pass = secret
      set('domain', opts.domain)
      set('port', opts.port)
      break
    default: // webdav and other url-shaped backends
      set('url', opts.url)
      set('vendor', opts.vendor)
      set('user', opts.user)
      if (secret) p.pass = secret
  }
  // OAuth backends (drive/onedrive/box/dropbox/pcloud/yandex/...) — pre-fetched
  // token + optional custom client app.
  set('client_id', opts.clientId)
  set('client_secret', opts.clientSecret)
  if (token) p.token = token
  // Generic passthrough last, so an explicit --option overrides anything above.
  for (const kv of opts.option ?? []) {
    const i = kv.indexOf('=')
    if (i > 0) p[kv.slice(0, i)] = kv.slice(i + 1)
  }
  return p
}

// Build the openlist storage param shape. openlist wants common fields flat
// (mount_path etc.) plus a nested `addition` object that createStorage()
// serializes to a JSON string and pairs with driver=<type>. The generic
// --option escape hatch routes any key beginning "addition." into that nested
// object (so e.g. --option addition.root_folder_path=/x is reachable for any
// driver); everything else lands flat as a common field. --cookie is the
// convenience flag for the netdisks (Quark/115/UC/...) whose auth is a cookie.
function buildOpenlistParams(
  name: string,
  opts: {
    mountPath?: string; cookie?: string; user?: string
    accessToken?: string; clientId?: string; clientSecret?: string; option?: string[]
  },
  secret?: string,
  refreshToken?: string,
  info?: { defaultParams?: { parameters?: { name?: string; default?: unknown }[] } }
): Record<string, unknown> {
  const common: Record<string, unknown> = {}
  const addition: Record<string, unknown> = {}
  common.mount_path = opts.mountPath ?? `/${name}`
  // Seed the driver's required addition.* defaults that the catalog already
  // computed (e.g. Quark's root_folder_id='0'). openlist rejects fs/list with
  // "query fail [61004]" when such a default is left empty. User-supplied flags
  // and --option below override these seeds.
  for (const p of info?.defaultParams?.parameters ?? []) {
    if (!p.name || !p.name.startsWith('addition.')) continue
    if (p.default === '' || p.default == null) continue
    addition[p.name.slice('addition.'.length)] = p.default
  }
  // First-class credential flags route into the nested `addition` object, covering
  // the openlist driver auth families: cookie (Quark/UC/115), username+password
  // (Thunder/PikPak/123Pan/...), refresh_token (Baidu/Aliyundrive/Yandex/...),
  // access_token (115 Open), and the optional OAuth client app. The long tail of
  // driver-specific addition keys still goes through --option addition.<k>=<v>.
  if (opts.cookie) addition.cookie = opts.cookie
  if (opts.user) addition.username = opts.user
  if (secret) addition.password = secret
  if (refreshToken) addition.refresh_token = refreshToken
  if (opts.accessToken) addition.access_token = opts.accessToken
  if (opts.clientId) addition.client_id = opts.clientId
  if (opts.clientSecret) addition.client_secret = opts.clientSecret
  for (const kv of opts.option ?? []) {
    const i = kv.indexOf('=')
    if (i <= 0) continue
    const key = kv.slice(0, i)
    const val = kv.slice(i + 1)
    if (key.startsWith('addition.')) addition[key.slice('addition.'.length)] = val
    else common[key] = val
  }
  return { ...common, addition }
}

addOutputOpts(
  storage
    .command('add <type> <name>')
    .description('add a cloud storage — type is any rclone backend (run: storage providers)')
    .option('--url <url>', 'webdav endpoint URL (also accepted as s3 endpoint / smb host)')
    .option('--vendor <vendor>', 'webdav vendor (other|nextcloud|owncloud|...)', 'other')
    .option('--user <user>', 'username (webdav/smb; openlist username+password drivers -> addition.username)')
    .option('--provider <provider>', 's3 provider (AWS|Minio|Aliyun|Cloudflare|Other)')
    .option('--access-key <id>', 's3 access key id')
    .option('--endpoint <url>', 's3 endpoint (S3-compatible / non-AWS)')
    .option('--region <region>', 's3 region')
    .option('--host <host>', 'smb host')
    .option('--domain <domain>', 'smb domain')
    .option('--port <port>', 'smb/s3 port')
    .option('--pass <secret>', 'password / s3 secret-access-key / openlist driver password (prefer --password-stdin)')
    .option('--password-stdin', 'read the secret from stdin')
    .option('--password-env <var>', 'read the secret from the named env var')
    .option('--token <json>', 'OAuth token JSON from `rclone authorize <type>` (prefer --token-stdin)')
    .option('--token-stdin', 'read the OAuth token JSON from stdin')
    .option('--token-env <var>', 'read the OAuth token JSON from the named env var')
    .option('--client-id <id>', 'OAuth custom client id (optional)')
    .option('--client-secret <secret>', 'OAuth custom client secret (optional)')
    .option('--option <key=value>', 'set any raw backend param (repeatable) — escape hatch; for openlist drivers, addition.<k>=<v> targets the nested addition object', collect, [])
    .option('--cookie <cookie>', 'openlist netdisk auth cookie (Quark/115/UC/...); maps to addition.cookie')
    .option('--refresh-token <token>', 'openlist netdisk refresh_token (Baidu/Aliyundrive/Yandex/...); prefer --refresh-token-stdin')
    .option('--refresh-token-stdin', 'read the refresh_token from stdin')
    .option('--refresh-token-env <var>', 'read the refresh_token from the named env var')
    .option('--access-token <token>', 'openlist netdisk access_token (e.g. 115 Open); maps to addition.access_token')
    .option('--mount-path <path>', 'openlist mount path (default /<name>)')
).action(
  async (
    type: string,
    name: string,
    opts: CmdOpts & {
      url?: string; vendor?: string; user?: string
      provider?: string; accessKey?: string; endpoint?: string; region?: string
      host?: string; domain?: string; port?: string
      pass?: string; passwordStdin?: boolean; passwordEnv?: string
      token?: string; tokenStdin?: boolean; tokenEnv?: string
      refreshToken?: string; refreshTokenStdin?: boolean; refreshTokenEnv?: string
      accessToken?: string
      clientId?: string; clientSecret?: string; option?: string[]
      cookie?: string; mountPath?: string
    }
  ) => {
    const mode = resolveMode(opts)
    // First populate the catalog with whatever is already up (rclone always;
    // openlist only if already running) so we can read the type's framework.
    await prep({ catalog: true })
    let info = searchStorageInfo(type)
    // If the type isn't a known rclone backend, it may be an openlist driver
    // that needs openlist running before it appears in the catalog. Bring
    // openlist up and re-resolve. (searchStorageInfo falls back to [0] on miss,
    // so compare the resolved type to the requested one to detect a real hit.)
    if (!info || info.type !== type) {
      await prep({ openlist: true, catalog: true })
      info = searchStorageInfo(type)
    }
    const framework = info && info.type === type ? info.framework : 'rclone'

    if (framework === 'openlist') {
      // openlist netdisks share the secret channel (--pass/-stdin/-env) for
      // username+password drivers, plus a dedicated refresh_token channel.
      const secret = resolveSecret(opts)
      const refreshToken = resolveRefreshToken(opts)
      const parameters = buildOpenlistParams(name, opts, secret, refreshToken, info)
      const created = await createStorage(name, type, parameters, {}, {})
      if (!created) {
        fail(EXIT.CONFIG, `Failed to add openlist storage "${name}" (driver ${type})`, 'Check the driver name (run: netmount storage providers) and required addition.* params.')
      }
      if (mode === 'json') printJson({ added: name, type, framework })
      else ok(`storage "${name}" added (${type}, openlist)`)
      return
    }

    const secret = resolveSecret(opts)
    const token = resolveToken(opts)
    const parameters = buildStorageParams(type, opts, secret, token)

    const created = await createStorage(name, type, parameters, {}, { obscure: true })
    if (!created) {
      fail(EXIT.CONFIG, `Failed to add storage "${name}" (type ${type})`, 'Check the credentials and that the type is a valid rclone backend (run: netmount storage providers).')
    }
    if (mode === 'json') printJson({ added: name, type })
    else ok(`storage "${name}" added (${type})`)
  }
)

// `storage providers` — discovery: list every rclone backend type, or show one
// type's config fields (name/required/secret) so you know what a given cloud disk
// needs without trial-and-error. Reads rclone RC /config/providers (static).
type ProviderOption = { Name: string; Help?: string; Required?: boolean; IsPassword?: boolean; Advanced?: boolean }
type Provider = { Name: string; Description?: string; Options?: ProviderOption[] }
addOutputOpts(
  storage
    .command('providers [type]')
    .alias('types')
    .description("list backend types, or show one type's config options")
    .option('--openlist', 'also bring openlist up and include its drivers (Quark/115/aliyundrive/...)')
).action(async (type: string | undefined, opts: CmdOpts & { openlist?: boolean }) => {
  const mode = resolveMode(opts)
  // --openlist brings openlist up so its drivers appear in the catalog. Either
  // way prep auto-hydrates openlist if it is already running.
  await prep(opts.openlist ? { openlist: true, catalog: true } : {})
  const res = (await rclone_api_post('/config/providers')) as { providers?: Provider[] } | undefined
  const provs = res?.providers ?? []
  // openlist drivers (capitalized types) come from the storage-info catalog, not
  // rclone's /config/providers. Include them when the catalog has been built.
  const openlistTypes = storageInfoList
    .filter(s => s.framework === 'openlist')
    .map(s => ({ Name: s.type, Description: 'openlist driver', framework: 'openlist' as const }))
  if (!type) {
    const all = [
      ...provs.map(p => ({ ...p, framework: 'rclone' as const })),
      ...openlistTypes,
    ]
    if (mode === 'json') {
      printJson(all.map(p => ({ type: p.Name, framework: p.framework, description: p.Description })))
      return
    }
    printTable(
      all.map(p => ({ TYPE: p.Name, FRAMEWORK: p.framework, DESCRIPTION: (p.Description ?? '').slice(0, 50) })),
      'No providers reported.'
    )
    return
  }
  const prov = provs.find(p => p.Name === type)
  if (!prov) return fail(EXIT.USAGE, `unknown backend type "${type}"`, 'Run: netmount storage providers (to list all types)')
  if (mode === 'json') {
    printJson(prov.Options ?? [])
    return
  }
  printTable(
    (prov.Options ?? [])
      .filter(o => !o.Advanced)
      .map(o => ({
        OPTION: o.Name,
        REQUIRED: o.Required ? 'yes' : '',
        SECRET: o.IsPassword ? 'yes' : '',
        HELP: ((o.Help ?? '').split('\n')[0] ?? '').slice(0, 56),
      })),
    `${type} reports no basic options.`
  )
})

addOutputOpts(
  storage.command('info <name>').description('show one storage: type, space, config (secrets masked)')
).action(async (name: string, opts: CmdOpts) => {
  const mode = resolveMode(opts)
  await prep({ storages: true })
  const s = searchStorage(name)
  if (!s) fail(EXIT.CONFIG, `No storage named "${name}"`, 'List configured storages with: netmount storage list')
  let params: Record<string, unknown> = {}
  try {
    params = (await getStorageParams(name)) as Record<string, unknown>
  } catch {
    // params are best-effort; the summary below still works without them
  }
  const safe = redactParams(params) as Record<string, unknown>
  if (mode === 'json') {
    printJson({
      name: s.name,
      type: s.type,
      framework: s.framework,
      space: s.space,
      parameters: safe,
    })
    return
  }
  info(`name:      ${s.name}`)
  info(`framework: ${s.framework}`)
  info(`type:      ${s.type}`)
  info(`used:      ${fmtBytes(s.space?.used)}`)
  info(`total:     ${fmtBytes(s.space?.total)}`)
  info(`free:      ${fmtBytes(s.space?.free)}`)
  for (const [k, v] of Object.entries(safe)) info(`  ${k}: ${String(v)}`)
})

addOutputOpts(
  storage.command('del <name>').alias('rm').description('delete a storage (also unmounts and clears its cache)')
).action(async (name: string, opts: CmdOpts) => {
  const mode = resolveMode(opts)
  await prep({ storages: true })
  if (!searchStorage(name)) {
    fail(EXIT.CONFIG, `No storage named "${name}"`, 'List configured storages with: netmount storage list')
  }
  await delStorage(name)
  if (mode === 'json') printJson({ deleted: name })
  else ok(`storage "${name}" deleted`)
})

addOutputOpts(
  storage
    .command('edit <name>')
    .description('update an rclone storage’s params (merge; unspecified keys kept)')
    .option('--url <url>', 'endpoint URL')
    .option('--vendor <vendor>', 'provider vendor')
    .option('--user <user>', 'username')
    .option('--pass <pass>', 'password (prefer --password-stdin to keep it out of shell history)')
    .option('--password-stdin', 'read password from stdin')
    .option('--password-env <var>', 'read password from the named env var')
).action(
  async (
    name: string,
    opts: CmdOpts & {
      url?: string
      vendor?: string
      user?: string
      pass?: string
      passwordStdin?: boolean
      passwordEnv?: string
    }
  ) => {
    const mode = resolveMode(opts)
    await prep({ storages: true })
    const s = searchStorage(name)
    if (!s) fail(EXIT.CONFIG, `No storage named "${name}"`, 'List configured storages with: netmount storage list')
    if (s.framework !== 'rclone') {
      fail(EXIT.USAGE, `edit only supports rclone storages (${name} is ${s.framework})`, 'Re-create it with: netmount storage del + storage add')
    }
    const pass = resolveSecret(opts)
    const parameters: Record<string, string> = {}
    if (opts.url) parameters.url = opts.url
    if (opts.vendor) parameters.vendor = opts.vendor
    if (opts.user) parameters.user = opts.user
    if (pass) parameters.pass = pass
    if (Object.keys(parameters).length === 0) {
      fail(EXIT.USAGE, 'nothing to edit', 'Pass at least one of --url/--vendor/--user/--pass')
    }
    // /config/update merges params into the existing remote (vs /config/create
    // which replaces it). obscure hashes any password we send.
    const res = await rclone_api_post('/config/update', {
      name,
      parameters,
      opt: { obscure: true },
    })
    if (res === undefined) {
      fail(EXIT.CONFIG, `Failed to update storage "${name}"`)
    }
    await reupStorage()
    if (mode === 'json') printJson({ updated: name, keys: Object.keys(parameters) })
    else ok(`storage "${name}" updated (${Object.keys(parameters).join(', ')})`)
  }
)

// ---- mount / umount ----
addOutputOpts(
  program
    .command('mount <storage> <mountpoint>')
    .description('mount a storage at a drive letter (Windows) or directory')
    .option('--cache-mode <mode>', 'VFS cache mode: off | minimal | writes | full', 'writes')
).action(async (storageName: string, mountpoint: string, opts: CmdOpts & { cacheMode?: string }) => {
  const mode = resolveMode(opts)
  await prep({ version: true, storages: true })
  // Default to 'writes' (matching the GUI) so writes to remotes like webdav/s3
  // that need a known content-length don't fail under the off cache mode.
  const parameters = {
    vfsOpt: { CacheMode: opts.cacheMode ?? 'writes' } as VfsOptions,
    mountOpt: {} as MountOptions,
  }
  await addMountStorage(storageName, mountpoint, parameters, false)
  const mounted = await mountStorage({
    storageName,
    mountPath: mountpoint,
    parameters,
    autoMount: false,
  })
  if (!mounted) {
    fail(EXIT.MOUNT, `Failed to mount "${storageName}" at ${mountpoint}`, 'Ensure WinFsp (Windows) / FUSE is installed and the mountpoint is free.')
  }
  if (mode === 'json') printJson({ mounted: storageName, mountpoint })
  else ok(`mounted "${storageName}" at ${mountpoint}`)
})

addOutputOpts(
  program.command('umount <mountpoint>').alias('unmount').description('unmount a storage')
).action(async (mountpoint: string, opts: CmdOpts) => {
  const mode = resolveMode(opts)
  await prep()
  const unmounted = await unmountStorage(mountpoint)
  if (!unmounted) {
    fail(EXIT.MOUNT, `Failed to unmount ${mountpoint}`)
  }
  if (mode === 'json') printJson({ unmounted: mountpoint })
  else ok(`unmounted ${mountpoint}`)
})

// ---- file ----
// All file ops need storageList populated so convertStoragePath() resolves the
// "storage:" rclone remote — same dependency as mount. prep({storages:true}).
const file = program.command('file').description('browse and move files on a storage')

addOutputOpts(
  file
    .command('ls <remote>')
    .alias('list')
    .description('list a directory — remote is "storage:path" (path optional)')
    .option('--refresh', 'force-refresh the VFS cache before listing')
).action(async (remote: string, opts: CmdOpts & { refresh?: boolean }) => {
  const mode = resolveMode(opts)
  const { storage, path } = parseRemote(remote)
  await prep({ storages: true })
  const list = await getFileList(storage, path || '/', opts.refresh)
  if (!list) {
    fail(EXIT.NETWORK, `Failed to list ${storage}:${path}`, 'Check the storage name and that the path exists.')
  }
  if (mode === 'json') {
    printJson(list)
    return
  }
  if (mode === 'plain') {
    for (const f of list) process.stdout.write(`${f.name}${f.isDir ? '/' : ''}\n`)
    return
  }
  printTable(
    list.map(f => ({
      NAME: f.isDir ? `${f.name}/` : f.name,
      SIZE: f.isDir ? '-' : fmtBytes(f.size),
      MODTIME: f.modTime instanceof Date ? f.modTime.toISOString() : String(f.modTime),
    })),
    `${storage}:${path} is empty.`
  )
})

addOutputOpts(
  file.command('mkdir <remote>').description('create a directory — remote is "storage:path"')
).action(async (remote: string, opts: CmdOpts) => {
  const mode = resolveMode(opts)
  const { storage, path } = parseRemote(remote)
  await prep({ storages: true })
  await mkDir(storage, path)
  if (mode === 'json') printJson({ created: `${storage}:${path}` })
  else ok(`created ${storage}:${path}`)
})

addOutputOpts(
  file
    .command('rm <remote>')
    .description('delete a file (or a directory with -r) — remote is "storage:path"')
    .option('-r, --recursive', 'delete a directory and its contents')
).action(async (remote: string, opts: CmdOpts & { recursive?: boolean }) => {
  const mode = resolveMode(opts)
  const { storage, path } = parseRemote(remote)
  await prep({ storages: true })
  if (opts.recursive) await delDir(storage, path)
  else await delFile(storage, path)
  if (mode === 'json') printJson({ deleted: `${storage}:${path}` })
  else ok(`deleted ${storage}:${path}`)
})

addOutputOpts(
  file
    .command('cp <src> <dst>')
    .description('copy between storages — src/dst are "storage:path"; dst is a directory')
    .option('-r, --recursive', 'copy a directory (async sync job)')
).action(async (src: string, dst: string, opts: CmdOpts & { recursive?: boolean }) => {
  const mode = resolveMode(opts)
  const s = parseRemote(src)
  const d = parseRemote(dst)
  await prep({ storages: true })
  const leaf = basename(s.path)
  if (opts.recursive) {
    await rclone_api_post('/sync/copy', {
      srcFs: rcFs(s.storage, s.path),
      dstFs: rcFs(d.storage, joinRemote(d.path, leaf)),
    })
  } else {
    const sp = rcPath(s.storage, s.path)
    const dp = rcPath(d.storage, joinRemote(d.path, leaf))
    await rclone_api_post('/operations/copyfile', {
      srcFs: sp.fs,
      srcRemote: sp.remote,
      dstFs: dp.fs,
      dstRemote: dp.remote,
    })
  }
  if (mode === 'json') printJson({ copied: src, to: dst })
  else ok(`copied ${src} -> ${dst}`)
})

addOutputOpts(
  file
    .command('mv <src> <dst>')
    .description('move between storages — src/dst are "storage:path"; dst is a directory')
    .option('-r, --recursive', 'move a directory (async sync job)')
).action(async (src: string, dst: string, opts: CmdOpts & { recursive?: boolean }) => {
  const mode = resolveMode(opts)
  const s = parseRemote(src)
  const d = parseRemote(dst)
  await prep({ storages: true })
  const leaf = basename(s.path)
  if (opts.recursive) {
    await rclone_api_post('/sync/move', {
      srcFs: rcFs(s.storage, s.path),
      dstFs: rcFs(d.storage, joinRemote(d.path, leaf)),
    })
  } else {
    const sp = rcPath(s.storage, s.path)
    const dp = rcPath(d.storage, joinRemote(d.path, leaf))
    await rclone_api_post('/operations/movefile', {
      srcFs: sp.fs,
      srcRemote: sp.remote,
      dstFs: dp.fs,
      dstRemote: dp.remote,
    })
  }
  if (mode === 'json') printJson({ moved: src, to: dst })
  else ok(`moved ${src} -> ${dst}`)
})

// rclone takes a local directory as an fs; on Windows it wants forward slashes
// and treats a single drive-letter (C:) as a drive, not a remote.
function localFs(absPath: string): string {
  return absPath.replace(/\\/g, '/')
}

// upload/download have no remote↔remote helper to reuse (TransferService is
// remote-to-remote), so they hit RC /operations/copyfile directly with the
// local side as the fs. Single-file; directory transfer is `file cp -r`.
addOutputOpts(
  program
    .command('upload <localfile> <remote>')
    .description('upload a local file to "storage:dir" (remote dir, name kept)')
).action(async (localfile: string, remote: string, opts: CmdOpts) => {
  const mode = resolveMode(opts)
  const abs = resolve(localfile)
  if (!existsSync(abs)) fail(EXIT.USAGE, `Local file not found: ${abs}`)
  const { storage, path } = parseRemote(remote)
  await prep({ storages: true })
  const name = basename(abs)
  const dstDir = path ? path.replace(/\/?$/, '/') : ''
  await rclone_api_post('/operations/copyfile', {
    srcFs: localFs(dirname(abs)),
    srcRemote: name,
    dstFs: `${storage}:`,
    dstRemote: dstDir + name,
  })
  if (mode === 'json') printJson({ uploaded: abs, to: `${storage}:${dstDir}${name}` })
  else ok(`uploaded ${name} -> ${storage}:${dstDir}${name}`)
})

addOutputOpts(
  program
    .command('download <remote> <localdir>')
    .description('download "storage:path/file" into a local directory')
).action(async (remote: string, localdir: string, opts: CmdOpts) => {
  const mode = resolveMode(opts)
  const { storage, path } = parseRemote(remote)
  if (!path) fail(EXIT.USAGE, 'remote must point at a file, e.g. storage:dir/file.txt')
  const absDir = resolve(localdir)
  if (!existsSync(absDir)) mkdirSync(absDir, { recursive: true })
  await prep({ storages: true })
  const name = basename(path)
  await rclone_api_post('/operations/copyfile', {
    srcFs: `${storage}:`,
    srcRemote: path,
    dstFs: localFs(absDir),
    dstRemote: name,
  })
  if (mode === 'json') printJson({ downloaded: `${storage}:${path}`, to: localFs(resolve(absDir, name)) })
  else ok(`downloaded ${storage}:${path} -> ${resolve(absDir, name)}`)
})

// ---- sync (the bandwidth-arbitrage transit action) -----------------------
// Directory-level push/pull between local and ANY storage. One side is usually
// local (push to / pull from a fast cloud disk to dodge slow direct links), so
// each side is resolved as a configured-storage remote ("name:path") or a local
// path — Windows drive letters (D:\...) fall through to local because "D" is not
// a configured storage. Human mode runs async with a live progress line on
// stderr so multi-GB transfers are visible; --json blocks and prints a summary.
// rclone sync is idempotent: a re-run resumes (already-transferred files skip).
function resolveSide(arg: string): string {
  const { storage, path } = parseRemote(arg)
  if (searchStorage(storage)) return rcFs(storage, path)
  return localFs(resolve(arg))
}

const napSync = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

addOutputOpts(
  program
    .command('sync <src> <dst>')
    .description('sync a directory between local and any storage (push/pull via the cloud); additive copy by default')
    .option('--move', 'move instead of copy (remove source after a verified transfer)')
    .option('--mirror', 'make dst identical to src, DELETING dst files not in src')
    .option('--checksum', 'compare by hash instead of size+modtime')
).action(
  async (
    src: string,
    dst: string,
    opts: CmdOpts & { move?: boolean; mirror?: boolean; checksum?: boolean }
  ) => {
    const mode = resolveMode(opts)
    if (opts.move && opts.mirror) fail(EXIT.USAGE, '--move and --mirror are mutually exclusive')
    await prep({ storages: true })
    const srcFs = resolveSide(src)
    const dstFs = resolveSide(dst)
    const endpoint = opts.move ? '/sync/move' : opts.mirror ? '/sync/sync' : '/sync/copy'
    const body: Record<string, unknown> = { srcFs, dstFs }
    if (opts.checksum) body._config = { CheckSum: true }

    if (mode === 'json') {
      await rclone_api_post(endpoint, body) // blocks until the transfer finishes
      printJson({ synced: src, to: dst, op: endpoint.slice('/sync/'.length) })
      return
    }

    // human: kick off async, then poll job + global stats for a live progress line
    const started = (await rclone_api_post(endpoint, { ...body, _async: true })) as { jobid?: number }
    const jobid = started?.jobid
    if (jobid == null) {
      ok(`synced ${src} -> ${dst}`)
      return
    }
    let done = false
    let final: { success?: boolean; error?: string; duration?: number } = {}
    while (!done) {
      await napSync(700)
      const st = (await rclone_api_post('/core/stats', {})) as {
        bytes?: number
        totalBytes?: number
        speed?: number
      }
      const tx = st?.bytes ?? 0
      const total = st?.totalBytes ?? 0
      const pct = total > 0 ? Math.floor((tx / total) * 100) : 0
      process.stderr.write(`\r  ${fmtBytes(tx)} / ${fmtBytes(total)} (${pct}%) at ${fmtBytes(st?.speed ?? 0)}/s   `)
      const js = (await rclone_api_post('/job/status', { jobid })) as {
        finished?: boolean
        success?: boolean
        error?: string
        duration?: number
      }
      if (js?.finished) {
        done = true
        final = js
      }
    }
    process.stderr.write('\n')
    if (final.success === false || final.error) {
      fail(EXIT.NETWORK, `sync failed: ${final.error || 'unknown error'}`, 'Re-run to resume — already-transferred files are skipped.')
    }
    ok(`synced ${src} -> ${dst}${final.duration != null ? ` in ${final.duration.toFixed(1)}s` : ''}`)
  }
)

// ---- mounts ----
const mounts = program.command('mounts').description('inspect active mounts')

// RC /mount/listmounts returns PascalCase item keys (Fs/MountPoint/MountedOn).
// The shared MountService type guard expects camelCase and so always drops real
// mounts — the GUI sidesteps it via its locally-tracked mount config. Rather than
// patch upstream, read RC directly here, same as the cp/mv path-join workaround.
type RcMountPoint = { Fs: string; MountPoint: string; MountedOn: string }
addOutputOpts(
  mounts.command('list').alias('ls').description('list active mount points')
).action(async (opts: CmdOpts) => {
  const mode = resolveMode(opts)
  await prep()
  const res = (await rclone_api_post('/mount/listmounts')) as { mountPoints?: RcMountPoint[] } | undefined
  const list = res?.mountPoints ?? []
  if (mode === 'json') {
    printJson(
      list.map(m => ({ storage: m.Fs, mountPoint: m.MountPoint, mountedOn: m.MountedOn }))
    )
    return
  }
  if (mode === 'plain') {
    for (const m of list) process.stdout.write(`${m.Fs}\t${m.MountPoint}\n`)
    return
  }
  printTable(
    list.map(m => ({ STORAGE: m.Fs, MOUNTPOINT: m.MountPoint, MOUNTED: m.MountedOn })),
    'No active mounts. Mount one with: netmount mount <storage> <mountpoint>'
  )
})

// ---- daemon ----
const daemon = program.command('daemon').description('manage the rclone background daemon')

addOutputOpts(daemon.command('start').description('start the rclone daemon')).action(
  async (opts: CmdOpts) => {
    const mode = resolveMode(opts)
    const state = await prep()
    if (mode === 'json') printJson({ pid: state.pid, url: state.url, port: state.port })
    else ok(`daemon running (pid ${state.pid}) at ${state.url}`)
  }
)

addOutputOpts(daemon.command('status').description('show daemon status (rclone + openlist)')).action(
  async (opts: CmdOpts) => {
    const mode = resolveMode(opts)
    const { running, state } = await daemonStatus()
    const ol = await openlistStatus()
    if (mode === 'json') {
      printJson({
        running,
        pid: state?.pid,
        url: state?.url,
        openlist: { running: ol.running, url: ol.state?.url, port: ol.state?.port },
      })
    } else {
      if (running && state) ok(`rclone daemon running (pid ${state.pid}) at ${state.url}`)
      else info('rclone daemon not running')
      if (ol.running && ol.state) ok(`openlist running at ${ol.state.url}`)
      else info('openlist not running')
      if (!running) process.exit(EXIT.DAEMON)
    }
  }
)

addOutputOpts(daemon.command('stop').description('stop the daemon (rclone + openlist)')).action(
  async (opts: CmdOpts) => {
    const mode = resolveMode(opts)
    // Stop openlist first (it depends on rcd for its bridge remote), then rcd.
    const olStopped = await stopOpenlistDaemon().catch(() => false)
    const stopped = await stopDaemon()
    if (mode === 'json') printJson({ stopped, openlistStopped: olStopped })
    else {
      if (olStopped) ok('openlist stopped')
      if (stopped) ok('rclone daemon stopped')
      else info('rclone daemon was not running')
    }
  }
)

addOutputOpts(daemon.command('restart').description('stop then start the daemon (rclone + openlist if it was up)')).action(
  async (opts: CmdOpts) => {
    const mode = resolveMode(opts)
    // Remember whether openlist was up, so we can bring it back.
    const olWasUp = (await openlistStatus()).running
    await stopOpenlistDaemon().catch(() => {})
    await stopDaemon()
    const state = await prep(olWasUp ? { openlist: true } : {})
    const ol = await openlistStatus()
    if (mode === 'json') {
      printJson({ pid: state.pid, url: state.url, port: state.port, openlist: { running: ol.running, url: ol.state?.url } })
    } else {
      ok(`rclone daemon restarted (pid ${state.pid}) at ${state.url}`)
      if (ol.running && ol.state) ok(`openlist restarted at ${ol.state.url}`)
    }
  }
)

// ---- config ----
const config = program.command('config').description('inspect CLI config and run health checks')

addOutputOpts(config.command('path').description('show where the CLI keeps its state')).action(
  (opts: CmdOpts) => {
    const mode = resolveMode(opts)
    if (mode === 'json') {
      printJson(nmPaths)
      return
    }
    info(`dir:          ${nmPaths.dir}`)
    info(`app config:   ${nmPaths.appConfig}`)
    info(`daemon state: ${nmPaths.daemonState}`)
    info(`rclone conf:  ${nmPaths.rcloneConf}`)
    info(`rclone log:   ${nmPaths.rcloneLog}`)
  }
)

addOutputOpts(
  config.command('show').description('print app config (NMConfig) with secrets masked')
).action(async (opts: CmdOpts) => {
  resolveMode(opts) // config is nested; always emit JSON to stdout
  await configService.loadConfig()
  printJson(redactParams(configService.getConfig()))
})

addOutputOpts(
  config.command('doctor').description('health-check the CLI environment')
).action(async (opts: CmdOpts) => {
  const mode = resolveMode(opts)
  const checks: { check: string; status: 'PASS' | 'WARN' | 'FAIL'; detail: string }[] = []

  checks.push({
    check: 'state dir',
    status: existsSync(nmPaths.dir) ? 'PASS' : 'WARN',
    detail: existsSync(nmPaths.dir) ? nmPaths.dir : `${nmPaths.dir} (created on first use)`,
  })

  checks.push({
    check: 'app config',
    status: existsSync(nmPaths.appConfig) ? 'PASS' : 'WARN',
    detail: existsSync(nmPaths.appConfig) ? nmPaths.appConfig : 'none yet (defaults in use)',
  })

  const bin = process.env.NETMOUNT_RCLONE_BIN
  if (bin) {
    checks.push({
      check: 'rclone binary',
      status: existsSync(bin) ? 'PASS' : 'FAIL',
      detail: existsSync(bin) ? bin : `NETMOUNT_RCLONE_BIN points at a missing file: ${bin}`,
    })
  } else {
    checks.push({
      check: 'rclone binary',
      status: 'WARN',
      detail: 'NETMOUNT_RCLONE_BIN unset — relying on rclone being on PATH',
    })
  }

  const { running, state } = await daemonStatus()
  checks.push({
    check: 'daemon',
    status: running ? 'PASS' : 'WARN',
    detail: running ? `running at ${state?.url}` : 'not running (auto-starts on first command)',
  })
  // Security: the rc must never be reachable off-host. The daemon binds
  // 127.0.0.1 by construction; flag loudly if state ever shows otherwise.
  if (state?.url) {
    const local = state.url.includes('127.0.0.1') || state.url.includes('[::1]')
    checks.push({
      check: 'rc bind',
      status: local ? 'PASS' : 'FAIL',
      detail: local ? 'bound to localhost' : `EXPOSED: ${state.url}`,
    })
  }

  if (process.platform === 'win32') {
    const winfsp = await getRuntime().system.getWinFspInstallState()
    checks.push({
      check: 'WinFsp',
      status: winfsp ? 'PASS' : 'WARN',
      detail: winfsp ? 'installed' : 'not found — mounting will fail until installed',
    })
  }

  const failed = checks.some(c => c.status === 'FAIL')
  if (mode === 'json') {
    printJson(checks)
  } else {
    printTable(
      checks.map(c => ({ CHECK: c.check, STATUS: c.status, DETAIL: c.detail })),
      'no checks ran'
    )
  }
  if (failed) process.exit(EXIT.CONFIG)
})

// ---- task ----------------------------------------------------------------
// Saved scheduled transfer tasks live in NMConfig.task[]. The scheduler loop
// runs in the GUI process; the CLI does NOT run schedulers, so this group is
// read-only reporting of what the GUI has saved. Listing/inspecting only.
const task = program.command('task').description('inspect saved scheduled tasks (read-only; scheduler runs in the GUI)')

function loc(end: { storageName: string; path: string }): string {
  return `${end.storageName}:${end.path}`
}

addOutputOpts(task.command('list').alias('ls').description('list saved tasks')).action(
  async (opts: CmdOpts) => {
    const mode = resolveMode(opts)
    await configService.loadConfig()
    const tasks = configService.getConfig().task ?? []
    if (mode === 'json') {
      printJson(
        tasks.map(t => ({
          name: t.name,
          type: t.taskType,
          source: loc(t.source),
          target: loc(t.target),
          enable: t.enable,
          mode: t.run?.mode,
          lastError: t.runInfo?.error || t.runInfo?.msg || null,
        }))
      )
      return
    }
    printTable(
      tasks.map(t => ({
        NAME: t.name,
        TYPE: t.taskType,
        SOURCE: loc(t.source),
        TARGET: loc(t.target),
        ENABLE: t.enable ? 'yes' : 'no',
        MODE: t.run?.mode ?? '-',
        LASTERR: t.runInfo?.error || t.runInfo?.msg || '-',
      })),
      'no saved tasks'
    )
  }
)

addOutputOpts(task.command('status <name>').description('show one saved task in detail')).action(
  async (name: string, opts: CmdOpts) => {
    resolveMode(opts)
    await configService.loadConfig()
    const t = (configService.getConfig().task ?? []).find(x => x.name === name)
    if (!t) fail(EXIT.USAGE, `no saved task named "${name}"`, 'run `netmount task list` to see saved tasks')
    printJson({
      name: t.name,
      type: t.taskType,
      source: loc(t.source),
      target: loc(t.target),
      enable: t.enable,
      run: t.run,
      runInfo: t.runInfo,
      parameters: t.parameters ?? null,
    })
  }
)

// ---- stats ---------------------------------------------------------------
// Live transfer stats from the daemon's /core/stats, via the shared controller.
addOutputOpts(program.command('stats').description('show live rclone transfer stats')).action(
  async (opts: CmdOpts) => {
    const mode = resolveMode(opts)
    await prep()
    await reupStats()
    const s = rcloneInfo.stats
    if (mode === 'json') {
      printJson(s ?? {})
      return
    }
    if (!s) {
      info('no stats available')
      return
    }
    info(`bytes:        ${fmtBytes(s.bytes)} / ${fmtBytes(s.totalBytes)}`)
    // realSpeed = live throughput of in-flight transfers (what the GUI shows);
    // speed = rclone's session-average. Show both so the live number isn't lost.
    info(`speed:        ${fmtBytes(s.realSpeed ?? 0)}/s (live), ${fmtBytes(s.speed)}/s (avg)`)
    info(`transfers:    ${s.totalTransfers ?? 0}`)
    info(`checks:       ${s.checks ?? 0} / ${s.totalChecks ?? 0}`)
    info(`errors:       ${s.errors ?? 0}`)
    info(`elapsed:      ${(s.elapsedTime ?? 0).toFixed(1)}s`)
    const active = s.transferring ?? []
    if (active.length === 0) {
      info('transferring: (idle)')
    } else {
      printTable(
        active.map(t => ({
          NAME: t.name,
          PROGRESS: `${(t.percentage ?? 0).toFixed(0)}%`,
          SIZE: `${fmtBytes(t.bytes)} / ${fmtBytes(t.size)}`,
          SPEED: `${fmtBytes(t.speed)}/s`,
        })),
        'no active transfers'
      )
    }
  }
)

program.parseAsync(process.argv).catch((e: unknown) => {
  if (process.env.NETMOUNT_DEBUG) process.stderr.write(((e as Error)?.stack ?? String(e)) + '\n')
  fail(EXIT.GENERAL, (e as Error).message ?? String(e))
})
