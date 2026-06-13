// CLI output contract: stdout = result, stderr = logs/warnings/errors.
// json mode -> stable JSON, no color, no table. human -> table + glyphs.
import { Table } from 'console-table-printer'
import pc from 'picocolors'

export const EXIT = {
  OK: 0,
  GENERAL: 1,
  USAGE: 2,
  CONFIG: 3,
  DAEMON: 4, // rclone/openlist not reachable
  MOUNT: 5,
  NETWORK: 6,
} as const

export type OutputMode = 'human' | 'json' | 'plain'

export function resolveMode(opts: { json?: boolean; format?: string }): OutputMode {
  if (opts.json) return 'json'
  if (opts.format === 'json' || opts.format === 'plain' || opts.format === 'human') {
    return opts.format
  }
  return 'human'
}

export function fail(code: number, msg: string, hint?: string): never {
  process.stderr.write(pc.red(`✗ ${msg}\n`))
  if (hint) process.stderr.write(pc.dim(`  → ${hint}\n`))
  process.exit(code)
}

export function info(msg: string): void {
  process.stderr.write(pc.dim(`${msg}\n`))
}

export function ok(msg: string): void {
  process.stderr.write(pc.green(`✓ ${msg}\n`))
}

export function fmtBytes(n?: number): string {
  if (n === undefined || n === null || n < 0) return '-'
  if (n === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`
}

export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n')
}

export function printTable(rows: Record<string, unknown>[], emptyMsg: string): void {
  if (rows.length === 0) {
    process.stderr.write(pc.dim(`${emptyMsg}\n`))
    return
  }
  const t = new Table()
  for (const r of rows) t.addRow(r)
  // render() returns a string -> stdout. printTable() uses console.log, which
  // routes to stderr under redirected stdout and breaks the result contract.
  process.stdout.write(t.render() + '\n')
}
