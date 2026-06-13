// Self-contained e2e for the NetMount CLI. Spawns real `bun cli/main.ts`
// invocations against a throwaway `rclone serve webdav` fake cloud, with all
// state isolated to a temp HOME so it never touches the real ~/.netmount.
//
// Run:  NETMOUNT_RCLONE_BIN=/path/to/rclone bun cli/test/e2e.ts
//       (or `bun run cli:e2e` after setting NETMOUNT_RCLONE_BIN)
//
// Needs a real rclone binary (cmount build for the mount cases). If
// NETMOUNT_RCLONE_BIN is unset and rclone is not on PATH, the suite skips
// with a clear message rather than failing.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../main.ts', import.meta.url))
const RCLONE = process.env.NETMOUNT_RCLONE_BIN || 'rclone'
const OPENLIST = process.env.NETMOUNT_OPENLIST_BIN || 'openlist'
const WEBDAV_PORT = 8791
const WEBDAV_USER = 'demo'
const WEBDAV_PASS = 'demopw' // throwaway fixture credential, not a real secret
const S3_PORT = 8792
const S3_AK = 'e2eaccesskey' // throwaway fixture credential, not a real secret
const S3_SK = 'e2esecretkey0123456789' // throwaway fixture credential, not a real secret

// ---- tiny assert harness -------------------------------------------------
let pass = 0
let fail = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    process.stdout.write(`  PASS  ${name}\n`)
  } else {
    fail++
    failures.push(name + (detail ? ` -- ${detail}` : ''))
    process.stdout.write(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}\n`)
  }
}

// ---- temp HOME isolation -------------------------------------------------
const HOME = mkdtempSync(join(tmpdir(), 'netmount-e2e-'))
const BACKEND = join(HOME, 'cloud') // what the fake webdav serves
const SRC = join(HOME, 'src') // local files to upload
const S3_ROOT = join(HOME, 's3') // what the fake s3 serves; top-level dirs = buckets
const S3_BUCKET = join(S3_ROOT, 'databucket')
mkdirSync(BACKEND, { recursive: true })
mkdirSync(SRC, { recursive: true })
mkdirSync(S3_BUCKET, { recursive: true })

// Children inherit an isolated home so the CLI writes to <HOME>/.netmount.
const childEnv = {
  ...process.env,
  HOME,
  USERPROFILE: HOME,
  NETMOUNT_RCLONE_BIN: RCLONE,
  NETMOUNT_OPENLIST_BIN: OPENLIST,
}

type RunResult = { code: number; stdout: string; stderr: string }
function run(args: string[], opts: { input?: string; env?: Record<string, string> } = {}): RunResult {
  const r = spawnSync('bun', [CLI, ...args], {
    encoding: 'utf8',
    input: opts.input,
    env: { ...childEnv, ...opts.env },
  })
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function readDaemonState(): { url: string; user: string; pass: string } {
  const s = JSON.parse(readFileSync(join(HOME, '.netmount', 'daemon.json'), 'utf8'))
  return { url: s.url, user: s.user, pass: s.pass }
}

async function rc(path: string, body: unknown): Promise<Response> {
  const s = readDaemonState()
  return fetch(`${s.url}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${s.user}:${s.pass}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---- fixtures: rclone serve webdav + serve s3 ----------------------------
let serve: ChildProcess | undefined
let serveS3: ChildProcess | undefined
function startFakeCloud(): void {
  serve = spawn(
    RCLONE,
    ['serve', 'webdav', '--addr', `127.0.0.1:${WEBDAV_PORT}`, '--user', WEBDAV_USER, '--pass', WEBDAV_PASS, BACKEND],
    { stdio: 'ignore' }
  )
  serveS3 = spawn(
    RCLONE,
    ['serve', 's3', '--addr', `127.0.0.1:${S3_PORT}`, '--auth-key', `${S3_AK},${S3_SK}`, S3_ROOT],
    { stdio: 'ignore' }
  )
}

function killWindowsStrays(): void {
  // openlist is spawned by the CLI's node runtime (not tracked here); make sure
  // no stray openlist/rclone process survives the suite on Windows.
  if (process.platform === 'win32') {
    spawnSync(
      'powershell.exe',
      ['-NoProfile', '-Command', "Get-Process rclone,openlist -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"],
      { stdio: 'ignore' }
    )
  }
}

function teardown(): void {
  try {
    run(['daemon', 'stop']) // also stops openlist
  } catch {}
  for (const p of [serve, serveS3]) {
    if (p && p.pid) {
      try {
        process.kill(p.pid)
      } catch {}
    }
  }
  killWindowsStrays()
  try {
    rmSync(HOME, { recursive: true, force: true })
  } catch {}
}

// ---- preflight: is rclone usable? ----------------------------------------
function rcloneAvailable(): boolean {
  const r = spawnSync(RCLONE, ['version'], { encoding: 'utf8' })
  return r.status === 0
}

// ---- preflight: is openlist usable? --------------------------------------
function openlistAvailable(): boolean {
  const r = spawnSync(OPENLIST, ['version'], { encoding: 'utf8' })
  return r.status === 0
}

async function main(): Promise<void> {
  if (!rcloneAvailable()) {
    process.stdout.write(
      `SKIP: rclone not runnable (NETMOUNT_RCLONE_BIN=${process.env.NETMOUNT_RCLONE_BIN ?? 'unset'}). ` +
        `Set NETMOUNT_RCLONE_BIN to an rclone binary to run the e2e suite.\n`
    )
    teardown()
    process.exit(0)
  }

  startFakeCloud()
  await sleep(1500)

  process.stdout.write('\n== daemon ==\n')
  {
    const r = run(['daemon', 'start', '--json'])
    check('daemon start exit 0', r.code === 0, r.stderr.trim())
    check('daemon bound to localhost', /127\.0\.0\.1/.test(r.stdout + r.stderr))
    const st = run(['daemon', 'status', '--json'])
    check('daemon status reports running', /running|true|127\.0\.0\.1/i.test(st.stdout + st.stderr))
  }

  process.stdout.write('\n== storage add / info (secret masking) ==\n')
  {
    const add = run(
      ['storage', 'add', 'webdav', 'fc', '--url', `http://127.0.0.1:${WEBDAV_PORT}`, '--user', WEBDAV_USER, '--password-stdin', '--vendor', 'other'],
      { input: WEBDAV_PASS }
    )
    check('storage add exit 0', add.code === 0, add.stderr.trim())
    const info = run(['storage', 'info', 'fc', '--json'])
    check('storage info exit 0', info.code === 0, info.stderr.trim())
    check('storage info masks the password', info.stdout.includes('***'))
    check('storage info never leaks plaintext pass', !info.stdout.includes(WEBDAV_PASS))
    check('storage info shows the url', info.stdout.includes(`127.0.0.1:${WEBDAV_PORT}`))
  }

  process.stdout.write('\n== storage add s3 (per-backend params + masking + roundtrip) ==\n')
  {
    const add = run(
      ['storage', 'add', 's3', 's3fc', '--provider', 'Other', '--endpoint', `http://127.0.0.1:${S3_PORT}`, '--access-key', S3_AK, '--password-stdin'],
      { input: S3_SK }
    )
    check('s3 add exit 0', add.code === 0, add.stderr.trim())
    const info = run(['storage', 'info', 's3fc', '--json'])
    check('s3 info exit 0', info.code === 0, info.stderr.trim())
    check('s3 info maps endpoint (not url)', info.stdout.includes(`127.0.0.1:${S3_PORT}`))
    check('s3 info never leaks the secret key', !info.stdout.includes(S3_SK))
    check('s3 info masks the secret_access_key', /"secret_access_key":\s*"\*\*\*"/.test(info.stdout))
    // upload into a bucket and confirm the object lands in the served dir — proves
    // access_key_id + secret_access_key are actually stored and used, not just saved.
    const payload = 's3 roundtrip payload\n'
    writeFileSync(join(SRC, 's3up.txt'), payload)
    const up = run(['upload', join(SRC, 's3up.txt'), 's3fc:databucket'])
    check('s3 upload exit 0', up.code === 0, up.stderr.trim())
    check('s3 object landed in bucket', existsSync(join(S3_BUCKET, 's3up.txt')))
    if (existsSync(join(S3_BUCKET, 's3up.txt'))) {
      check('s3 uploaded bytes match', readFileSync(join(S3_BUCKET, 's3up.txt'), 'utf8') === payload)
    }
    run(['storage', 'del', 's3fc'])
  }

  process.stdout.write('\n== storage providers (backend discovery) ==\n')
  {
    const all = run(['storage', 'providers', '--json'])
    check('providers list exit 0', all.code === 0, all.stderr.trim())
    let types: string[] = []
    try {
      types = (JSON.parse(all.stdout) as { type: string }[]).map(p => p.type)
    } catch {}
    check('providers list is non-empty', types.length > 10, `got ${types.length}`)
    check('providers list includes s3/webdav/drive', ['s3', 'webdav', 'drive'].every(t => types.includes(t)))
    const one = run(['storage', 'providers', 's3', '--json'])
    check('providers <type> exit 0', one.code === 0, one.stderr.trim())
    check('s3 provider lists access_key_id option', one.stdout.includes('access_key_id'))
    const bad = run(['storage', 'providers', 'no-such-backend'])
    check('providers unknown type -> exit 2', bad.code === 2)
  }

  process.stdout.write('\n== storage add via --option escape hatch ==\n')
  {
    // configure an s3 backend entirely through generic --option key=value, no
    // per-backend flags — proves any rclone param is reachable for any backend.
    const add = run([
      'storage', 'add', 's3', 's3opt',
      '--option', 'provider=Other',
      '--option', `endpoint=http://127.0.0.1:${S3_PORT}`,
      '--option', `access_key_id=${S3_AK}`,
      '--option', `secret_access_key=${S3_SK}`,
    ])
    check('storage add --option exit 0', add.code === 0, add.stderr.trim())
    const info = run(['storage', 'info', 's3opt', '--json'])
    check('--option set the endpoint', info.stdout.includes(`127.0.0.1:${S3_PORT}`))
    check('--option set the provider', info.stdout.includes('Other'))
    check('--option secret still masked', !info.stdout.includes(S3_SK))
    run(['storage', 'del', 's3opt'])
  }

  process.stdout.write('\n== OAuth token passing (--token-stdin: stored + masked) ==\n')
  {
    // OAuth backends (drive/onedrive/box/...) take a pre-fetched token JSON from
    // `rclone authorize <type>`; the CLI passes it through --token-stdin. We can't
    // exercise a real OAuth backend offline (drive validates the token against
    // Google's endpoint and would hang the suite on a fake one), so we verify the
    // *plumbing* on webdav: resolveToken -> buildStorageParams sets `token` ->
    // createStorage persists it -> storage info masks it. rclone stores the param
    // verbatim with no network call, so this is deterministic.
    const token = '{"access_token":"e2e-fake-access","token_type":"Bearer","refresh_token":"e2e-fake-refresh"}'
    const add = run(['storage', 'add', 'webdav', 'gtok', '--url', 'http://127.0.0.1:1', '--token-stdin'], { input: token })
    check('token-stdin add exit 0', add.code === 0, add.stderr.trim())
    const info = run(['storage', 'info', 'gtok', '--json'])
    check('token storage persisted (info exit 0)', info.code === 0, info.stderr.trim())
    check('token is stored (key present)', /"token"/.test(info.stdout))
    check('token value is masked', !info.stdout.includes('e2e-fake-access') && !info.stdout.includes('e2e-fake-refresh'))
    run(['storage', 'del', 'gtok'])
  }

  process.stdout.write('\n== storage edit (merge, not replace) ==\n')
  {
    const ed = run(['storage', 'edit', 'fc', '--user', 'demo2'])
    check('storage edit exit 0', ed.code === 0, ed.stderr.trim())
    const info = run(['storage', 'info', 'fc', '--json'])
    check('edit changed the user', info.stdout.includes('demo2'))
    check('edit preserved the url (merge)', info.stdout.includes(`127.0.0.1:${WEBDAV_PORT}`))
    // restore the working credential — the fake cloud authenticates as WEBDAV_USER,
    // so leaving it as demo2 would 401 every file/stats op that follows.
    const back = run(['storage', 'edit', 'fc', '--user', WEBDAV_USER])
    check('edit restored the working user', back.code === 0, back.stderr.trim())
  }

  process.stdout.write('\n== file upload / download roundtrip ==\n')
  {
    const payload = 'netmount e2e payload line\n'
    writeFileSync(join(SRC, 'up.txt'), payload)
    const up = run(['upload', join(SRC, 'up.txt'), 'fc:incoming'])
    check('upload exit 0', up.code === 0, up.stderr.trim())
    check('backend received the file', existsSync(join(BACKEND, 'incoming', 'up.txt')))
    if (existsSync(join(BACKEND, 'incoming', 'up.txt'))) {
      check('uploaded bytes match', readFileSync(join(BACKEND, 'incoming', 'up.txt'), 'utf8') === payload)
    }
    const dl = run(['download', 'fc:incoming/up.txt', join(SRC, 'back')])
    check('download exit 0', dl.code === 0, dl.stderr.trim())
    check('downloaded bytes match', existsSync(join(SRC, 'back', 'up.txt')) && readFileSync(join(SRC, 'back', 'up.txt'), 'utf8') === payload)
  }

  process.stdout.write('\n== file ls / cp / mv ==\n')
  {
    const ls = run(['file', 'ls', 'fc:incoming', '--json'])
    check('file ls exit 0', ls.code === 0, ls.stderr.trim())
    check('file ls lists up.txt', ls.stdout.includes('up.txt'))
    const cp = run(['file', 'cp', 'fc:incoming/up.txt', 'fc:copied'])
    check('file cp exit 0', cp.code === 0, cp.stderr.trim())
    check('cp landed with correct separator (copied/up.txt)', existsSync(join(BACKEND, 'copied', 'up.txt')))
    const mv = run(['file', 'mv', 'fc:incoming/up.txt', 'fc:moved'])
    check('file mv exit 0', mv.code === 0, mv.stderr.trim())
    check('mv created dest', existsSync(join(BACKEND, 'moved', 'up.txt')))
    check('mv removed source', !existsSync(join(BACKEND, 'incoming', 'up.txt')))
  }

  process.stdout.write('\n== sync (directory push/pull via a storage) ==\n')
  {
    const sdir = join(SRC, 'syncsrc')
    mkdirSync(sdir, { recursive: true })
    writeFileSync(join(sdir, 'a.txt'), 'alpha\n')
    writeFileSync(join(sdir, 'b.txt'), 'bravo\n')
    // push a local directory up to the (webdav) storage
    const push = run(['sync', sdir, 'fc:synced'])
    check('sync push exit 0', push.code === 0, push.stderr.trim())
    check('sync pushed a.txt to backend', existsSync(join(BACKEND, 'synced', 'a.txt')))
    check('sync pushed b.txt to backend', existsSync(join(BACKEND, 'synced', 'b.txt')))
    // pull it back down into a fresh local dir
    const pdir = join(SRC, 'syncpull')
    const pull = run(['sync', 'fc:synced', pdir])
    check('sync pull exit 0', pull.code === 0, pull.stderr.trim())
    check('sync pulled bytes match', existsSync(join(pdir, 'a.txt')) && readFileSync(join(pdir, 'a.txt'), 'utf8') === 'alpha\n')
    // re-run is idempotent (rclone skips already-transferred files) — must still exit 0
    const again = run(['sync', sdir, 'fc:synced'])
    check('sync re-run idempotent exit 0', again.code === 0, again.stderr.trim())
  }

  process.stdout.write('\n== task list / status (config-only, read) ==\n')
  {
    // inject a saved task into the isolated app config
    const cfgPath = join(HOME, '.netmount', 'config.json')
    const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {}
    cfg.task = [
      {
        name: 'nightly',
        taskType: 'sync',
        source: { storageName: 'fc', path: 'a' },
        target: { storageName: 'local', path: '/b' },
        enable: true,
        run: { mode: 'auto', time: { intervalDays: 1, h: 3, m: 0, s: 0 } },
        runInfo: { error: '', msg: 'ok' },
      },
    ]
    writeFileSync(cfgPath, JSON.stringify(cfg))
    const ls = run(['task', 'list', '--json'])
    check('task list exit 0', ls.code === 0, ls.stderr.trim())
    check('task list shows the saved task', ls.stdout.includes('nightly') && ls.stdout.includes('fc:a'))
    const st = run(['task', 'status', 'nightly'])
    check('task status exit 0', st.code === 0, st.stderr.trim())
    const miss = run(['task', 'status', 'nope'])
    check('task status missing -> exit 2', miss.code === 2)
  }

  process.stdout.write('\n== stats (in-flight realSpeed via global bwlimit) ==\n')
  {
    // 12MB source, throttle the daemon to 1MiB/s so the copy stays in flight ~12s
    const big = Buffer.alloc(12 * 1024 * 1024)
    writeFileSync(join(SRC, 'big.bin'), big)
    await rc('/core/bwlimit', { rate: '1M' })
    await rc('/sync/copy', { srcFs: SRC.replace(/\\/g, '/'), dstFs: 'fc:bulk', _async: true })
    let sawLive = false
    let sawProgress = false
    let lastBytes = -1
    // Poll until BOTH signals are seen (or the window elapses) — don't stop on
    // the first, or progress never gets a second sample to compare against.
    for (let i = 0; i < 14 && !(sawLive && sawProgress); i++) {
      const s = run(['stats', '--json'])
      try {
        const j = JSON.parse(s.stdout)
        if ((j.realSpeed ?? 0) > 0) sawLive = true
        if (typeof j.bytes === 'number' && j.bytes > lastBytes) {
          if (lastBytes >= 0 && j.bytes > 0) sawProgress = true
          lastBytes = j.bytes
        }
      } catch {}
      await sleep(900)
    }
    await rc('/core/bwlimit', { rate: 'off' })
    check('stats showed live throughput (realSpeed > 0) during transfer', sawLive)
    check('stats bytes counter advanced during transfer', sawProgress)
  }

  // ---- openlist: real binary, Local driver (no creds, no network) ----------
  // Gated on the openlist binary being runnable; self-skips like the rclone
  // gate so the suite never hard-fails when openlist is absent.
  if (openlistAvailable()) {
    process.stdout.write('\n== openlist: providers + Local driver via the bridge ==\n')
    {
      // bring openlist up and confirm its drivers reach the catalog
      const provs = run(['storage', 'providers', '--openlist', '--json'])
      check('openlist providers exit 0', provs.code === 0, provs.stderr.trim())
      let types: string[] = []
      try {
        types = (JSON.parse(provs.stdout) as { type: string }[]).map(p => p.type)
      } catch {}
      check('catalog includes Quark (openlist netdisk)', types.includes('Quark'), `got ${types.length}`)
      check('catalog includes Local (openlist driver)', types.includes('Local'))

      // a local dir with a known file, mounted via the openlist Local driver
      const olRoot = join(HOME, 'olroot')
      mkdirSync(olRoot, { recursive: true })
      writeFileSync(join(olRoot, 'marker.txt'), 'openlist-marker\n')

      const add = run([
        'storage', 'add', 'Local', 'olloc',
        '--mount-path', '/olloc',
        '--option', `addition.root_folder_path=${olRoot}`,
      ])
      check('openlist storage add exit 0', add.code === 0, add.stderr.trim())

      const list = run(['storage', 'list', '--json'])
      check('storage list shows olloc', list.stdout.includes('"olloc"') || list.stdout.includes('olloc'))
      const info = run(['storage', 'info', 'olloc', '--json'])
      check('storage info olloc exit 0', info.code === 0, info.stderr.trim())
      check('info reports openlist framework', /"framework":\s*"openlist"/.test(info.stdout))

      // confirm it landed in openlist's own storage list (admin API)
      const olState = (() => {
        try {
          return JSON.parse(readFileSync(join(HOME, '.netmount', 'openlist-daemon.json'), 'utf8')) as {
            url: string
            token: string
          }
        } catch {
          return undefined
        }
      })()
      check('openlist daemon state recorded', !!olState?.url && !!olState?.token)
      if (olState) {
        const r = await fetch(`${olState.url}/api/admin/storage/list`, {
          headers: { Authorization: olState.token },
        })
        const body = (await r.json().catch(() => ({}))) as { data?: { content?: { mount_path?: string }[] } }
        const mounts = (body.data?.content ?? []).map(s => s.mount_path)
        check('openlist /api/admin/storage/list has /olloc', mounts.includes('/olloc'), JSON.stringify(mounts))

        // content reachable through the bridge: list via openlist fs and see the file
        const fr = await fetch(`${olState.url}/api/fs/list`, {
          method: 'POST',
          headers: { Authorization: olState.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '/olloc', password: '', page: 1, per_page: 0, refresh: true }),
        })
        const fb = (await fr.json().catch(() => ({}))) as { code?: number; data?: { content?: { name?: string }[] } }
        const names = (fb.data?.content ?? []).map(f => f.name)
        check('seeded file visible through the bridge (fs list)', names.includes('marker.txt'), JSON.stringify(names) + ` code=${fb.code}`)
      }

      const del = run(['storage', 'del', 'olloc'])
      check('openlist storage del exit 0', del.code === 0, del.stderr.trim())
      const after = run(['storage', 'list', '--json'])
      check('deleted openlist storage is gone', !after.stdout.includes('olloc'))
    }
  } else {
    process.stdout.write(
      `\n== openlist == SKIP: openlist not runnable (NETMOUNT_OPENLIST_BIN=${process.env.NETMOUNT_OPENLIST_BIN ?? 'unset'}).\n`
    )
  }

  process.stdout.write('\n== storage del ==\n')
  {
    const del = run(['storage', 'del', 'fc'])
    check('storage del exit 0', del.code === 0, del.stderr.trim())
    const dump = run(['storage', 'list', '--json'])
    check('deleted storage is gone', !dump.stdout.includes('"fc"'))
  }

  process.stdout.write('\n== config doctor (rc bind must be localhost) ==\n')
  {
    const doc = run(['config', 'doctor', '--json'])
    check('config doctor ran', doc.code === 0 || doc.code === 3)
    check('rc bind reported localhost (no EXPOSED)', !/EXPOSED/.test(doc.stdout))
  }

  // ---- summary -----------------------------------------------------------
  process.stdout.write(`\n==== ${pass} passed, ${fail} failed ====\n`)
  if (fail > 0) {
    process.stdout.write('Failures:\n' + failures.map(f => `  - ${f}`).join('\n') + '\n')
  }
}

main()
  .then(() => {
    teardown()
    process.exit(fail > 0 ? 1 : 0)
  })
  .catch(e => {
    process.stdout.write(`\nHARNESS ERROR: ${(e as Error).stack ?? e}\n`)
    teardown()
    process.exit(1)
  })
