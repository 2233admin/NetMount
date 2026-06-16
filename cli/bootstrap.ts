// First-run dependency bootstrap.
//
// The GUI bundles rclone + openlist as Tauri sidecars, downloaded at BUILD time
// by src-tauri/build.rs and compiled in. The standalone CLI binary ships alone,
// so it must fetch those two on first use. This module downloads them into
// ~/.netmount/bin/ on demand and points the shared node runtime at them via
// NETMOUNT_RCLONE_BIN / NETMOUNT_OPENLIST_BIN (both already honored by
// src/runtime/node.ts resolveBinary() and cli/daemon.ts).
//
// URL / version / arch mapping mirrors src-tauri/build.rs so CLI and GUI fetch
// the same binaries. openlist is GitHub-hosted and routes through
// NETMOUNT_GITHUB_PROXY (default gh-proxy.com, same default as the build); set it
// to "" or "0" to hit github.com directly. rclone is downloads.rclone.org direct.
// A user who already manages their own binaries can set NETMOUNT_*_BIN to skip
// all of this.
import { mkdir, chmod, rename, rm, readFile, writeFile } from 'node:fs/promises'
import { createWriteStream, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { gunzipSync, unzipSync } from 'fflate'

const BIN_DIR = join(homedir(), '.netmount', 'bin')
// Pinned to match build.rs DEFAULT_OPENLIST_VERSION; override to track another.
const OPENLIST_VERSION = process.env.NETMOUNT_OPENLIST_VERSION || 'v4.1.10'

const isWin = process.platform === 'win32'
const exe = isWin ? '.exe' : ''

type Tool = 'rclone' | 'openlist'

// node process.arch -> rclone download token (build.rs windows/linux/macos arms)
function rcloneArch(): string {
  switch (process.arch) {
    case 'x64': return 'amd64'
    case 'arm64': return 'arm64'
    case 'ia32': return '386'
    case 'arm': return 'arm'
    default: return ''
  }
}

function openlistArch(): string {
  switch (process.arch) {
    case 'x64': return 'amd64'
    case 'arm64': return 'arm64'
    case 'ia32': return '386'
    default: return ''
  }
}

function rcloneOs(): string {
  switch (process.platform) {
    case 'win32': return 'windows'
    case 'darwin': return 'osx'
    case 'linux': return 'linux'
    default: return ''
  }
}

function openlistOs(): string {
  switch (process.platform) {
    case 'win32': return 'windows'
    case 'darwin': return 'darwin'
    case 'linux': return 'linux'
    default: return ''
  }
}

function applyProxy(url: string): string {
  if (!url.includes('//github.com')) return url
  let proxy = (process.env.NETMOUNT_GITHUB_PROXY ?? 'https://gh-proxy.com/').trim()
  if (!proxy || proxy === '0') return url
  if (!proxy.endsWith('/')) proxy += '/'
  return proxy + url
}

function rcloneUrl(): string {
  const os = rcloneOs()
  const arch = rcloneArch()
  if (!os || !arch) {
    throw new Error(`unsupported platform for rclone: ${process.platform}/${process.arch}`)
  }
  // rclone publishes only .zip, on every platform.
  return `https://downloads.rclone.org/rclone-current-${os}-${arch}.zip`
}

function openlistUrl(): string {
  const os = openlistOs()
  const arch = openlistArch()
  if (!os || !arch) {
    throw new Error(`unsupported platform for openlist: ${process.platform}/${process.arch}`)
  }
  const ext = os === 'windows' ? 'zip' : 'tar.gz'
  const raw = `https://github.com/OpenListTeam/OpenList/releases/download/${OPENLIST_VERSION}/openlist-${os}-${arch}.${ext}`
  return applyProxy(raw)
}

// Stream a URL to disk, showing a percent line on a TTY stderr.
async function download(url: string, outPath: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status} ${url}`)
  }
  const total = Number(res.headers.get('content-length')) || 0
  const src = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  if (total > 0 && process.stderr.isTTY) {
    let done = 0
    let lastPct = -1
    src.on('data', (c: Buffer) => {
      done += c.length
      const pct = Math.floor((done / total) * 100)
      if (pct !== lastPct && (pct % 5 === 0 || pct === 100)) {
        lastPct = pct
        process.stderr.write(`\r  下载中 ${pct}%   `)
      }
    })
  }
  await pipeline(src, createWriteStream(outPath))
  if (total > 0 && process.stderr.isTTY) process.stderr.write('\r                    \r')
}

// Minimal tar (ustar) reader: walk 512-byte records, return the data of the first
// regular-file entry whose basename matches `wantBase`. Octal sizes only (binaries
// are < 8GB); PAX/long-name extensions are skipped as data, which is fine for the
// flat openlist tarball.
function fileFromTar(tar: Uint8Array, wantBase: string): Uint8Array | undefined {
  const dec = new TextDecoder()
  let off = 0
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512)
    if (header.every(b => b === 0)) break
    const name = dec.decode(header.subarray(0, 100)).replace(/\0.*$/s, '')
    const size = parseInt(dec.decode(header.subarray(124, 136)).replace(/\0.*$/s, '').trim(), 8) || 0
    const type = header[156]
    off += 512
    const isFile = type === 0x30 /* '0' */ || type === 0 /* legacy */
    if (isFile && basename(name) === wantBase) return tar.subarray(off, off + size)
    off += Math.ceil(size / 512) * 512
  }
  return undefined
}

// Pull the wanted binary out of a .zip or .tar.gz into destPath.
async function extractBinary(
  archivePath: string,
  kind: 'zip' | 'tar.gz',
  wantBase: string,
  destPath: string
): Promise<void> {
  const buf = new Uint8Array(await readFile(archivePath))
  let data: Uint8Array | undefined
  if (kind === 'zip') {
    const files = unzipSync(buf)
    const key = Object.keys(files).find(k => basename(k) === wantBase)
    if (key) data = files[key]
  } else {
    data = fileFromTar(gunzipSync(buf), wantBase)
  }
  if (!data) throw new Error(`${wantBase} not found in downloaded archive`)
  await writeFile(destPath, Buffer.from(data))
}

async function ensure(tool: Tool): Promise<string> {
  const want = tool + exe
  const dest = join(BIN_DIR, want)
  if (existsSync(dest)) return dest

  await mkdir(BIN_DIR, { recursive: true })
  const url = tool === 'rclone' ? rcloneUrl() : openlistUrl()
  const kind: 'zip' | 'tar.gz' = url.endsWith('.tar.gz') ? 'tar.gz' : 'zip'
  process.stderr.write(`  ${tool} 未找到, 正在下载...\n`)

  const tmp = join(tmpdir(), `netmount-${tool}-${process.pid}.${kind === 'tar.gz' ? 'tgz' : 'zip'}`)
  const partial = dest + '.partial'
  try {
    await download(url, tmp)
    await extractBinary(tmp, kind, want, partial)
    if (!isWin) await chmod(partial, 0o755)
    await rename(partial, dest)
  } catch (e) {
    await rm(partial, { force: true })
    throw e
  } finally {
    await rm(tmp, { force: true })
  }
  process.stderr.write(`  ${tool} 就绪 -> ${dest}\n`)
  return dest
}

// Ensure rclone exists and the shared runtime resolves to it. Honors a
// user-provided NETMOUNT_RCLONE_BIN; otherwise downloads into ~/.netmount/bin/.
export async function ensureRcloneBin(): Promise<string> {
  if (process.env.NETMOUNT_RCLONE_BIN) return process.env.NETMOUNT_RCLONE_BIN
  const p = await ensure('rclone')
  process.env.NETMOUNT_RCLONE_BIN = p
  return p
}

export async function ensureOpenlistBin(): Promise<string> {
  if (process.env.NETMOUNT_OPENLIST_BIN) return process.env.NETMOUNT_OPENLIST_BIN
  const p = await ensure('openlist')
  process.env.NETMOUNT_OPENLIST_BIN = p
  return p
}
