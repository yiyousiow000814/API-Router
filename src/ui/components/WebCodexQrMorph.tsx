import { useEffect, useMemo, useRef } from 'react'
import QRCode from 'qrcode'

type Props = {
  ready: boolean
  value: string
  size?: number
}

type Particle = {
  originX: number
  originY: number
  targetX: number
  targetY: number
  x: number
  y: number
  vx: number
  vy: number
  phase: number
  swirl: number
  scale: number
}

type SpriteSet = {
  dust: HTMLCanvasElement
  core: HTMLCanvasElement
}

const PARTICLES_PER_MODULE = 10

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function createParticleSprites(): SpriteSet {
  const make = (size: number, painter: (ctx: CanvasRenderingContext2D, size: number) => void) => {
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (ctx) painter(ctx, size)
    return canvas
  }

  const dust = make(28, (ctx, size) => {
    const g = ctx.createRadialGradient(size * 0.5, size * 0.5, 0, size * 0.5, size * 0.5, size * 0.5)
    g.addColorStop(0, 'rgba(24,32,51,0.9)')
    g.addColorStop(0.28, 'rgba(24,32,51,0.44)')
    g.addColorStop(0.72, 'rgba(24,32,51,0.08)')
    g.addColorStop(1, 'rgba(24,32,51,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
  })

  const core = make(18, (ctx, size) => {
    const radius = size * 0.16
    ctx.fillStyle = 'rgba(24,32,51,0.98)'
    ctx.beginPath()
    const inset = size * 0.14
    const edge = size - inset * 2
    ctx.moveTo(inset + radius, inset)
    ctx.lineTo(inset + edge - radius, inset)
    ctx.quadraticCurveTo(inset + edge, inset, inset + edge, inset + radius)
    ctx.lineTo(inset + edge, inset + edge - radius)
    ctx.quadraticCurveTo(inset + edge, inset + edge, inset + edge - radius, inset + edge)
    ctx.lineTo(inset + radius, inset + edge)
    ctx.quadraticCurveTo(inset, inset + edge, inset, inset + edge - radius)
    ctx.lineTo(inset, inset + radius)
    ctx.quadraticCurveTo(inset, inset, inset + radius, inset)
    ctx.closePath()
    ctx.fill()
  })

  return { dust, core }
}

function buildParticles(value: string, size: number): Particle[] {
  const qr = QRCode.create(value || 'http://127.0.0.1:4000/codex-web', { errorCorrectionLevel: 'M' })
  const count = qr.modules.size
  const margin = size * 0.1
  const usable = size - margin * 2
  const cell = usable / count
  const particles: Particle[] = []
  const cx = size * 0.5
  const cy = size * 0.5

  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.modules.get(row, col)) continue
      const centerX = margin + (col + 0.5) * cell
      const centerY = margin + (row + 0.5) * cell
      for (let i = 0; i < PARTICLES_PER_MODULE; i += 1) {
        const seed = row * 131 + col * 71 + i * 17
        const angle = seed * 0.173
        const radius = size * (0.06 + ((seed % 19) / 19) * 0.24)
        const bandOffset = ((seed % 7) - 3) * 2.8
        const originX = cx + Math.cos(angle) * radius + Math.sin(angle * 1.9) * bandOffset
        const originY = cy + Math.sin(angle * 1.07) * radius + Math.cos(angle * 1.3) * bandOffset
        const jitterX = (((seed % 5) - 2) / 2) * cell * 0.42
        const jitterY = ((((seed / 5) | 0) % 5) - 2) / 2 * cell * 0.42
        particles.push({
          originX,
          originY,
          targetX: centerX + jitterX,
          targetY: centerY + jitterY,
          x: originX,
          y: originY,
          vx: 0,
          vy: 0,
          phase: seed * 0.07,
          swirl: 0.7 + (seed % 11) * 0.08,
          scale: 0.52 + (seed % 13) * 0.035,
        })
      }
    }
  }

  return particles
}

export function WebCodexQrMorph({ ready, value, size = 150 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const particlesRef = useRef<Particle[]>([])
  const spritesRef = useRef<SpriteSet | null>(null)
  const readyProgressRef = useRef(ready ? 1 : 0)
  const targetReadyRef = useRef(ready ? 1 : 0)
  const valueKey = useMemo(() => `${value}|${size}`, [size, value])

  useEffect(() => {
    particlesRef.current = buildParticles(value, size)
  }, [size, valueKey])

  useEffect(() => {
    targetReadyRef.current = ready ? 1 : 0
  }, [ready])

  useEffect(() => {
    if (typeof document === 'undefined') return
    spritesRef.current = createParticleSprites()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const sprites = spritesRef.current
    if (!canvas || !sprites) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2))
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    canvas.style.width = `${size}px`
    canvas.style.height = `${size}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    let raf = 0
    let last = performance.now()

    const render = (now: number) => {
      const dt = Math.min(33, now - last) / 16.6667
      last = now
      const particles = particlesRef.current
      readyProgressRef.current += (targetReadyRef.current - readyProgressRef.current) * (0.062 * dt)
      const readiness = readyProgressRef.current
      const organize = smoothstep(0.08, 0.92, readiness)
      const sharpen = smoothstep(0.72, 0.995, readiness)
      const smoke = 1 - organize
      const tNow = now * 0.001
      const center = size * 0.5

      ctx.clearRect(0, 0, size, size)

      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i]
        const t = tNow + p.phase
        const flowA = Math.sin(t * 0.61 + p.originY * 0.032)
        const flowB = Math.cos(t * 0.77 + p.originX * 0.028)
        const flowX = (flowA + flowB * 0.6) * 7.5 * smoke
        const flowY = (Math.cos(t * 0.68 + p.originX * 0.021) + Math.sin(t * 0.57 + p.originY * 0.025) * 0.6) * 7.5 * smoke
        const orbit = 1 - Math.min(1, Math.hypot(p.x - center, p.y - center) / (size * 0.58))
        const swirlX = Math.cos(t * 0.93) * p.swirl * 4.8 * smoke + (-flowY * 0.42) * orbit
        const swirlY = Math.sin(t * 0.89) * p.swirl * 4.8 * smoke + (flowX * 0.42) * orbit
        const softX = p.originX + flowX + swirlX
        const softY = p.originY + flowY + swirlY
        const destX = softX * (1 - organize) + p.targetX * organize
        const destY = softY * (1 - organize) + p.targetY * organize

        const forceX = destX - p.x
        const forceY = destY - p.y
        const damping = 0.82 - organize * 0.1
        const attraction = 0.017 + organize * 0.09
        p.vx = p.vx * damping + forceX * attraction * dt
        p.vy = p.vy * damping + forceY * attraction * dt
        p.x += p.vx
        p.y += p.vy

        const dustSize = (4.4 + p.scale * 3.8) * (1 - sharpen * 0.3)
        const coreSize = 1.1 + p.scale * 1.6 + sharpen * 1.5
        const dustAlpha = 0.08 + smoke * 0.15 + (1 - sharpen) * 0.08
        const coreAlpha = 0.03 + organize * 0.22 + sharpen * 0.34

        ctx.globalAlpha = dustAlpha
        ctx.drawImage(sprites.dust, p.x - dustSize * 0.5, p.y - dustSize * 0.5, dustSize, dustSize)

        ctx.globalAlpha = coreAlpha
        ctx.drawImage(sprites.core, p.x - coreSize * 0.5, p.y - coreSize * 0.5, coreSize, coreSize)
      }

      ctx.globalAlpha = 1
      raf = requestAnimationFrame(render)
    }

    raf = requestAnimationFrame(render)
    return () => cancelAnimationFrame(raf)
  }, [size, valueKey])

  return <canvas ref={canvasRef} className="webCodexQrMorphCanvas" aria-label="Animated phone access QR" />
}
