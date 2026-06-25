import { describe, expect, it } from 'vitest'
import { redactParams } from './redact'

describe('redactParams', () => {
  it('masks nested secret-looking fields', () => {
    expect(
      redactParams({
        url: 'https://example.test',
        pass: 'pw',
        addition: {
          cookie: 'cookie-value',
          headers: { Authorization: 'Bearer token' },
        },
        clients: [{ client_secret: 'secret' }],
      })
    ).toEqual({
      url: 'https://example.test',
      pass: '***',
      addition: {
        cookie: '***',
        headers: { Authorization: '***' },
      },
      clients: [{ client_secret: '***' }],
    })
  })

  it('preserves empty secret fields and non-secret fields', () => {
    expect(redactParams({ token: '', user: 'alice', enabled: true })).toEqual({
      token: '',
      user: 'alice',
      enabled: true,
    })
  })
})
