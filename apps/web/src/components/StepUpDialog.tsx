import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError, authApi, setStepUpPrompt, type AuthStatus } from '../lib/api'
import { describeAuthError } from '../lib/http'
import type { StepUpReason } from '../lib/http'
import { currentWebAuthnEnv, describeWebAuthnError, passkeySupport } from '../lib/webauthn'

/**
 * 二次验证对话框（设计方案 §7.2、§8.4）。
 * 挂载时向 api 层注册 prompt；任何请求返回 403 STEP_UP_REQUIRED 时由 api 层调起，
 * 验证成功后 api 层自动重试原请求一次。
 */
export function StepUpDialog({
  status,
  onOpenSecurity,
}: {
  status: AuthStatus
  onOpenSecurity: () => void
}) {
  const qc = useQueryClient()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const resolverRef = useRef<((ok: boolean) => void) | null>(null)
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [reason, setReason] = useState<StepUpReason>('step_up')
  const [busy, setBusy] = useState<'passkey' | 'totp' | 'setup' | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setStepUpPrompt(
      (promptReason) =>
        new Promise<boolean>((resolve) => {
          resolverRef.current = resolve
          setCode('')
          setPassword('')
          setReason(promptReason ?? 'step_up')
          setError('')
          setBusy(null)
          setOpen(true)
        }),
    )
    return () => {
      setStepUpPrompt(null)
      settle(false)
    }
  }, [])

  useEffect(() => {
    const d = dialogRef.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  function settle(ok: boolean) {
    const resolve = resolverRef.current
    resolverRef.current = null
    setOpen(false)
    setPassword('')
    setCode('')
    resolve?.(ok)
  }

  async function succeed() {
    // Complete this status read before retrying an operation that may revoke
    // the session, so a late response cannot swallow its success feedback.
    await qc.invalidateQueries({ queryKey: ['auth-status'] })
    settle(true)
  }

  async function viaPasskey() {
    setBusy('passkey')
    setError('')
    try {
      await authApi.stepUpPasskey()
      await succeed()
    } catch (e) {
      setError(e instanceof ApiError ? describeAuthError(e) : describeWebAuthnError(e))
    } finally {
      setBusy(null)
    }
  }

  async function viaTotp() {
    setBusy('totp')
    setError('')
    try {
      await authApi.stepUpTotp(code.trim(), password)
      await succeed()
    } catch (e) {
      setError(describeAuthError(e))
    } finally {
      setBusy(null)
    }
  }

  async function viaSetup() {
    setBusy('setup'); setError('')
    try { await authApi.proveSetupPassword(password); await succeed() }
    catch (e) { setError(describeAuthError(e)) }
    finally { setBusy(null) }
  }

  const support = passkeySupport(currentWebAuthnEnv())
  const canPasskey = reason !== 'setup' && support.available && status.passkeyCount > 0
  const canTotp = reason !== 'setup' && status.totpEnabled && status.passkeyCount === 0

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      onCancel={(e) => e.preventDefault()}
    >
      <div className="dialog-body">
        <p className="card-title">{reason === 'setup' ? '确认首次配置' : '需要二次验证'}</p>
        <p className="muted small">
          {reason === 'setup' ? '再次输入密码后，可在 5 分钟内配置第一种验证方式。此确认不授权其他敏感操作。' : '验证通过后 15 分钟内同类操作不再询问。已注册 Passkey 时须使用 Passkey。'}
        </p>

        {reason === 'setup' && <form className="form tight" onSubmit={(e) => { e.preventDefault(); void viaSetup() }}>
          <label>当前密码<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus /></label>
          <div className="card-actions"><button className="primary" type="submit" disabled={busy !== null}>{busy === 'setup' ? '验证中…' : '确认密码'}</button></div>
        </form>}

        {reason !== 'setup' && (support.available ? (
          status.passkeyCount > 0 ? (
            <div className="card-actions">
              <button className="primary" onClick={() => void viaPasskey()} disabled={busy !== null}>
                {busy === 'passkey' ? '等待 Passkey…' : '用 Passkey 验证'}
              </button>
            </div>
          ) : null
        ) : (
          <p className="muted small">{support.message}</p>
        ))}

        {canTotp && (
          <form
            className="form tight"
            onSubmit={(e) => {
              e.preventDefault()
              void viaTotp()
            }}
          >
            <label>当前密码<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
            <label>
              TOTP 验证码
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6,8}"
                placeholder="6 位数字"
                required
                autoFocus={!canPasskey}
              />
            </label>
            <div className="card-actions">
              <button className={canPasskey ? '' : 'primary'} type="submit" disabled={busy !== null}>
                {busy === 'totp' ? '验证中…' : '用验证码验证'}
              </button>
            </div>
          </form>
        )}

        {canTotp && <p className="muted small">密码与 TOTP 的保护等级较低：本机程序可能读取 TOTP 种子，建议注册 Passkey。</p>}
        {reason !== 'setup' && !canPasskey && !canTotp && (
          <div className="card error-card">
            <p className="muted">{status.passkeyCount > 0 ? '当前地址或浏览器无法使用已注册的 Passkey。' : '还没有可用的二次验证方式。'}</p>
            <p className="muted small">{status.passkeyCount > 0 ? '请通过 HTTPS 域名或支持 Passkey 的浏览器访问；全部设备丢失时需在宿主机恢复。' : `下一步：到「安全设置」启用 TOTP${support.available ? ' 或注册 Passkey' : ''}。`}</p>
            <div className="card-actions">
              <button
                onClick={() => {
                  settle(false)
                  onOpenSecurity()
                }}
              >
                去安全设置
              </button>
            </div>
          </div>
        )}

        {error && <p className="error-text">{error}</p>}

        <div className="card-actions dialog-foot">
          <button className="link" onClick={() => settle(false)}>取消</button>
        </div>
      </div>
    </dialog>
  )
}
