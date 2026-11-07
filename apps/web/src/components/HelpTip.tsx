import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { helpPosition } from '../lib/help-position'
import { Icon } from './Icon'
import './HelpTip.css'

/** Contextual text only: hover or focus to read, click to keep it open. */
export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const tooltip = useRef<HTMLDivElement>(null)
  const pinned = useRef(false)
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: -10_000, maxHeight: 0 })

  function cancelClose() { clearTimeout(closing.current) }
  function show() { cancelClose(); setOpen(true) }
  function dismiss() { cancelClose(); pinned.current = false; setOpen(false) }
  function scheduleClose() {
    cancelClose()
    if (!pinned.current) closing.current = setTimeout(() => setOpen(false), 150)
  }

  useEffect(() => () => clearTimeout(closing.current), [])
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const button = trigger.current, tip = tooltip.current
      if (!button || !tip) return
      const rect = button.getBoundingClientRect()
      const viewport = window.visualViewport
      setPosition(helpPosition(rect, { width: tip.offsetWidth, height: tip.scrollHeight }, {
        width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight,
      }))
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [open, children])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !tooltip.current?.contains(event.target)) dismiss()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); dismiss() }
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape) }
  }, [open])

  const container = trigger.current?.closest('dialog[open]') ?? (typeof document !== 'undefined' ? document.body : null)
  return <>
    <button ref={trigger} type="button" className="help-tip-button" aria-label={label} aria-expanded={open}
      aria-describedby={open ? id : undefined} aria-controls={open ? id : undefined}
      onPointerEnter={event => { if (event.pointerType !== 'touch') show() }} onPointerLeave={scheduleClose}
      onFocus={show} onBlur={() => { if (!pinned.current) scheduleClose() }}
      onClick={event => { event.stopPropagation(); cancelClose(); if (pinned.current) dismiss(); else { pinned.current = true; setOpen(true) } }}>
      <Icon name="help" size={16} />
    </button>
    {open && container && createPortal(<div ref={tooltip} id={id} role="tooltip" className="help-tip-popup" style={position}
      onPointerEnter={cancelClose} onPointerLeave={scheduleClose}>
      <strong>{label}</strong><div>{children}</div>
    </div>, container)}
  </>
}
