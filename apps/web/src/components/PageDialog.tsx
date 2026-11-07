import { useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { Icon } from './Icon'
import './PageDialog.css'

interface PageDialogProps {
  title: string
  children: ReactNode
  onClose: () => void
  size?: 'normal' | 'wide'
  dismissible?: boolean
  footer?: ReactNode
  returnFocusRef?: RefObject<HTMLElement | null>
}

/** Native modality keeps the page inert; dismissal requires an explicit button. */
export function PageDialog({ title, children, onClose, size = 'normal', dismissible = true, footer, returnFocusRef }: PageDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const titleId = useId()

  useLayoutEffect(() => {
    const element = dialog.current
    if (!element) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    element.showModal()
    heading.current?.focus()
    const restoreAfterChild = (event: Event) => {
      if (event.target === element) return
      queueMicrotask(() => {
        if (!element.open || element.contains(document.activeElement)) return
        // Native restoration can fail when the control that opened an
        // identity check became disabled while its request was pending.
        const otherModal = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].some(other => other !== element)
        if (!otherModal) heading.current?.focus({ preventScroll: true })
      })
    }
    document.addEventListener('close', restoreAfterChild, true)
    return () => {
      document.removeEventListener('close', restoreAfterChild, true)
      element.close()
      // A following dialog may open in the same render (create -> setup).
      // Never steal focus from that dialog or a nested identity check.
      queueMicrotask(() => {
        if (document.querySelector('dialog[open]')) return
        const target = returnFocusRef?.current ?? opener
        if (target?.isConnected && !target.closest('[inert]')) target.focus({ preventScroll: true })
      })
    }
  }, [returnFocusRef])

  return <dialog ref={dialog} className={`page-dialog${size === 'wide' ? ' page-dialog-wide' : ''}`} aria-labelledby={titleId}
    onCancel={event => event.preventDefault()}>
    <header className="page-dialog-heading"><h2 id={titleId} ref={heading} tabIndex={-1}>{title}</h2><button className="page-dialog-close" type="button" aria-label={`关闭${title}`} disabled={!dismissible} onClick={onClose}><Icon name="close" size={20} /></button></header>
    <div className="page-dialog-content">{children}</div>
    {footer && <footer className="page-dialog-footer">{footer}</footer>}
  </dialog>
}
