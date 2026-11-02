// 远程登录画面的状态推进（纯函数）。
// 打开画面后每 2 秒轮询 GET /admin/screen/:id/status。

export type ScreenStatus = 'pending' | 'success' | 'timeout' | 'idle'

export type ScreenPhase = 'idle' | 'connecting' | 'live' | 'success' | 'timeout' | 'ended' | 'error'

export const SCREEN_POLL_INTERVAL_MS = 2000

/**
 * 根据一次轮询结果推进画面阶段。
 * - 只在 live 时响应：结束后迟到的轮询结果被忽略。
 * - pending / idle 保持 live：画面是否结束以 WebSocket 关闭为准，避免竞态误判。
 */
export function nextScreenPhase(phase: ScreenPhase, status: ScreenStatus): ScreenPhase {
  if (phase !== 'live') return phase
  if (status === 'success') return 'success'
  if (status === 'timeout') return 'timeout'
  return phase
}

/** 进入这些阶段就关闭画面 socket 并停止轮询 */
export function isTerminalPhase(phase: ScreenPhase): boolean {
  return phase === 'success' || phase === 'timeout' || phase === 'ended' || phase === 'error'
}
