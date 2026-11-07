import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent, WheelEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, openScreenSocket } from '../lib/api'
import { describeAuthError } from '../lib/http'
import { isTerminalPhase, nextScreenPhase, screenPhaseAfterClose, screenPoint, SCREEN_POLL_INTERVAL_MS, type ScreenPhase } from '../lib/screen'
import { HelpTip } from '../components/HelpTip'
import { invalidateConnectionStatus } from '../lib/connection-status'

type Frame =
  | { type: 'frame'; data: string; ts: number; width: number; height: number }
  | { type: 'qr'; data: string | null; ts: number }

/**
 * 远程登录画面（设计方案 §4.4.3、§4.4.5）
 * - 登录页地址只取清单的 login.url，这里不能另填
 * - 交互帧：CDP screencast 的 JPEG 帧，画在主 canvas 上
 * - 二维码：独立的高清 PNG 快照，放大显示在旁边，便于手机扫码
 * - 每 2 秒轮询登录状态，success 时关闭画面
 */
export function RemoteLoginPage({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient()
  const [phase, setPhase] = useState<ScreenPhase>('idle')
  const [message, setMessage] = useState('')

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [qrImage, setQrImage] = useState<string | null>(null)
  const [inputText, setInputText] = useState('')
  const attemptRef = useRef(0)
  const frameSequenceRef = useRef(0)
  const drawnFrameSequenceRef = useRef(0)

  function closeSocket() {
    const ws = wsRef.current
    wsRef.current = null
    if (ws) {
      ws.onclose = null
      ws.onerror = null
      ws.onmessage = null
      ws.close()
    }
  }

  useEffect(() => () => { attemptRef.current++; closeSocket() }, [])

  // 画面打开后轮询登录状态
  useEffect(() => {
    if (phase !== 'live') return
    let stopped = false
    const timer = window.setInterval(() => {
      api
        .screenStatus(id)
        .then((s) => {
          if (stopped) return
          if (s.reason !== undefined) setMessage(s.reason)
          setPhase((p) => nextScreenPhase(p, s.status))
        })
        .catch(() => {
          // 单次轮询失败不打断画面，下一轮再试；401 由 api 层处理
        })
    }, SCREEN_POLL_INTERVAL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [phase, id])

  // 进入终态：关闭 socket；登录成功则刷新连接状态
  useEffect(() => {
    if (!isTerminalPhase(phase)) return
    closeSocket()
    if (phase === 'success') void invalidateConnectionStatus(qc)
  }, [phase, qc])

  async function start() {
    const attempt = ++attemptRef.current
    closeSocket()
    setPhase('connecting')
    setMessage('')
    setQrImage(null)
    try {
      const { ws_path } = await api.openScreen(id)
      if (attemptRef.current !== attempt) return
      const ws = openScreenSocket(ws_path)
      wsRef.current = ws

      const isCurrentSocket = () => attemptRef.current === attempt && wsRef.current === ws
      ws.onopen = () => {
        if (isCurrentSocket()) setPhase((p) => (p === 'connecting' ? 'live' : p))
      }
      ws.onerror = () => {
        if (!isCurrentSocket()) return
        setPhase('error')
        setMessage('画面连接失败。下一步：检查 server 与 browser 容器是否都在运行。')
      }
      ws.onclose = () => {
        if (wsRef.current !== ws || attemptRef.current !== attempt) return
        wsRef.current = null
        setPhase((p) => (p === 'live' || p === 'connecting' ? 'checking' : p))
        void api.screenStatus(id).then((status) => {
          if (attemptRef.current !== attempt) return
          if (status.reason) setMessage(status.reason)
          setPhase((p) => p === 'checking' ? screenPhaseAfterClose(status.status) : p)
        }).catch(() => {
          if (attemptRef.current === attempt) setPhase((p) => p === 'checking' ? 'ended' : p)
        })
      }
      ws.onmessage = (ev) => {
        if (!isCurrentSocket()) return
        try {
          const msg = JSON.parse(ev.data as string) as Frame | { type: 'input_error'; message: string }
          if (msg.type === 'frame') drawFrame(msg, attempt, ws)
          else if (msg.type === 'qr') setQrImage(msg.data ? `data:image/png;base64,${msg.data}` : null)
          else if (msg.type === 'input_error') setMessage(msg.message)
        } catch { /* Ignore malformed frames without interrupting login. */ }
      }
    } catch (e) {
      if (attemptRef.current !== attempt) return
      setPhase('error')
      setMessage(describeAuthError(e))
    }
  }

  function drawFrame(frame: Extract<Frame, { type: 'frame' }>, attempt: number, ws: WebSocket) {
    if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) ||
        frame.width <= 0 || frame.height <= 0 || typeof frame.data !== 'string') return
    const sequence = ++frameSequenceRef.current
    const img = new Image()
    img.onload = () => {
      // QR snapshots can cause Chromium to emit a cropped screencast image.
      // Keep the last complete viewport instead of enlarging a crop to fill it.
      if (attemptRef.current !== attempt || wsRef.current !== ws ||
          sequence <= drawnFrameSequenceRef.current ||
          img.naturalWidth !== frame.width || img.naturalHeight !== frame.height) return
      const canvas = canvasRef.current
      if (!canvas) return
      if (canvas.width !== frame.width) canvas.width = frame.width
      if (canvas.height !== frame.height) canvas.height = frame.height
      canvas.getContext('2d')?.drawImage(img, 0, 0)
      drawnFrameSequenceRef.current = sequence
    }
    img.src = `data:image/jpeg;base64,${frame.data}`
  }

  async function stop() {
    attemptRef.current++
    closeSocket()
    setPhase('ended')
    try {
      await api.stopScreen(id)
    } catch {
      // 画面已关闭；worker 侧 15 分钟无操作也会自动回收
    }
  }

  function sendInput(event: Record<string, unknown>) {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'input', event }))
  }

  function pointer(event: PointerEvent<HTMLCanvasElement>, kind: 'mousePressed' | 'mouseReleased' | 'mouseMoved') {
    const canvas = event.currentTarget
    const point = screenPoint(event.clientX, event.clientY, canvas.getBoundingClientRect(), canvas)
    if (!point) return
    if (kind === 'mousePressed') {
      canvas.focus()
      canvas.setPointerCapture(event.pointerId)
      event.preventDefault()
    }
    sendInput({ type: 'mouse', event: kind, ...point, button: ['left', 'middle', 'right'][event.button] ?? 'none', buttons: event.buttons, clickCount: kind === 'mouseMoved' ? 0 : 1 })
  }

  function keyboard(event: KeyboardEvent<HTMLCanvasElement>, kind: 'keyDown' | 'keyUp') {
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    const modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
    sendInput({ type: 'key', event: kind, key: event.key, code: event.code, keyCode: event.keyCode, modifiers, text: kind === 'keyDown' && event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey ? event.key : '' })
  }

  function wheel(event: WheelEvent<HTMLCanvasElement>) {
    const point = screenPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), event.currentTarget)
    if (point) sendInput({ type: 'wheel', ...point, deltaX: Math.max(-10_000, Math.min(10_000, event.deltaX)), deltaY: Math.max(-10_000, Math.min(10_000, event.deltaY)) })
  }

  const canStart = phase === 'idle' || phase === 'timeout' || phase === 'ended' || phase === 'error'

  return (
    <section>
      <div className="section-head">
        <div>
          <button className="link" onClick={onBack}>← 返回</button>
          <div className="help-heading"><h1>远程登录</h1><HelpTip label="远程登录说明">登录页由连接器配置指定，在服务器上的独立浏览器中打开。使用下方画面扫码或输入账号，二维码会单独放大显示。登录成功后自动关闭画面并保存登录态。</HelpTip></div>
          <p className="muted small">连接 {id}</p>
        </div>
        {phase === 'live' && <button className="danger" onClick={() => void stop()}>结束</button>}
      </div>

      {phase === 'idle' && (
        <div className="card">
          <p className="muted small">打开前需要二次验证。</p>
          <div className="card-actions">
            <button className="primary" onClick={() => void start()}>打开登录窗口</button>
          </div>
        </div>
      )}

      {phase === 'connecting' && <p className="muted">正在启动浏览器…</p>}
      {phase === 'checking' && <p className="muted">正在确认登录结果…</p>}
      {phase === 'live' && <p className="muted small">等待登录完成…</p>}
      {phase === 'live' && message && <p className="muted small" role="status">{message}</p>}

      {phase === 'success' && (
        <div className="card">
          <p className="card-title status-ok-text">✓ 登录成功</p>
          {message && <p className="muted">{message}</p>}
          <p className="muted small">画面已关闭，登录态已保存。</p>
          <div className="card-actions">
            <button className="primary" onClick={onBack}>返回连接</button>
          </div>
        </div>
      )}

      {phase === 'timeout' && (
        <div className="card error-card">
          <p className="card-title">登录等待超时</p>
          {message && <p className="muted">{message}</p>}
          <p className="muted">下一步：点「重新打开」再试一次。</p>
        </div>
      )}

      {phase === 'ended' && (
        <div className="card">
          <p className="muted">画面已关闭。</p>
        </div>
      )}

      {phase === 'error' && (
        <div className="card error-card">
          <p className="card-title">无法打开画面</p>
          <p className="muted">{message}</p>
        </div>
      )}

      {canStart && phase !== 'idle' && (
        <div className="card-actions">
          <button className={phase === 'timeout' ? 'primary' : ''} onClick={() => void start()}>
            重新打开
          </button>
        </div>
      )}

      <div className={phase === 'live' ? 'screen-layout' : 'screen-layout hidden'}>
        <div>
          <canvas ref={canvasRef} className="screen-canvas" tabIndex={0} aria-label="远程登录页面，点击后可使用键盘输入"
            onPointerDown={(e) => pointer(e, 'mousePressed')} onPointerUp={(e) => pointer(e, 'mouseReleased')} onPointerMove={(e) => pointer(e, 'mouseMoved')}
            onKeyDown={(e) => keyboard(e, 'keyDown')} onKeyUp={(e) => keyboard(e, 'keyUp')} onWheel={wheel}
            onContextMenu={(e) => e.preventDefault()} onPaste={(e) => { e.preventDefault(); sendInput({ type: 'text', text: e.clipboardData.getData('text').slice(0, 4096) }) }} />
          <div className="card-actions">
            <button onClick={() => sendInput({ type: 'reload' })}>刷新登录页</button>
            <input aria-label="输入到远程页面的文字" placeholder="中文或粘贴文字" value={inputText} maxLength={4096} onChange={(e) => setInputText(e.target.value)} />
            <button disabled={!inputText} onClick={() => { sendInput({ type: 'text', text: inputText }); setInputText('') }}>输入到页面</button>
          </div>
        </div>
        <aside className="qr-panel">
          <p className="card-title">二维码</p>
          {qrImage ? (
            <img src={qrImage} alt="登录二维码（放大）" className="qr-image" />
          ) : (
            <p className="muted small">尚未检测到二维码</p>
          )}
        </aside>
      </div>
    </section>
  )
}
