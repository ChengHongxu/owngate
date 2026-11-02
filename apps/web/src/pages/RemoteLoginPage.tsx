import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, openScreenSocket } from '../lib/api'
import { describeAuthError } from '../lib/http'
import { isTerminalPhase, nextScreenPhase, SCREEN_POLL_INTERVAL_MS, type ScreenPhase } from '../lib/screen'

interface Frame {
  type: 'frame' | 'qr'
  data: string // base64
  ts: number
}

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

  useEffect(() => closeSocket, [])

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
    if (phase === 'success') void qc.invalidateQueries({ queryKey: ['connections'] })
  }, [phase, qc])

  async function start() {
    closeSocket()
    setPhase('connecting')
    setMessage('')
    setQrImage(null)
    try {
      const { ws_path } = await api.openScreen(id)
      const ws = openScreenSocket(ws_path)
      wsRef.current = ws

      ws.onopen = () => setPhase((p) => (p === 'connecting' ? 'live' : p))
      ws.onerror = () => {
        setPhase('error')
        setMessage('画面连接失败。下一步：检查 server 与 browser 容器是否都在运行。')
      }
      ws.onclose = () => setPhase((p) => (p === 'live' || p === 'connecting' ? 'ended' : p))
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as Frame
        if (msg.type === 'frame') {
          drawFrame(msg.data)
        } else if (msg.type === 'qr') {
          setQrImage(`data:image/png;base64,${msg.data}`)
        }
      }
    } catch (e) {
      setPhase('error')
      setMessage(describeAuthError(e))
    }
  }

  function drawFrame(b64: string) {
    const img = new Image()
    img.onload = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = img.width
      canvas.height = img.height
      canvas.getContext('2d')?.drawImage(img, 0, 0)
    }
    img.src = `data:image/jpeg;base64,${b64}`
  }

  async function stop() {
    closeSocket()
    setPhase('ended')
    try {
      await api.stopScreen(id)
    } catch {
      // 画面已关闭；worker 侧 15 分钟无操作也会自动回收
    }
  }

  const canStart = phase === 'idle' || phase === 'timeout' || phase === 'ended' || phase === 'error'

  return (
    <section>
      <div className="section-head">
        <div>
          <button className="link" onClick={onBack}>← 返回</button>
          <h1>远程登录</h1>
          <p className="muted small">连接 {id} · 登录页地址取自连接器清单</p>
        </div>
        {phase === 'live' && <button className="danger" onClick={() => void stop()}>结束</button>}
      </div>

      {phase === 'idle' && (
        <div className="card">
          <p className="muted">
            会在服务器上的浏览器里打开该站点的登录页，你在下方画面里扫码或输入账号。打开前需要二次验证。
          </p>
          <div className="card-actions">
            <button className="primary" onClick={() => void start()}>打开登录窗口</button>
          </div>
        </div>
      )}

      {phase === 'connecting' && <p className="muted">正在启动浏览器…</p>}
      {phase === 'live' && <p className="muted small">等待登录完成… 每 2 秒检查一次。</p>}

      {phase === 'success' && (
        <div className="card">
          <p className="card-title status-ok-text">✓ 登录成功</p>
          {message && <p className="muted">{message}</p>}
          <p className="muted small">画面已关闭，登录态保存在该连接的浏览器 profile 中。</p>
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
        <canvas ref={canvasRef} className="screen-canvas" />
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
