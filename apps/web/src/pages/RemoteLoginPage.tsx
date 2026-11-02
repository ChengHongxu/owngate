import { useEffect, useRef, useState } from 'react'
import { api, openScreenSocket } from '../lib/api'

interface Frame {
  type: 'frame' | 'qr'
  data: string // base64
  ts: number
}

/**
 * 远程登录画面（设计方案 §4.4.3）
 * - 交互帧：CDP screencast 的 JPEG 帧，画在主 canvas 上
 * - 二维码：独立的高清 PNG 快照，放大显示在旁边，便于手机扫码
 */
export function RemoteLoginPage({ id, onBack }: { id: string; onBack: () => void }) {
  const [url, setUrl] = useState('')
  const [qrSelector, setQrSelector] = useState('')
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live' | 'ended' | 'error'>('idle')
  const [message, setMessage] = useState('')

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [qrImage, setQrImage] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [])

  async function start() {
    setStatus('connecting')
    setMessage('')
    try {
      const { ws_path } = await api.openScreen(
        id,
        url.trim(),
        qrSelector.trim() === '' ? undefined : qrSelector.trim(),
      )
      const ws = openScreenSocket(ws_path)
      wsRef.current = ws

      ws.onopen = () => setStatus('live')
      ws.onerror = () => {
        setStatus('error')
        setMessage('画面连接失败。下一步：检查 server 与 browser 容器是否都在运行。')
      }
      ws.onclose = () => setStatus((s) => (s === 'error' ? s : 'ended'))
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as Frame
        if (msg.type === 'frame') {
          drawFrame(msg.data)
        } else if (msg.type === 'qr') {
          setQrImage(`data:image/png;base64,${msg.data}`)
        }
      }
    } catch (e) {
      setStatus('error')
      setMessage((e as Error).message)
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
    wsRef.current?.close()
    wsRef.current = null
    try {
      await api.stopScreen(id)
    } finally {
      setStatus('ended')
    }
  }

  return (
    <section>
      <div className="section-head">
        <div>
          <button className="link" onClick={onBack}>← 返回</button>
          <h1>远程登录</h1>
          <p className="muted small">连接 {id}</p>
        </div>
        {status === 'live' && <button className="danger" onClick={() => void stop()}>结束</button>}
      </div>

      {status === 'idle' && (
        <form
          className="card form"
          onSubmit={(e) => {
            e.preventDefault()
            void start()
          }}
        >
          <label>
            登录页地址
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://passport.bilibili.com/login"
              required
            />
          </label>
          <label>
            二维码元素选择器（可选）
            <input
              value={qrSelector}
              onChange={(e) => setQrSelector(e.target.value)}
              placeholder="例如 .login-qrcode img"
            />
          </label>
          <div className="card-actions">
            <button className="primary" type="submit">打开登录窗口</button>
          </div>
        </form>
      )}

      {status === 'connecting' && <p className="muted">正在启动浏览器…</p>}
      {status === 'error' && (
        <div className="card error-card">
          <p className="card-title">无法打开画面</p>
          <p className="muted">{message}</p>
        </div>
      )}

      <div className={status === 'live' ? 'screen-layout' : 'screen-layout hidden'}>
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
