// Resolve the NetMount data dir for the node/CLI runtime. Mirrors the GUI's
// src-tauri/src/lib.rs resolve_data_dir() so CLI and GUI land on the same dir:
//   1. NETMOUNT_DATA_DIR  -- explicit override; point the CLI here to share a
//      portable GUI's <exe>/data dir (same storages, config, rclone.conf)
//   2. portable -- a `.portable` marker next to the running binary -> <exeDir>/data
//   3. default -- ~/.netmount
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function resolveDataDir(): string {
  const override = process.env.NETMOUNT_DATA_DIR?.trim()
  if (override) return override
  try {
    const exeDir = dirname(process.execPath)
    if (existsSync(join(exeDir, '.portable'))) return join(exeDir, 'data')
  } catch {
    // process.execPath unavailable -> fall through to home
  }
  return join(homedir(), '.netmount')
}
