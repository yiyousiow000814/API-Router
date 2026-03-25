type LoadingSurfaceProps = {
  eyebrow?: string
  title: string
  detail: string
  compact?: boolean
}

export function LoadingSurface({
  eyebrow = 'API Router',
  title,
  detail,
  compact = false,
}: LoadingSurfaceProps) {
  return (
    <div className={compact ? 'aoLoadingSurface aoLoadingSurfaceCompact' : 'aoLoadingSurface'}>
      <div className="aoLoadingOrb" aria-hidden="true">
        <span className="aoLoadingOrbCore" />
        <span className="aoLoadingOrbRing aoLoadingOrbRingOuter" />
        <span className="aoLoadingOrbRing aoLoadingOrbRingInner" />
      </div>
      <div className="aoLoadingCopy">
        <div className="aoLoadingEyebrow">{eyebrow}</div>
        <div className="aoLoadingTitle">{title}</div>
        <div className="aoLoadingDetail">{detail}</div>
      </div>
    </div>
  )
}
