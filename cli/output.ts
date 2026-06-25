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

export function fail(code: number, msg: string, hint?: string): never {
  process.stderr.write(`error: ${msg}\n`)
  if (hint) process.stderr.write(`hint: ${hint}\n`)
  process.exit(code)
}
