import './BrandMark.css'

/** The private-domain mark shares its source with the favicon; surrounding text supplies its name. */
export function BrandMark({ size = 28, className = '' }: { size?: number; className?: string }) {
  return <img className={`brand-mark${className ? ` ${className}` : ''}`} src="/favicon.svg?v=owngate-d-1" width={size} height={size} alt="" aria-hidden="true" draggable={false} />
}
