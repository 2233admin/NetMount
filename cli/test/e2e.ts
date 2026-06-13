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
const WEBDAV_PORT = 8791
const WEBDAV_USER = 'demo'
const WEBDAV_PASS = 'demopw' // throwaway fixture credential, not a real secret

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
mkdirSync(BACKEND, { recursive: true })
mkdirSync(SRC, { recursive: true })

// Children inherit an isolated home so the CLI writes to <HOME>/.netmount.
const childEnv = {
  ...process.env,
  HOME,
  USERPROFILE: HOME,
  NETMOUNT_RCLONE_BIN: RCLONE,
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

// ---- fixture: rclone serve webdav ----------------------------------------
let serve: ChildProcess | undefined
function startFakeCloud(): void {
  serve = spawn(
    RCLONE,
    ['serve', 'webdav', '--addr', `127.0.0.1:${WEBDAV_PORT}`, '--user', WEBDAV_USER, '--pass', WEBDAV_PASS, BACKEND],
    { stdio: 'ignore' }
  )
}

function teardown(): void {
  try {
    run(['daemon', 'stop'])
  } catch {}
  if (serve && serve.pid) {
    try {
      process.kill(serve.pid)
    } catch {}
  }
  try {
    rmSync(HOME, { recursive: true, force: true })
  } catch {}
}

// ---- preflight: is rclone usable? ----------------------------------------
function rcloneAvailable(): boolean {
  const r = spawnSync(RCLONE, ['version'], { encoding: 'utf8' })
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
