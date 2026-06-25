export const EXIT = {
  OK: 0,
  GENERAL: 1,
  USAGE: 2,
  CONFIG: 3,
  DAEMON: 4,
} as const

export type OutputMode = 'human' | 'json'

export function resolveMode(opts: { json?: boolean; format?: string }): OutputMode {
  if (opts.json || opts.format === 'json') return 'json'
  return 'human'
}

export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n')
}

export function printLines(lines: string[]): void {
  process.stdout.write(lines.join('\n') + '\n')
}

export function info(msg: string): void {
  process.stderr.write(`${msg}\n`)
}

export function fmtBytes(n?: number): string {
  if (n === undefined || n === null || n < 0) return '-'
  if (n === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`
}

export function fail(code: number, msg: string, hint?: string): never {
  process.stderr.write(`error: ${msg}\n`)
  if (hint) process.stderr.write(`hint: ${hint}\n`)
  process.exit(code)
}
