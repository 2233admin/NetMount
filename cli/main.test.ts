import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectStore: vi.fn(),
  daemonStatus: vi.fn(),
  ensureDaemon: vi.fn(),
  getStorageParams: vi.fn(),
  loadConfig: vi.fn(),
  publicDaemonState: vi.fn(),
  resolveRcloneBin: vi.fn(),
  reupStorage: vi.fn(),
  searchStorage: vi.fn(),
  setRuntime: vi.fn(),
  stopDaemon: vi.fn(),
  useStorageGetState: vi.fn(),
}))

vi.mock('../src/runtime/node', () => ({
  nodeRuntime: {},
}))

vi.mock('../src/runtime/port', () => ({
  setRuntime: mocks.setRuntime,
}))

vi.mock('../src/services/ConfigService', () => ({
  configService: {
    loadConfig: mocks.loadConfig,
  },
}))

vi.mock('../src/services/storage/StorageManager', () => ({
  getStorageParams: mocks.getStorageParams,
  reupStorage: mocks.reupStorage,
  searchStorage: mocks.searchStorage,
}))

vi.mock('../src/stores/storageStore', () => ({
  useStorageStore: {
    getState: mocks.useStorageGetState,
  },
}))

vi.mock('./daemon', () => ({
  DaemonError: class DaemonError extends Error {
    hint: string

    constructor(message: string, hint: string) {
      super(message)
      this.hint = hint
    }
  },
  connectStore: mocks.connectStore,
  daemonStatus: mocks.daemonStatus,
  ensureDaemon: mocks.ensureDaemon,
  nmPaths: {
    appConfig: '/tmp/netmount/config.json',
    daemonState: '/tmp/netmount/daemon.json',
  },
  publicDaemonState: mocks.publicDaemonState,
  resolveRcloneBin: mocks.resolveRcloneBin,
  stopDaemon: mocks.stopDaemon,
}))

describe('CLI storage commands', () => {
  let stdout = ''
  let stderr = ''

  beforeEach(() => {
    stdout = ''
    stderr = ''
    vi.clearAllMocks()
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout += String(chunk)
      return true
    }) as typeof process.stdout.write)
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderr += String(chunk)
      return true
    }) as typeof process.stderr.write)
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${String(code)}`)
    }) as typeof process.exit)

    mocks.ensureDaemon.mockResolvedValue({
      pass: 'daemon-pass',
      pid: 100,
      port: 5572,
      url: 'http://127.0.0.1:5572',
      user: 'daemon-user',
    })
    mocks.daemonStatus.mockResolvedValue({ running: false })
    mocks.loadConfig.mockResolvedValue(undefined)
    mocks.reupStorage.mockResolvedValue(undefined)
    mocks.searchStorage.mockReturnValue({
      framework: 'rclone',
      name: 'secretwebdav',
      space: { free: 7, total: 10, used: 3 },
      type: 'webdav',
    })
    mocks.getStorageParams.mockResolvedValue({
      addition: {
        cookie: 'session-cookie-value',
      },
      pass: 'super-secret-pass',
      user: 'alice',
    })
    mocks.useStorageGetState.mockReturnValue({
      storageList: [
        {
          framework: 'rclone',
          name: 'secretwebdav',
          space: { free: 7, total: 10, used: 3 },
          type: 'webdav',
        },
      ],
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not start the daemon when storage info is missing a name', async () => {
    const { main } = await import('./main')

    await expect(main(['storage', 'info'])).rejects.toThrow('process.exit:2')

    expect(stderr).toContain('storage info requires a name')
    expect(mocks.ensureDaemon).not.toHaveBeenCalled()
    expect(mocks.connectStore).not.toHaveBeenCalled()
    expect(mocks.reupStorage).not.toHaveBeenCalled()
  })

  it('redacts secret storage parameters in JSON output', async () => {
    const { main } = await import('./main')

    await main(['storage', 'info', 'secretwebdav', '--format', 'json'])

    expect(mocks.loadConfig).toHaveBeenCalledOnce()
    expect(mocks.ensureDaemon).toHaveBeenCalledOnce()
    expect(mocks.connectStore).toHaveBeenCalledOnce()
    expect(mocks.reupStorage).toHaveBeenCalledOnce()
    const parsed = JSON.parse(stdout) as { parameters: Record<string, unknown> }
    expect(parsed.parameters.pass).toBe('***')
    expect(parsed.parameters.addition).toEqual({ cookie: '***' })
    expect(parsed.parameters.user).toBe('alice')
    expect(stdout).not.toContain('super-secret-pass')
    expect(stdout).not.toContain('session-cookie-value')
  })

  it('prints a readable storage list with daemon status in human mode', async () => {
    const { main } = await import('./main')

    await main(['storage', 'list'])

    expect(stdout).toContain('NAME\tFRAMEWORK\tTYPE\tUSED\tTOTAL')
    expect(stdout).toContain('secretwebdav\trclone\twebdav\t3 B\t10 B')
    expect(stderr).toContain('daemon: started (http://127.0.0.1:5572)')
    expect(stderr).toContain('OpenList lifecycle/reauth support lands later')
  })

  it('keeps human storage info concise and redacted', async () => {
    const { main } = await import('./main')

    await main(['storage', 'info', 'secretwebdav'])

    expect(stdout).toContain('name: secretwebdav')
    expect(stdout).toContain('parameters: use --format json for redacted backend parameters')
    expect(stdout).not.toContain('super-secret-pass')
    expect(stdout).not.toContain('session-cookie-value')
  })
})
