#!/usr/bin/env bun
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { nodeRuntime } from '../src/runtime/node'
import { setRuntime } from '../src/runtime/port'
import {
  DaemonError,
  daemonStatus,
  ensureDaemon,
  nmPaths,
  publicDaemonState,
  resolveRcloneBin,
  stopDaemon,
} from './daemon'
import { EXIT, fail, printJson, printLines, resolveMode, type OutputMode } from './output'

setRuntime(nodeRuntime)

const execFileAsync = promisify(execFile)

interface ParsedArgs {
  positionals: string[]
  format?: string
  json?: boolean
  help?: boolean
}

interface BinaryCheck {
  command: string
  ok: boolean
  detail?: string
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (arg === '--json') {
      parsed.json = true
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true
    } else if (arg === '--format') {
      const value = argv[i + 1]
      if (!value) fail(EXIT.USAGE, '--format requires a value')
      parsed.format = value
      i += 1
    } else if (arg.startsWith('--format=')) {
      parsed.format = arg.slice('--format='.length)
    } else {
      parsed.positionals.push(arg)
    }
  }
  return parsed
}

function usage(): void {
  printLines([
    'NetMount CLI',
    '',
    'Usage:',
    '  netmount config doctor [--format json]',
    '  netmount daemon status [--format json]',
    '  netmount daemon start [--format json]',
    '  netmount daemon stop [--format json]',
    '',
    'Environment:',
    '  NETMOUNT_RCLONE_BIN    Path to rclone binary when it is not on PATH',
    '  NETMOUNT_OPENLIST_BIN  Path to openlist binary for later OpenList commands',
  ])
}

async function checkBinary(command: string, args: string[]): Promise<BinaryCheck> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: 'utf8',
      timeout: 2500,
    })
    const firstLine = stdout.split(/\r?\n/).find(Boolean)
    return { command, ok: true, detail: firstLine }
  } catch (error) {
    return {
      command,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

function publicStatus(status: Awaited<ReturnType<typeof daemonStatus>>) {
  return {
    running: status.running,
    state: status.state ? publicDaemonState(status.state) : undefined,
  }
}

function printDaemon(mode: OutputMode, action: string, status: Awaited<ReturnType<typeof daemonStatus>>): void {
  const safeStatus = publicStatus(status)
  if (mode === 'json') {
    printJson({ action, ...safeStatus, paths: nmPaths })
    return
  }
  const state = safeStatus.state
  printLines([
    `daemon: ${safeStatus.running ? 'running' : 'stopped'}`,
    state ? `url: ${state.url}` : 'url: -',
    state ? `pid: ${state.pid}` : 'pid: -',
    `state: ${nmPaths.daemonState}`,
  ])
}

async function runDaemon(args: string[], mode: OutputMode): Promise<void> {
  const action = args[0] ?? 'status'
  if (action === 'status') {
    printDaemon(mode, action, await daemonStatus())
    return
  }
  if (action === 'start') {
    const state = await ensureDaemon()
    printDaemon(mode, action, { running: true, state })
    return
  }
  if (action === 'stop') {
    const stopped = await stopDaemon()
    if (mode === 'json') {
      printJson({ action, stopped, paths: nmPaths })
      return
    }
    printLines([`daemon: ${stopped ? 'stopped' : 'not running'}`, `state: ${nmPaths.daemonState}`])
    return
  }
  fail(EXIT.USAGE, `unknown daemon command: ${action}`)
}

async function runDoctor(mode: OutputMode): Promise<void> {
  const [rclone, openlist] = await Promise.all([
    checkBinary(resolveRcloneBin(), ['version']),
    process.env.NETMOUNT_OPENLIST_BIN
      ? checkBinary(process.env.NETMOUNT_OPENLIST_BIN, ['version'])
      : Promise.resolve<BinaryCheck>({ command: 'openlist', ok: false, detail: 'NETMOUNT_OPENLIST_BIN not set' }),
  ])
  const status = publicStatus(await daemonStatus())
  const result = {
    ok: rclone.ok,
    runtime: 'node',
    binaries: { rclone, openlist },
    daemon: status,
    paths: nmPaths,
    env: {
      NETMOUNT_RCLONE_BIN: Boolean(process.env.NETMOUNT_RCLONE_BIN),
      NETMOUNT_OPENLIST_BIN: Boolean(process.env.NETMOUNT_OPENLIST_BIN),
    },
  }
  if (mode === 'json') {
    printJson(result)
    return
  }
  printLines([
    `runtime: ${result.runtime}`,
    `rclone: ${rclone.ok ? 'ok' : 'missing'} (${rclone.command})`,
    `openlist: ${openlist.ok ? 'ok' : 'not configured'} (${openlist.command})`,
    `daemon: ${status.running ? 'running' : 'stopped'}`,
    `config: ${nmPaths.appConfig}`,
    `state: ${nmPaths.daemonState}`,
  ])
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  const mode = resolveMode(parsed)
  const [scope, command, ...rest] = parsed.positionals

  if (parsed.help || !scope) {
    usage()
    return
  }

  if (scope === 'daemon') {
    await runDaemon(command ? [command, ...rest] : [], mode)
    return
  }
  if (scope === 'config' && command === 'doctor') {
    await runDoctor(mode)
    return
  }
  if (scope === 'doctor') {
    await runDoctor(mode)
    return
  }

  fail(EXIT.USAGE, `unknown command: ${parsed.positionals.join(' ')}`)
}

main().catch(error => {
  if (error instanceof DaemonError) fail(EXIT.DAEMON, error.message, error.hint)
  fail(EXIT.GENERAL, error instanceof Error ? error.message : String(error))
})
