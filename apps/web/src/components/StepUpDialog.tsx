import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError, authApi, setStepUpPrompt, type AuthStatus } from '../lib/api'
import { describeAuthError } from '../lib/http'
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
  const [busy, setBusy] = useState<'passkey' | 'totp' | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setStepUpPrompt(
      () =>
        new Promise<boolean>((resolve) => {
          resolverRef.current = resolve
          setCode('')
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
    resolve?.(ok)
  }

  function succeed() {
    void qc.invalidateQueries({ queryKey: ['auth-status'] })
    settle(true)
  }

  async function viaPasskey() {
    setBusy('passkey')
    setError('')
    try {
      await authApi.stepUpPasskey()
      succeed()
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
      await authApi.stepUpTotp(code.trim())
      succeed()
    } catch (e) {
      setError(describeAuthError(e))
    } finally {
      setBusy(null)
    }
  }

  const support = passkeySupport(currentWebAuthnEnv())
  const canPasskey = support.available && status.passkeyCount > 0
  const canTotp = status.totpEnabled

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      onCancel={(e) => {
        e.preventDefault()
        settle(false)
      }}
    >
      <div className="dialog-body">
        <p className="card-title">需要二次验证</p>
        <p className="muted small">
          这个操作会交出账号或数据。验证后 15 分钟内同类操作不再询问。
        </p>

        {support.available ? (
          status.passkeyCount > 0 ? (
            <div className="card-actions">
              <button className="primary" onClick={() => void viaPasskey()} disabled={busy !== null}>
                {busy === 'passkey' ? '等待 Passkey…' : '用 Passkey 验证'}
              </button>
            </div>
          ) : null
        ) : (
          <p className="muted small">{support.message}</p>
        )}

        {canTotp && (
          <form
            className="form tight"
            onSubmit={(e) => {
              e.preventDefault()
              void viaTotp()
            }}
          >
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

        {!canPasskey && !canTotp && (
          <div className="card error-card">
            <p className="muted">还没有可用的二次验证方式。</p>
            <p className="muted small">下一步：到「安全设置」启用 TOTP{support.available ? ' 或注册 Passkey' : ''}。</p>
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
