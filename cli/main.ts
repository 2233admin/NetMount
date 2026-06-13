#!/usr/bin/env bun
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { Command } from 'commander'
import { rclone_api_post } from '../src/utils/rclone/request'
import { setRuntime } from '../src/runtime/port'
import { nodeRuntime } from '../src/runtime/node'
import { reupStorage } from '../src/services/storage/StorageManager'
import { useStorageStore } from '../src/stores/storageStore'
import { createStorage } from '../src/controller/storage/create'
import { updateStorageInfoList } from '../src/controller/storage/allList'
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
  type DaemonState,
} from './daemon'
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
  need: { version?: boolean; catalog?: boolean; storages?: boolean } = {}
): Promise<DaemonState> {
  let state: DaemonState
  try {
    state = await ensureDaemon()
  } catch (e) {
    if (e instanceof DaemonError) fail(EXIT.DAEMON, e.message, e.hint)
    fail(EXIT.DAEMON, `Failed to start rclone daemon: ${(e as Error).message}`)
  }
  connectStore(state)
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

// Mask secret-looking config values so `storage info` never prints credentials
// to stdout/logs. rclone stores passwords obscured, but tokens/keys are not.
const SECRET_KEY = /pass|secret|token|key|credential/i
function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    out[k] = SECRET_KEY.test(k) && v ? '***' : v
  }
  return out
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

addOutputOpts(
  storage
    .command('add <type> <name>')
    .description('add a cloud storage (e.g. webdav, s3)')
    .option('--url <url>', 'endpoint URL (webdav/s3/...)')
    .option('--vendor <vendor>', 'provider vendor (webdav: other|nextcloud|owncloud|...)', 'other')
    .option('--user <user>', 'username')
    .option('--pass <pass>', 'password (prefer --password-stdin to keep it out of shell history)')
    .option('--password-stdin', 'read password from stdin')
    .option('--password-env <var>', 'read password from the named env var')
).action(
  async (
    type: string,
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
    await prep({ catalog: true })

    const pass = resolveSecret(opts)
    const parameters: Record<string, string> = {}
    if (opts.url) parameters.url = opts.url
    if (opts.vendor) parameters.vendor = opts.vendor
    if (opts.user) parameters.user = opts.user
    if (pass) parameters.pass = pass

    const created = await createStorage(name, type, parameters, {}, { obscure: true })
    if (!created) {
      fail(EXIT.CONFIG, `Failed to add storage "${name}" (type ${type})`, 'Check the URL/credentials and that the type is supported.')
    }
    if (mode === 'json') printJson({ added: name, type })
    else ok(`storage "${name}" added (${type})`)
  }
)

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
  const safe = redactParams(params)
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

addOutputOpts(daemon.command('status').description('show daemon status')).action(
  async (opts: CmdOpts) => {
    const mode = resolveMode(opts)
    const { running, state } = await daemonStatus()
    if (mode === 'json') {
      printJson({ running, pid: state?.pid, url: state?.url })
    } else if (running && state) {
      ok(`daemon running (pid ${state.pid}) at ${state.url}`)
    } else {
      info('daemon not running')
      process.exit(EXIT.DAEMON)
    }
  }
)

addOutputOpts(daemon.command('stop').description('stop the rclone daemon')).action(
  async (opts: CmdOpts) => {
    const mode = resolveMode(opts)
    const stopped = await stopDaemon()
    if (mode === 'json') printJson({ stopped })
    else if (stopped) ok('daemon stopped')
    else info('daemon was not running')
  }
)

program.parseAsync(process.argv).catch((e: unknown) => {
  fail(EXIT.GENERAL, (e as Error).message ?? String(e))
})
