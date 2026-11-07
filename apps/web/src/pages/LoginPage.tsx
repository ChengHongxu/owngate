import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { authApi, ApiError } from '../lib/api'
import { describeAuthError } from '../lib/http'
import { currentWebAuthnEnv, describeWebAuthnError, passkeySupport } from '../lib/webauthn'
import { BrandMark } from '../components/BrandMark'
import { Icon } from '../components/Icon'

/** 首次使用：创建唯一的管理员（/auth/bootstrap） */
export function BootstrapPage({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [localError, setLocalError] = useState('')

  const create = useMutation({
    mutationFn: () => authApi.bootstrap(username.trim(), password),
    onSuccess: onDone,
  })

  return (
    <div className="auth-shell">
      <form
        className="card form"
        onSubmit={(e) => {
          e.preventDefault()
          setLocalError('')
          if (password.length < 8) return setLocalError('密码至少 8 位。')
          if (password !== confirm) return setLocalError('两次输入的密码不一致。')
          create.mutate()
        }}
      >
        <div>
          <p className="brand-static"><BrandMark /><span>OwnGate</span></p>
          <h1>创建管理员</h1>
          <p className="muted small">这是唯一的后台账号。忘记密码只能在宿主机上执行 owngate admin reset-password。</p>
        </div>
        <label>
          用户名
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          密码（至少 8 位）
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        <label>
          再输一次
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        {(localError || create.isError) && (
          <p className="error-text">{localError || describeAuthError(create.error)}</p>
        )}
        <div className="card-actions">
          <button className="primary" type="submit" disabled={create.isPending}>
            <Icon name="add" />
            {create.isPending ? '创建中…' : '创建并登录'}
          </button>
        </div>
        <p className="muted small">登录后建议到「安全设置」启用 TOTP 或 Passkey，远程登录、导入 cookie 等操作需要二次验证。</p>
      </form>
    </div>
  )
}

/** 登录：用户名 + 密码；账号启用了 TOTP 时 server 回 TOTP_REQUIRED，再显示验证码框 */
export function LoginPage({ onDone, notice }: { onDone: () => void; notice?: string }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [needTotp, setNeedTotp] = useState(false)
  const support = passkeySupport(currentWebAuthnEnv())
  const passkeyLogin = useMutation({ mutationFn: () => authApi.loginPasskey(username.trim(), password), onSuccess: onDone })

  const login = useMutation({
    mutationFn: () =>
      authApi.login({
        username: username.trim(),
        password,
        ...(needTotp && totp.trim() !== '' ? { totp: totp.trim() } : {}),
      }),
    onSuccess: onDone,
    onError: (err) => {
      if (err instanceof ApiError && (err.code === 'TOTP_REQUIRED' || err.code === 'TOTP_INVALID')) {
        setNeedTotp(true)
      }
    },
  })

  const showError =
    login.isError && !(login.error instanceof ApiError && login.error.code === 'TOTP_REQUIRED' && totp === '')

  return (
    <div className="auth-shell">
      <form
        className="card form"
        onSubmit={(e) => {
          e.preventDefault()
          login.mutate()
        }}
      >
        <div>
          <p className="brand-static"><BrandMark /><span>OwnGate</span></p>
          <h1>登录后台</h1>
          {notice && <p className="muted small">{notice}</p>}
        </div>
        <label>
          用户名
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          密码
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {needTotp && (
          <label>
            TOTP 验证码
            <input
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6,8}"
              placeholder="验证器 App 里的 6 位数字"
              required
              autoFocus
            />
          </label>
        )}
        {needTotp && !showError && <p className="muted small">该账号已启用 TOTP，请填写验证码。</p>}
        {showError && <p className="error-text">{describeAuthError(login.error)}</p>}
        {passkeyLogin.isError && <p className="error-text">{passkeyLogin.error instanceof ApiError ? describeAuthError(passkeyLogin.error) : describeWebAuthnError(passkeyLogin.error)}</p>}
        <div className="card-actions">
          <button className="primary" type="submit" disabled={login.isPending || passkeyLogin.isPending}>
            <Icon name="login" />
            {login.isPending ? '登录中…' : '登录'}
          </button>
          {support.available && <button type="button" disabled={login.isPending || passkeyLogin.isPending || !username.trim() || !password} onClick={() => passkeyLogin.mutate()}>
            <Icon name="key" />
            {passkeyLogin.isPending ? '等待 Passkey…' : '用密码 + Passkey 登录'}
          </button>}
        </div>
        <p className="muted small">丢失 TOTP 验证器时，可使用密码和已注册的 Passkey 登录，再到安全设置重新绑定。{!support.available ? ' Passkey 登录需通过 HTTPS 域名或 localhost 访问。' : ''}</p>
      </form>
    </div>
  )
}
