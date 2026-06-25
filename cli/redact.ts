const SECRET_KEY = /pass|secret|token|key|credential|cookie|session|authorization/i

export function redactParams(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactParams)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SECRET_KEY.test(key) && entry !== undefined && entry !== null && entry !== '' ? '***' : redactParams(entry),
      ])
    )
  }
  return value
}
