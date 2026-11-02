import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { authApi, type AuthStatus } from '../lib/api'
import { ApiError, describeAuthError } from '../lib/http'
import { currentWebAuthnEnv, describeWebAuthnError, passkeySupport } from '../lib/webauthn'

/** 安全设置：Passkey 列表与注册、TOTP 启用 / 停用 / 重新绑定（设计方案 §8.2） */
export function SecurityPage({ status }: { status: AuthStatus }) {
  return (
    <section>
      <div className="section-head">
        <div>
          <h1>安全设置</h1>
          <p className="muted small">
            远程登录、导入 cookie、签发令牌、修改授权需要二次验证（Passkey 或 TOTP）。
            {status.stepUp ? ' 当前会话已在 15 分钟内完成二次验证。' : ''}
          </p>
        </div>
      </div>
      <PasskeySection />
      <TotpSection enabled={status.totpEnabled} />
    </section>
  )
}

function PasskeySection() {
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
      <h2>Passkey</h2>
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

function TotpSection({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient()
  const [enrollment, setEnrollment] = useState<{ secretBase32: string; otpauthUrl: string } | null>(null)
  const [confirmCode, setConfirmCode] = useState('')
  const [disableCode, setDisableCode] = useState('')

  const refreshStatus = () => void qc.invalidateQueries({ queryKey: ['auth-status'] })

  // 已启用时重新 enroll 会被 server 要求二次验证，api 层会自动弹框并重试
  const enroll = useMutation({
    mutationFn: authApi.enrollTotp,
    onSuccess: (r) => {
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
    mutationFn: () => authApi.disableTotp(disableCode.trim()),
    onSuccess: () => {
      setDisableCode('')
      refreshStatus()
    },
  })

  return (
    <>
      <h2>TOTP 验证码</h2>
      <div className="card">
        <div className="card-row">
          <div>
            <p className="card-title">{enabled ? '已启用' : '未启用'}</p>
            <p className="muted small">
              {enabled
                ? '登录与二次验证时需要填写验证器 App 里的 6 位数字。'
                : '用 Google Authenticator、1Password 等验证器 App 绑定。不依赖 HTTPS，http://IP 下也可用。'}
            </p>
          </div>
        </div>

        {enrollment ? (
          <div className="form tight">
            <p className="muted small">在验证器 App 里选择「输入设置密钥」，填入下面的密钥；或把 otpauth 链接粘贴到支持的 App。</p>
            <label>
              密钥
              <code className="secret">{enrollment.secretBase32}</code>
            </label>
            <label>
              otpauth 链接
              <code className="secret">{enrollment.otpauthUrl}</code>
            </label>
            {enabled && (
              <p className="error-text">密钥已更换：旧验证器上的验证码从现在起不再有效，请立即完成绑定。</p>
            )}
            <form
              className="form tight"
              onSubmit={(e) => {
                e.preventDefault()
                confirm.mutate()
              }}
            >
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
                {!enabled && (
                  <button type="button" onClick={() => setEnrollment(null)}>
                    稍后再说
                  </button>
                )}
              </div>
            </form>
          </div>
        ) : enabled ? (
          <form
            className="form tight"
            onSubmit={(e) => {
              e.preventDefault()
              disable.mutate()
            }}
          >
            <label>
              停用需要当前验证码
              <input
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6,8}"
                placeholder="6 位数字"
                required
              />
            </label>
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
