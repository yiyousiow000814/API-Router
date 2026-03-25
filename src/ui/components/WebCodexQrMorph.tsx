import { useEffect, useRef } from 'react'
import QRCode from 'qrcode'

type Props = {
  ready: boolean
  value: string
  size?: number
}

type Particle = {
  ambientX: number
  ambientY: number
  burstX: number
  burstY: number
  depth: number
  depthPhase: number
  driftBiasX: number
  driftBiasY: number
  driftRadius: number
  driftSeed: number
  qrX: number
  qrY: number
  scale: number
  vx: number
  vy: number
  x: number
  y: number
}

type QrModule = {
  x: number
  y: number
  size: number
}

type SpriteSet = {
  core: HTMLCanvasElement
}

const PARTICLES_PER_MODULE = 10
const VALUE_SWAP_RELEASE_READYNESS = 0.32
const AMBIENT_SAFE_INSET = 0.14

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function clampToInset(value: number, size: number) {
  const inset = size * AMBIENT_SAFE_INSET
  return Math.min(size - inset, Math.max(inset, value))
}

function spatialSort<T>(items: T[], getX: (item: T) => number, getY: (item: T) => number) {
  return [...items].sort((a, b) => {
    const ay = getY(a)
    const by = getY(b)
    if (Math.abs(ay - by) > 2.4) return ay - by
    return getX(a) - getX(b)
  })
}

function createParticleSprites(): SpriteSet {
  const canvas = document.createElement('canvas')
  canvas.width = 18
  canvas.height = 18
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const size = canvas.width
    const radius = size * 0.16
    const inset = size * 0.14
    const edge = size - inset * 2
    ctx.fillStyle = 'rgba(24,32,51,0.98)'
    ctx.beginPath()
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
  }
  return { core: canvas }
}

function createAmbientAnchor(index: number, total: number, size: number, seed: number) {
  const center = size * 0.5
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))
  const spread = Math.sqrt((index + 0.5) / Math.max(1, total))
  const angle = index * goldenAngle + seed * 0.031
  const radius = size * (0.08 + spread * 0.26)
  const jitterX = Math.sin(seed * 0.53) * size * 0.03
  const jitterY = Math.cos(seed * 0.47) * size * 0.03
  return {
    x: clampToInset(center + Math.cos(angle) * radius + jitterX, size),
    y: clampToInset(center + Math.sin(angle) * radius + jitterY, size),
  }
}

function buildQrModules(value: string, size: number): QrModule[] {
  const qr = QRCode.create(value || 'http://127.0.0.1:4000/codex-web', { errorCorrectionLevel: 'M' })
  const count = qr.modules.size
  const margin = size * 0.12
  const usable = size - margin * 2
  const cell = usable / count
  const modules: QrModule[] = []

  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.modules.get(row, col)) continue
      modules.push({
        x: margin + col * cell,
        y: margin + row * cell,
        size: cell,
      })
    }
  }

  return modules
}

function buildParticles(value: string, size: number): Particle[] {
  const qr = QRCode.create(value || 'http://127.0.0.1:4000/codex-web', { errorCorrectionLevel: 'M' })
  const count = qr.modules.size
  const margin = size * 0.12
  const usable = size - margin * 2
  const cell = usable / count
  const total = Array.from({ length: count * count }).reduce<number>((sum, _, flatIndex) => {
    const row = Math.floor(flatIndex / count)
    const col = flatIndex % count
    return sum + (qr.modules.get(row, col) ? PARTICLES_PER_MODULE : 0)
  }, 0)
  const particles: Particle[] = []

  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.modules.get(row, col)) continue
      const centerX = margin + (col + 0.5) * cell
      const centerY = margin + (row + 0.5) * cell

      for (let i = 0; i < PARTICLES_PER_MODULE; i += 1) {
        const seed = row * 131 + col * 71 + i * 17
        const jitterX = (((seed % 5) - 2) / 2) * cell * 0.42
        const jitterY = ((((seed / 5) | 0) % 5) - 2) / 2 * cell * 0.42
        const qrX = centerX + jitterX
        const qrY = centerY + jitterY
        const ambient = createAmbientAnchor(particles.length, total, size, seed)
        particles.push({
          ambientX: ambient.x,
          ambientY: ambient.y,
          burstX: ambient.x - qrX,
          burstY: ambient.y - qrY,
          depth: 0.58 + (seed % 17) / 17,
          depthPhase: seed * 0.043,
          driftBiasX: ((seed % 9) - 4) * 0.9,
          driftBiasY: ((((seed / 9) | 0) % 9) - 4) * 0.9,
          driftRadius: 10 + (seed % 13) * 1.35,
          driftSeed: seed * 0.13,
          qrX,
          qrY,
          scale: 0.58 + (seed % 11) * 0.06,
          vx: 0,
          vy: 0,
          x: qrX,
          y: qrY,
        })
      }
    }
  }

  return particles
}

function remapParticles(value: string, size: number, previous: Particle[]): Particle[] {
  const next = buildParticles(value, size)
  if (!previous.length) return next

  const previousSorted = spatialSort(previous, (item) => item.x, (item) => item.y)
  const nextSorted = spatialSort(next, (item) => item.qrX, (item) => item.qrY)

  for (let i = 0; i < nextSorted.length; i += 1) {
    const prior = previousSorted[i % previousSorted.length]
    nextSorted[i].x = prior.x
    nextSorted[i].y = prior.y
    nextSorted[i].vx = prior.vx
    nextSorted[i].vy = prior.vy
  }

  return next
}

export function WebCodexQrMorph({ ready, value, size = 150 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const particlesRef = useRef<Particle[]>([])
  const modulesRef = useRef<QrModule[]>([])
  const spritesRef = useRef<SpriteSet | null>(null)
  const readyProgressRef = useRef(ready ? 1 : 0)
  const targetReadyRef = useRef(ready ? 1 : 0)
  const activeValueRef = useRef(value)
  const pendingValueRef = useRef<string | null>(null)

  useEffect(() => {
    if (value === activeValueRef.current && particlesRef.current.length) return

    const currentReadiness = readyProgressRef.current
    const isHiding = !ready && currentReadiness > VALUE_SWAP_RELEASE_READYNESS
    if (isHiding && value !== activeValueRef.current) {
      pendingValueRef.current = value
      return
    }

    activeValueRef.current = value
    pendingValueRef.current = null
    modulesRef.current = buildQrModules(activeValueRef.current, size)
    particlesRef.current = remapParticles(activeValueRef.current, size, particlesRef.current)
  }, [ready, size, value])

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

      readyProgressRef.current += (targetReadyRef.current - readyProgressRef.current) * (0.064 * dt)
      const readiness = readyProgressRef.current
      if (
        pendingValueRef.current &&
        readiness <= VALUE_SWAP_RELEASE_READYNESS &&
        pendingValueRef.current !== activeValueRef.current
      ) {
        activeValueRef.current = pendingValueRef.current
        pendingValueRef.current = null
        modulesRef.current = buildQrModules(activeValueRef.current, size)
        particlesRef.current = remapParticles(activeValueRef.current, size, particlesRef.current)
      }

      const organize = smoothstep(0.14, 0.9, readiness)
      const sharpen = smoothstep(0.72, 0.97, readiness)
      const qrReveal = smoothstep(0.985, 0.998, readiness)
      const disperse = 1 - organize
      const nowSeconds = now * 0.001
      const particles = particlesRef.current
      const qrModules = modulesRef.current
      const cloudCenterX = size * 0.5 + Math.cos(nowSeconds * 0.21) * size * 0.025
      const cloudCenterY = size * 0.5 + Math.sin(nowSeconds * 0.17) * size * 0.02

      ctx.clearRect(0, 0, size, size)

      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i]
        const flowPhase = nowSeconds * (0.26 + p.scale * 0.03) + p.driftSeed * 0.41
        const orbitPhase = nowSeconds * (0.14 + p.depth * 0.025) + p.depthPhase
        const centerDx = p.ambientX - cloudCenterX
        const centerDy = p.ambientY - cloudCenterY
        const centerDist = Math.hypot(centerDx, centerDy)
        const centerFalloff = Math.max(0.18, 1 - centerDist / (size * 0.34))
        const streamX =
          Math.sin(flowPhase + p.ambientY * 0.01) * (2.3 + centerFalloff * 2.4 + p.depth * 0.7) +
          Math.cos(flowPhase * 0.57 + p.ambientX * 0.008) * (1 + centerFalloff * 1.2)
        const streamY =
          Math.cos(flowPhase * 0.83 - p.ambientX * 0.01) * (2.05 + centerFalloff * 2.1 + p.depth * 0.62) +
          Math.sin(flowPhase * 0.52 + p.ambientY * 0.008) * (0.92 + centerFalloff)
        const orbitX = -centerDy * (0.012 + centerFalloff * 0.018) + Math.cos(orbitPhase) * 0.7
        const orbitY = centerDx * (0.012 + centerFalloff * 0.018) + Math.sin(orbitPhase * 1.08) * 0.65
        const settleX = (cloudCenterX - p.ambientX) * 0.018
        const settleY = (cloudCenterY - p.ambientY) * 0.018
        const driftMixX = (streamX + orbitX + settleX) * disperse
        const driftMixY = (streamY + orbitY + settleY) * disperse
        const targetX = p.qrX + p.burstX * disperse + driftMixX
        const targetY = p.qrY + p.burstY * disperse + driftMixY

        const forceX = targetX - p.x
        const forceY = targetY - p.y
        const damping = 0.9 - organize * 0.045
        const attraction = 0.026 + organize * 0.11
        p.vx = p.vx * damping + forceX * attraction * dt
        p.vy = p.vy * damping + forceY * attraction * dt
        p.x += p.vx
        p.y += p.vy
        const coreSize = 1.12 + p.scale * 0.84 + p.depth * 0.58 + sharpen * 1.02
        const coreAlpha = 0.18 + p.depth * 0.08 + organize * 0.06
        ctx.globalAlpha = coreAlpha
        ctx.drawImage(sprites.core, p.x - coreSize * 0.5, p.y - coreSize * 0.5, coreSize, coreSize)
      }

      if (qrReveal > 0.001) {
        const moduleInset = 0.04
        ctx.globalAlpha = qrReveal
        ctx.fillStyle = 'rgba(24,32,51,0.98)'
        for (let i = 0; i < qrModules.length; i += 1) {
          const module = qrModules[i]
          const inset = module.size * moduleInset * (1 - qrReveal * 0.55)
          ctx.fillRect(
            module.x + inset,
            module.y + inset,
            Math.max(0, module.size - inset * 2),
            Math.max(0, module.size - inset * 2),
          )
        }
      }

      ctx.globalAlpha = 1
      raf = requestAnimationFrame(render)
    }

    raf = requestAnimationFrame(render)
    return () => cancelAnimationFrame(raf)
  }, [size])

  return <canvas ref={canvasRef} className="webCodexQrMorphCanvas" aria-label="Animated phone access QR" />
}
