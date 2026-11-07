import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { authApi, type AuthStatus } from '../lib/api'
import { ApiError, describeAuthError } from '../lib/http'
import { currentWebAuthnEnv, describeWebAuthnError, passkeySupport } from '../lib/webauthn'
import { HelpTip } from '../components/HelpTip'
import './spatial-secondary.css'

/** 安全设置：Passkey 列表与注册、TOTP 启用 / 停用 / 重新绑定（设计方案 §8.2） */
export function SecurityPage({ status, embedded = false }: { status: AuthStatus; embedded?: boolean }) {
  return (
    <section className={embedded ? 'settings-security' : undefined}>
      <div className="section-head">
        <div>
          <div className="help-heading">{embedded ? <h2>安全设置</h2> : <h1>安全设置</h1>}<HelpTip label="验证方式">敏感操作需要二次验证。已有 Passkey 时必须使用 Passkey；只有 TOTP 时需要密码和验证码。远程登录、导入 Cookie、签发令牌、修改授权和认证设置均受此保护。</HelpTip></div>
          {status.stepUp && <p className="muted small">当前会话已验证。</p>}
        </div>
      </div>
      <div className="secondary-security-grid">
        <section className="secondary-security-section" aria-label="Passkey 管理"><PasskeySection embedded={embedded} /></section>
        <section className="secondary-security-section" aria-label="TOTP 管理"><TotpSection enabled={status.totpEnabled} embedded={embedded} /></section>
      </div>
    </section>
  )
}

function PasskeySection({ embedded }: { embedded: boolean }) {
  const qc = useQueryClient()
  const support = passkeySupport(currentWebAuthnEnv())

  const passkeys = useQuery({
    queryKey: ['passkeys'],
    queryFn: authApi.listPasskeys,
    enabled: support.available,
  })

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['passkeys'] })
    void qc.invalidateQueries({ queryKey: ['auth-status'] })
  }

  const register = useMutation({ mutationFn: authApi.registerPasskey, onSuccess: refresh })
  const remove = useMutation({ mutationFn: authApi.deletePasskey, onSuccess: refresh })

  const errorText = (e: unknown) => (e instanceof ApiError ? describeAuthError(e) : describeWebAuthnError(e))

  return (
    <>
      {embedded ? <h3>Passkey</h3> : <h2>Passkey</h2>}
      {!support.available ? (
        <div className="card">
          <p className="muted">{support.message}</p>
          {support.reason === 'insecure_context' && (
            <p className="muted small">通过 http://IP 访问时浏览器会禁用 WebAuthn。配置域名与 HTTPS 后再回来注册。</p>
          )}
        </div>
      ) : (
        <div className="card">
          {passkeys.isPending && <p className="muted">正在读取…</p>}
          {passkeys.isError && <p className="error-text">读取失败：{describeAuthError(passkeys.error)}</p>}
          {passkeys.data && passkeys.data.passkeys.length === 0 && (
            <p className="muted">还没有注册 Passkey。</p>
          )}
          {passkeys.data && passkeys.data.passkeys.length > 0 && (
            <ul className="plain-list">
              {passkeys.data.passkeys.map((p) => (
                <li key={p.id} className="card-row">
                  <div>
                    <p className="mono small">{shortId(p.id)}</p>
                    <p className="muted small">注册于 {formatTime(p.createdAt)}</p>
                  </div>
                  <button
                    className="danger"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (window.confirm('删除这个 Passkey？删除后它不能再用于二次验证。')) remove.mutate(p.id)
                    }}
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
          )}
          {register.isError && <p className="error-text">{errorText(register.error)}</p>}
          {remove.isError && <p className="error-text">删除失败：{errorText(remove.error)}</p>}
          <div className="card-actions">
            <button className="primary" onClick={() => register.mutate()} disabled={register.isPending}>
              {register.isPending ? '等待设备确认…' : '注册新 Passkey'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}

function TotpSection({ enabled, embedded }: { enabled: boolean; embedded: boolean }) {
  const qc = useQueryClient()
  const [enrollment, setEnrollment] = useState<{ secretBase32: string; otpauthUrl: string } | null>(null)
  const [confirmCode, setConfirmCode] = useState('')

  const refreshStatus = () => void qc.invalidateQueries({ queryKey: ['auth-status'] })

  // 已启用时重新 enroll 会被 server 要求二次验证，api 层会自动弹框并重试
  const enroll = useMutation({
    mutationFn: authApi.enrollTotp,
    onSuccess: (r) => {
      confirm.reset()
      setConfirmCode('')
      setEnrollment({ secretBase32: r.secretBase32, otpauthUrl: r.otpauthUrl })
    },
  })

  const confirm = useMutation({
    mutationFn: () => authApi.confirmTotp(confirmCode.trim()),
    onSuccess: () => {
      setEnrollment(null)
      setConfirmCode('')
      refreshStatus()
    },
  })

  const disable = useMutation({
    mutationFn: () => authApi.disableTotp(),
    onSuccess: () => {
      refreshStatus()
    },
  })

  return (
    <>
      {embedded ? <h3>TOTP 验证码</h3> : <h2>TOTP 验证码</h2>}
      <div className="card">
        <div className="card-row">
          <div>
            <p className="card-title">{enabled ? '已启用' : '未启用'}</p>
            <p className="muted small">
              {enabled
                ? '登录与二次验证时需要填写验证器 App 里的 6 位数字。'
                : '使用 Google Authenticator、1Password 等验证器 App 绑定。'}
            </p>
          </div>
        </div>

        {enrollment ? (
          <div className="totp-enrollment">
            <div className="totp-enrollment-layout">
              <div className="totp-qr">
                <QRCodeSVG
                  className="totp-qr-code"
                  role="img"
                  aria-label="TOTP 绑定二维码"
                  value={enrollment.otpauthUrl}
                  size={208}
                  level="M"
                  marginSize={4}
                  bgColor="#FFFFFF"
                  fgColor="#000000"
                />
              </div>
              <form
                className="form tight totp-confirm-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  confirm.mutate()
                }}
              >
                <p className="muted small">用验证器 App 扫码，再输入验证码。</p>
                <label>
                  App 显示的验证码
                  <input
                    value={confirmCode}
                    onChange={(e) => setConfirmCode(e.target.value)}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6,8}"
                    placeholder="6 位数字"
                    required
                  />
                </label>
                {confirm.isError && <p className="error-text">{describeAuthError(confirm.error)}</p>}
                <div className="card-actions">
                  <button className="primary" type="submit" disabled={confirm.isPending}>
                    {confirm.isPending ? '确认中…' : '确认启用'}
                  </button>
                  <button type="button" disabled={confirm.isPending} onClick={() => { setEnrollment(null); setConfirmCode(''); confirm.reset() }}>取消绑定</button>
                </div>
              </form>
            </div>
            <details className="totp-manual field-help">
              <summary>无法扫码？手动添加</summary>
              <div className="form tight">
                <label>密钥<code className="secret">{enrollment.secretBase32}</code></label>
                <label>otpauth 链接<code className="secret">{enrollment.otpauthUrl}</code></label>
              </div>
            </details>
            {enabled && (
              <p className="muted small">确认新验证码后才会更换密钥；此前旧验证器仍然有效。此绑定流程 10 分钟后过期。</p>
            )}
          </div>
        ) : enabled ? (
          <form
            className="form tight"
            onSubmit={(e) => {
              e.preventDefault()
              disable.mutate()
            }}
          >
            <p className="muted small">停用或重新绑定前需验证当前身份。丢失验证码时可使用已注册的 Passkey。</p>
            {disable.isError && <p className="error-text">{describeAuthError(disable.error)}</p>}
            {enroll.isError && <p className="error-text">{describeAuthError(enroll.error)}</p>}
            <div className="card-actions">
              <button className="danger" type="submit" disabled={disable.isPending}>
                {disable.isPending ? '停用中…' : '停用 TOTP'}
              </button>
              <button type="button" onClick={() => enroll.mutate()} disabled={enroll.isPending}>
                {enroll.isPending ? '生成中…' : '重新绑定（换手机）'}
              </button>
            </div>
          </form>
        ) : (
          <>
            {enroll.isError && <p className="error-text">{describeAuthError(enroll.error)}</p>}
            <div className="card-actions">
              <button className="primary" onClick={() => enroll.mutate()} disabled={enroll.isPending}>
                {enroll.isPending ? '生成中…' : '启用 TOTP'}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  )
}

function shortId(id: string): string {
  return id.length > 20 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}
