import * as readline from 'node:readline'
import { Writable } from 'node:stream'
import { CliUsageError } from './errors.js'

export const MAX_TOKEN_BYTES = 4096
const INPUT_TIMEOUT_MS = 30_000

/** A server may include a deployment base path, but never credentials or a query. */
export function normalizeServerUrl(value: string): string {
  const candidate = value.trim()
  const invalid = () => new CliUsageError(
    '服务器地址无效。',
    '使用完整的 HTTP(S) 地址，可带部署路径；不要包含用户名、密码、查询参数或片段。',
  )
  if (!/^https?:\/\//i.test(candidate) || /[\u0000-\u0020\u007f\\]/.test(candidate)) throw invalid()
  let address: URL
  try { address = new URL(candidate) } catch { throw invalid() }
  const authority = candidate.slice(candidate.indexOf('//') + 2).split('/')[0] ?? ''
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password
    || authority.includes('@') || candidate.includes('?') || candidate.includes('#')) throw invalid()
  return address.href.replace(/\/+$/, '')
}

export function normalizeToken(value: string): string {
  const token = value.trim()
  if (!token || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES || /[\u0000-\u001f\u007f]/.test(token)) {
    throw new CliUsageError('客户端令牌为空或格式无效。', '从后台「客户端」复制有效令牌，或使用 --token-stdin 通过管道输入。')
  }
  return token
}

/** Only an explicit --token-stdin call should consume piped input. */
export function readTokenFromStdin(input: NodeJS.ReadableStream = process.stdin, timeoutMs = INPUT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.removeListener('data', onData)
      input.removeListener('end', onEnd)
      input.removeListener('error', onError)
      input.pause()
      if (error) reject(error)
      else {
        try { resolve(normalizeToken(buffer.toString('utf8'))) } catch (cause) { reject(cause) }
      }
    }
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
      const newline = bytes.findIndex((byte) => byte === 10 || byte === 13)
      const part = newline < 0 ? bytes : bytes.subarray(0, newline)
      if (buffer.length + part.length > MAX_TOKEN_BYTES) {
        finish(new CliUsageError('输入的客户端令牌过长。', `令牌不得超过 ${MAX_TOKEN_BYTES} 字节，请检查管道输入。`))
        return
      }
      buffer = Buffer.concat([buffer, part])
      if (newline >= 0) finish()
    }
    const onEnd = () => { finish() }
    const onError = () => { finish(new CliUsageError('无法读取标准输入中的令牌。', '检查管道输入后，重新运行 login --server <url> --token-stdin。')) }
    const timer = setTimeout(() => {
      finish(new CliUsageError('等待标准输入中的令牌超时。', '通过管道输入一行令牌，并以换行或 EOF 结束。'))
    }, timeoutMs)
    input.on('data', onData)
    input.once('end', onEnd)
    input.once('error', onError)
    input.resume()
  })
}

interface PromptOptions {
  hidden?: boolean
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  timeoutMs?: number
}

/** Let readline handle editing while a muted output prevents token echo. */
export function promptInput(question: string, options: PromptOptions = {}): Promise<string> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stderr
  const muted = options.hidden ? new Writable({ write(_chunk, _encoding, done) { done() } }) : undefined
  const rl = readline.createInterface({ input, output: muted ?? output, terminal: true })
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (answer?: string, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rl.removeListener('SIGINT', onCancel)
      rl.removeListener('close', onClose)
      rl.close()
      muted?.end()
      if (options.hidden) output.write('\n')
      if (error) reject(error)
      else resolve(answer?.trim() ?? '')
    }
    const onCancel = () => { finish(undefined, new CliUsageError('登录输入已取消。', '准备好服务器地址与客户端令牌后重新运行 owngate login。')) }
    const onClose = () => { finish(undefined, new CliUsageError('登录输入未完成。', '交互终端中运行 owngate login，或显式提供 --server 与 --token-stdin。')) }
    const timer = setTimeout(() => {
      finish(undefined, new CliUsageError('等待登录输入超时。', '准备好服务器地址与客户端令牌后重新运行 owngate login。'))
    }, options.timeoutMs ?? INPUT_TIMEOUT_MS)
    rl.once('SIGINT', onCancel)
    rl.once('close', onClose)
    if (options.hidden) output.write(question)
    rl.question(options.hidden ? '' : question, (answer) => { finish(answer) })
  })
}
