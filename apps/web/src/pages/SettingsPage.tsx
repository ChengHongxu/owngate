import { useId, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Icon } from '../components/Icon'
import { PageDialog } from '../components/PageDialog'
import { QueryFailure } from '../components/RequestFeedback'
import { authApi, type AuthStatus } from '../lib/api'
import { describeAuthError } from '../lib/http'
import { useTheme } from '../lib/theme'
import { SecurityPage } from './SecurityPage'
import './settings.css'

type SettingsSection = 'account' | 'appearance' | 'security'
type AccountAction = 'username' | 'password'
type AccountChangeResult = { changed: boolean; requiresLogin: boolean }

const sections = [
  { id: 'account', to: '/settings', label: '账户', icon: 'user' },
  { id: 'appearance', to: '/settings/appearance', label: '外观', icon: 'sun' },
  { id: 'security', to: '/settings/security', label: '安全', icon: 'security' },
] as const

export function SettingsPage({ status, section }: { status: AuthStatus; section: SettingsSection }) {
  return <section className="settings-page">
    <h1>设置</h1>
    <nav className="settings-nav" aria-label="设置分类">
      {sections.map(item => <Link key={item.id} to={item.to} activeOptions={{ exact: true }}
        className={`settings-nav-link${section === item.id ? ' selected' : ''}`}
        aria-current={section === item.id ? 'page' : undefined}>
        <Icon name={item.icon} size={17} />{item.label}
      </Link>)}
    </nav>
    {section === 'account' && <AccountSettings />}
    {section === 'appearance' && <AppearanceSettings />}
    {section === 'security' && <SecurityPage status={status} embedded />}
  </section>
}

function AccountSettings() {
  const qc = useQueryClient()
  const [action, setAction] = useState<AccountAction | null>(null)
  const [completed, setCompleted] = useState<AccountAction | null>(null)
  const [notice, setNotice] = useState('')
  const account = useQuery({ queryKey: ['auth-account'], queryFn: authApi.account, enabled: completed === null })

  function saved(kind: AccountAction, result: AccountChangeResult) {
    setAction(null)
    if (result.requiresLogin) {
      setCompleted(kind)
      qc.removeQueries({ predicate: query => query.queryKey[0] !== 'auth-status' })
      return
    }
    setNotice(result.changed ? '账户已更新。' : kind === 'username' ? '登录名未变更。' : '密码未变更。')
    void qc.invalidateQueries({ queryKey: ['auth-account'] })
  }

  return <section className="settings-account" aria-labelledby="settings-account-title">
    <div className="settings-section-heading">
      <h2 id="settings-account-title">账户信息</h2>
      {account.data && <span className="muted small">创建于 {formatDate(account.data.createdAt)}</span>}
    </div>
    {!completed && account.isPending && <p className="muted" role="status">正在读取账户…</p>}
    {!completed && account.isError && <QueryFailure error={account.error} title="账户信息加载失败" pending={account.isFetching} retry={() => { void account.refetch() }} />}
    {account.data && <dl className="settings-account-details">
      <div className="settings-account-row">
        <dt>登录名</dt><dd>{account.data.username}</dd>
        <button type="button" onClick={() => { setNotice(''); setAction('username') }}><Icon name="edit" />修改登录名</button>
      </div>
      <div className="settings-account-row">
        <dt>密码</dt><dd><span className="settings-password-mask" aria-label="已设置登录密码">••••••••</span></dd>
        <button type="button" onClick={() => { setNotice(''); setAction('password') }}><Icon name="key" />修改密码</button>
      </div>
    </dl>}
    {notice && <p className="status-ok-text small" role="status">{notice}</p>}
    {action === 'username' && account.data && <EditUsernameDialog username={account.data.username} onClose={() => setAction(null)} onSaved={result => saved('username', result)} />}
    {action === 'password' && account.data && <ChangePasswordDialog username={account.data.username} onClose={() => setAction(null)} onSaved={result => saved('password', result)} />}
    {completed && <PageDialog title={completed === 'username' ? '登录名已更新' : '密码已更新'} dismissible={false} onClose={() => {}}>
      <div className="settings-complete" role="status"><span className="settings-complete-icon"><Icon name="check" size={22} /></span><p>请使用更新后的账户信息重新登录。</p></div>
      <div className="card-actions"><button type="button" className="primary" onClick={() => { void qc.invalidateQueries({ queryKey: ['auth-status'] }) }}><Icon name="login" />重新登录</button></div>
    </PageDialog>}
  </section>
}

function EditUsernameDialog({ username, onClose, onSaved }: { username: string; onClose: () => void; onSaved: (result: AccountChangeResult) => void }) {
  const [draft, setDraft] = useState(username)
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const nextUsername = draft.trim()
    if (!nextUsername || [...nextUsername].length > 128 || /[\p{Cc}\p{Cf}]/u.test(nextUsername)) {
      setError('登录名应为 1–128 个字符，不能包含控制字符。')
      return
    }
    setError('')
    setPending(true)
    try {
      const result = await authApi.updateAccount({ username: nextUsername, current_password: password })
      setPassword('')
      onSaved(result)
    } catch (cause) {
      setError(describeAuthError(cause))
    } finally {
      setPending(false)
    }
  }

  return <PageDialog title="修改登录名" onClose={onClose} dismissible={!pending}>
    <form className="form settings-account-form" onSubmit={submit} aria-busy={pending}>
      <label>登录名<input name="username" autoComplete="username" value={draft} onChange={event => setDraft(event.target.value)} maxLength={128} required disabled={pending} /></label>
      <label>当前密码<input type="password" name="current_password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} maxLength={1024} required disabled={pending} /></label>
      <p className="muted small">保存后需重新登录。</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="card-actions"><button className="primary" type="submit" disabled={pending}>{pending ? '保存中…' : '保存登录名'}</button><button type="button" disabled={pending} onClick={onClose}>取消</button></div>
    </form>
  </PageDialog>
}

function ChangePasswordDialog({ username, onClose, onSaved }: { username: string; onClose: () => void; onSaved: (result: AccountChangeResult) => void }) {
  const passwordHintId = useId()
  const [currentPassword, setCurrentPassword] = useState('')
  const [nextPassword, setNextPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    if ([...nextPassword].length < 8 || [...nextPassword].length > 1024) {
      setError('新密码应为 8–1024 个字符。')
      return
    }
    if (nextPassword !== confirmation) {
      setError('两次输入的新密码不一致。')
      return
    }
    setError('')
    setPending(true)
    try {
      const result = await authApi.changePassword({ current_password: currentPassword, new_password: nextPassword })
      setCurrentPassword('')
      setNextPassword('')
      setConfirmation('')
      onSaved(result)
    } catch (cause) {
      setError(describeAuthError(cause))
    } finally {
      setPending(false)
    }
  }

  return <PageDialog title="修改密码" onClose={onClose} dismissible={!pending}>
    <form className="form settings-account-form" onSubmit={submit} aria-busy={pending}>
      <input type="hidden" name="username" autoComplete="username" value={username} />
      <label>当前密码<input type="password" name="current_password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} maxLength={1024} required disabled={pending} /></label>
      <label>新密码<input type="password" name="new_password" autoComplete="new-password" value={nextPassword} onChange={event => setNextPassword(event.target.value)} minLength={8} maxLength={1024} aria-describedby={passwordHintId} required disabled={pending} /></label>
      <p className="muted small settings-password-hint" id={passwordHintId}>至少 8 个字符</p>
      <label>确认新密码<input type="password" name="confirm_password" autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} minLength={8} maxLength={1024} required disabled={pending} /></label>
      <p className="muted small">保存后需在所有设备上重新登录。</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="card-actions"><button className="primary" type="submit" disabled={pending}>{pending ? '保存中…' : '保存密码'}</button><button type="button" disabled={pending} onClick={onClose}>取消</button></div>
    </form>
  </PageDialog>
}

function AppearanceSettings() {
  const { preference, setPreference } = useTheme()
  const options = [
    { value: 'system', label: '跟随系统', icon: 'monitor' },
    { value: 'light', label: '浅色', icon: 'sun' },
    { value: 'dark', label: '深色', icon: 'moon' },
  ] as const

  return <section className="settings-appearance" aria-labelledby="settings-appearance-title">
    <div className="settings-section-heading"><h2 id="settings-appearance-title">主题</h2><span className="muted small">自动保存于当前浏览器</span></div>
    <fieldset className="settings-theme-options"><legend className="settings-sr-only">选择主题</legend>
      {options.map(option => <label key={option.value} className="settings-theme-option">
        <span className={`settings-theme-preview settings-theme-preview-${option.value}`} aria-hidden="true"><span className="settings-preview-sidebar"><i /><i /><i /></span><span className="settings-preview-content"><i /><span><i /><i /></span><i /></span></span>
        <span className="settings-theme-label"><Icon name={option.icon} size={17} /><span>{option.label}</span><input type="radio" name="theme" value={option.value} checked={preference === option.value} onChange={() => setPreference(option.value)} /></span>
      </label>)}
    </fieldset>
  </section>
}

function formatDate(iso: string) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}
