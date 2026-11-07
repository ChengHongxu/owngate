import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Command } from 'commander'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { createLoginCommand } from '../src/commands/login.js'
import { createConfigCommand } from '../src/commands/config.js'
import { readConfig, writeConfig } from '../src/config.js'
import * as prompts from '../src/prompt.js'

let directory: string
let stdinTty: PropertyDescriptor | undefined
let stdoutTty: PropertyDescriptor | undefined
const originalToken = 'fixture-original-secret'

function setTty(input: boolean, output: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: input })
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: output })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'owngate-cli-login-'))
  vi.stubEnv('OWNGATE_CONFIG_DIR', directory)
  writeConfig({ server: 'https://original.invalid', token: originalToken })
  writeConfig({ defaultConnection: 'fixture-connection' })
  stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  setTty(false, false)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  process.exitCode = 0
})

afterEach(() => {
  if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty)
  else delete (process.stdin as { isTTY?: boolean }).isTTY
  if (stdoutTty) Object.defineProperty(process.stdout, 'isTTY', stdoutTty)
  else delete (process.stdout as { isTTY?: boolean }).isTTY
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  process.exitCode = 0
  rmSync(directory, { recursive: true, force: true })
})

async function run(...args: string[]): Promise<void> {
  const program = new Command().name('owngate').exitOverride()
    .configureOutput({ writeOut: (text) => console.log(text), writeErr: (text) => console.error(text) })
    .addCommand(createLoginCommand()).addCommand(createConfigCommand())
  const configureChildren = (command: Command) => {
    for (const child of command.commands) {
      child.exitOverride().configureOutput({ writeOut: (text) => console.log(text), writeErr: (text) => console.error(text) })
      configureChildren(child)
    }
  }
  configureChildren(program)
  await program.parseAsync(['node', 'owngate', ...args])
}

function respond(status: number, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
}

function output(): string {
  return [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls].flat().join('\n')
}

describe('login input and credential safety', () => {
  it('does not read stdin or wait when noninteractive credentials are missing', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const read = vi.spyOn(prompts, 'readTokenFromStdin')
    const prompt = vi.spyOn(prompts, 'promptInput')
    await run('login')
    expect(process.exitCode).toBe(2)
    expect(read).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(output()).not.toContain(originalToken)
  })

  it('validates a normalized URL with a base path before saving credentials', async () => {
    respond(200, { connections: [{ id: 'fixture-one' }, { id: 'fixture-two' }] })
    await run('login', '--server', '  https://new.invalid/bridge///  ', '--token', 'fixture-new-secret')
    expect(process.exitCode).toBe(0)
    expect(fetch).toHaveBeenCalledWith('https://new.invalid/bridge/api/connections', expect.any(Object))
    expect(readConfig()).toEqual({ server: 'https://new.invalid/bridge', token: 'fixture-new-secret' })
    expect(output()).toContain('2 个连接')
    expect(output()).toContain('owngate conn use')
    expect(vi.mocked(console.log)).not.toHaveBeenCalled()
    expect(output()).not.toContain('fixture-new-secret')
  })

  it('keeps login successful with zero grants and points to client permissions', async () => {
    respond(200, { connections: [] })
    await run('login', '--server', 'https://new.invalid', '--token', 'fixture-zero-secret')
    expect(process.exitCode).toBe(0)
    expect(output()).toContain('0 个连接')
    expect(output()).toContain('后台「客户端」')
    expect(output()).toContain('owngate status')
    expect(readConfig().token).toBe('fixture-zero-secret')
  })

  it('never overwrites a prior login or exposes a rejected token in an API error', async () => {
    const secret = 'fixture-rejected-secret'
    const before = readFileSync(join(directory, 'config.json'), 'utf8')
    respond(401, { error: { code: 'UNAUTHENTICATED', message: `Rejected ${secret}` } })
    await run('login', '--server', 'https://new.invalid', '--token', secret, '--verbose')
    expect(process.exitCode).toBe(7)
    expect(readFileSync(join(directory, 'config.json'), 'utf8')).toBe(before)
    expect(output()).not.toContain(secret)
    expect(output()).not.toContain(originalToken)
  })

  it('rejects an unrelated HTTP success page without replacing the old login', async () => {
    const before = readConfig()
    respond(200, { message: 'an unrelated service' })
    await run('login', '--server', 'https://new.invalid', '--token', 'fixture-new-secret')
    expect(process.exitCode).toBe(1)
    expect(readConfig()).toEqual(before)
    expect(output()).toContain('未保存')
  })

  it('uses bounded stdin reading only when explicitly requested', async () => {
    respond(200, { connections: [] })
    const read = vi.spyOn(prompts, 'readTokenFromStdin').mockResolvedValue('fixture-piped-secret')
    const prompt = vi.spyOn(prompts, 'promptInput')
    await run('login', '--server', 'https://new.invalid', '--token-stdin')
    expect(read).toHaveBeenCalledOnce()
    expect(prompt).not.toHaveBeenCalled()
    expect(readConfig().token).toBe('fixture-piped-secret')
    expect(output()).not.toContain('fixture-piped-secret')
  })

  it('uses a hidden prompt for a missing interactive token', async () => {
    setTty(true, true)
    respond(200, { connections: [] })
    const prompt = vi.spyOn(prompts, 'promptInput').mockResolvedValue('fixture-interactive-secret')
    await run('login', '--server', 'https://new.invalid')
    expect(prompt).toHaveBeenCalledWith(expect.any(String), { hidden: true })
    expect(readConfig().token).toBe('fixture-interactive-secret')
    expect(output()).not.toContain('fixture-interactive-secret')
  })

  it('does not show a prompt when stdout is redirected', async () => {
    setTty(true, false)
    const prompt = vi.spyOn(prompts, 'promptInput')
    const read = vi.spyOn(prompts, 'readTokenFromStdin')
    await run('login', '--server', 'https://new.invalid', '--token-stdin')
    expect(process.exitCode).toBe(2)
    expect(prompt).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects conflicting token sources without echoing the token', async () => {
    const secret = 'fixture-conflicting-secret'
    await expect(run('login', '--server', 'https://new.invalid', '--token', secret, '--token-stdin'))
      .rejects.toMatchObject({ code: 'commander.conflictingOption' })
    expect(output()).not.toContain(secret)
  })

  it.each([
    'https://user:fixture-url-secret@example.invalid/bridge',
    'https://example.invalid/bridge?token=fixture-url-secret',
    'https://example.invalid/bridge#fixture-url-secret',
    'file:///fixture-url-secret',
    'https://example.invalid/bridge?',
    'https://example.invalid/bridge#',
  ])('rejects unsafe server input without echoing it: %s', async (url) => {
    const before = readConfig()
    vi.stubGlobal('fetch', vi.fn())
    await run('login', '--server', url, '--token', 'fixture-new-secret')
    expect(process.exitCode).toBe(2)
    expect(readConfig()).toEqual(before)
    expect(fetch).not.toHaveBeenCalled()
    expect(output()).not.toContain('fixture-url-secret')
    expect(output()).not.toContain('fixture-new-secret')
  })
})

describe('configuration summary and updates', () => {
  it('shows machine-readable safe configuration without exposing the token', async () => {
    await run('config', 'show')
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)).toEqual({
      server: 'https://original.invalid', default_connection: 'fixture-connection', token_configured: true,
    })
    expect(output()).not.toContain(originalToken)
  })

  it('provides an empty summary before the first login', async () => {
    rmSync(join(directory, 'config.json'))
    await run('config', 'show')
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)).toEqual({
      server: null, default_connection: null, token_configured: false,
    })
    expect(process.exitCode).toBe(0)
  })

  it('redacts historical server URLs containing secrets', async () => {
    writeFileSync(join(directory, 'config.json'), JSON.stringify({
      server: 'https://user:fixture-historical-secret@example.invalid/?token=fixture-query-secret',
      token: originalToken,
    }))
    await run('config', 'show')
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string).server).toBeNull()
    expect(output()).not.toContain('fixture-historical-secret')
    expect(output()).not.toContain('fixture-query-secret')
    expect(output()).not.toContain(originalToken)
  })

  it('reports malformed configuration without including its contents', async () => {
    writeFileSync(join(directory, 'config.json'), '{"token":"fixture-malformed-secret"')
    await run('config', 'show')
    expect(process.exitCode).toBe(1)
    expect(output()).not.toContain('fixture-malformed-secret')
  })

  it('clears the default when changing the server and preserves a normalized unchanged address', async () => {
    await run('config', 'set', 'server', ' https://original.invalid/// ')
    expect(readConfig().defaultConnection).toBe('fixture-connection')
    await run('config', 'set', 'server', 'https://new.invalid/bridge/')
    expect(readConfig()).toEqual({ server: 'https://new.invalid/bridge', token: originalToken })
  })

  it('clears the default when changing the token and never echoes the new token', async () => {
    await run('config', 'set', 'token', 'fixture-replacement-secret')
    expect(readConfig()).toEqual({ server: 'https://original.invalid', token: 'fixture-replacement-secret' })
    expect(output()).not.toContain('fixture-replacement-secret')
  })

  it('applies the same safe address validation to config set', async () => {
    const before = readConfig()
    await run('config', 'set', 'server', 'https://fixture-config-secret@example.invalid')
    expect(process.exitCode).toBe(2)
    expect(readConfig()).toEqual(before)
    expect(output()).not.toContain('fixture-config-secret')
  })
})

describe('bounded and hidden token input', () => {
  it('reads one line and ignores subsequent input', async () => {
    const input = new PassThrough()
    const pending = prompts.readTokenFromStdin(input)
    input.end(' fixture-piped-token \r\nignored\n')
    expect(await pending).toBe('fixture-piped-token')
    expect(input.listenerCount('data')).toBe(0)
  })

  it('accepts EOF as a terminator', async () => {
    const input = new PassThrough()
    const pending = prompts.readTokenFromStdin(input)
    input.end('fixture-no-newline-token')
    expect(await pending).toBe('fixture-no-newline-token')
  })

  it('rejects tokens larger than 4096 bytes without disclosing them', async () => {
    const input = new PassThrough()
    const pending = prompts.readTokenFromStdin(input)
    const rejected = expect(pending).rejects.toThrow('令牌过长')
    input.end('x'.repeat(4097))
    await rejected
    expect(input.listenerCount('data')).toBe(0)
  })

  it('bounds how long stdin can wait and cleans up listeners', async () => {
    vi.useFakeTimers()
    const input = new PassThrough()
    const pending = prompts.readTokenFromStdin(input, 30_000)
    const rejected = expect(pending).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
    expect(input.listenerCount('data')).toBe(0)
    expect(input.listenerCount('end')).toBe(0)
    expect(input.listenerCount('error')).toBe(0)
  })

  it('accepts interactive editing while suppressing all token echo', async () => {
    // readline disables editing for TERM=dumb, which is common in CI shells.
    vi.stubEnv('TERM', 'xterm-256color')
    const input = new PassThrough()
    let displayed = ''
    const sink = new Writable({ write(chunk, _encoding, done) { displayed += chunk.toString(); done() } })
    const pending = prompts.promptInput('客户端令牌: ', { hidden: true, input, output: sink })
    input.write('fixture-hidden-tokex\u007fn\r')
    expect(await pending).toBe('fixture-hidden-token')
    expect(displayed).toBe('客户端令牌: \n')
    expect(displayed).not.toContain('fixture-hidden')
  })

  it('cancels hidden input without exposing typed characters', async () => {
    const input = new PassThrough()
    let displayed = ''
    const sink = new Writable({ write(chunk, _encoding, done) { displayed += chunk.toString(); done() } })
    const pending = prompts.promptInput('客户端令牌: ', { hidden: true, input, output: sink })
    const rejected = expect(pending).rejects.toThrow('已取消')
    input.write('fixture-partial-secret\u0003')
    await rejected
    expect(displayed).not.toContain('fixture-partial-secret')
  })
})
