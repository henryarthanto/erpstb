'use client'

import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// 1. useHapticFeedback
// ---------------------------------------------------------------------------

type VibrateFn = (pattern: number | number[]) => void

interface HapticFeedbackAPI {
  triggerLight: VibrateFn
  triggerMedium: VibrateFn
  triggerHeavy: VibrateFn
  press: () => void
  supported: boolean
}

export function useHapticFeedback(): HapticFeedbackAPI {
  const supported =
    typeof navigator !== 'undefined' && 'vibrate' in navigator

  const vibrate: VibrateFn = useCallback(
    (pattern) => {
      if (supported) {
        try {
          navigator.vibrate(pattern)
        } catch {
          // Some browsers throw in restricted contexts
        }
      }
    },
    [supported],
  )

  const triggerLight: VibrateFn = useCallback(() => vibrate(5), [vibrate])
  const triggerMedium: VibrateFn = useCallback(() => vibrate(15), [vibrate])
  const triggerHeavy: VibrateFn = useCallback(() => vibrate(25), [vibrate])
  const press = useCallback(() => vibrate(5), [vibrate])

  return useMemo(
    () => ({ triggerLight, triggerMedium, triggerHeavy, press, supported }),
    [triggerLight, triggerMedium, triggerHeavy, press, supported],
  )
}

// ---------------------------------------------------------------------------
// 3. usePullToRefresh
// ---------------------------------------------------------------------------

export interface UsePullToRefreshOptions {
  onRefresh: () => Promise<void> | void
  threshold?: number
  maxPull?: number
  damping?: number
}

export interface PullToRefreshReturn {
  isPulling: boolean
  pullDistance: number
  isRefreshing: boolean
  containerProps: {
    ref: React.RefObject<HTMLDivElement | null>
    onTouchStart: (e: React.TouchEvent) => void
    onTouchMove: (e: React.TouchEvent) => void
    onTouchEnd: () => void
  }
  refreshIndicatorProps: {
    style: CSSProperties
    className: string
    'aria-hidden': boolean
  }
}

export function usePullToRefresh({
  onRefresh,
  threshold = 80,
  maxPull = 120,
  damping = 0.5,
}: UsePullToRefreshOptions): PullToRefreshReturn {
  const containerRef = useRef<HTMLDivElement>(null)
  const startY = useRef<number | null>(null)
  const currentPull = useRef(0)

  const [isPulling, setIsPulling] = useState(false)
  const [pullDistance, setPullDistance] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const isActive = isPulling || pullDistance > 0 || isRefreshing

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const target = containerRef.current
    if (!target) return
    if (target.scrollTop <= 0) {
      startY.current = e.touches[0].clientY
      currentPull.current = 0
    }
  }, [])

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (startY.current === null || isRefreshing) return
      const target = containerRef.current
      if (!target) return

      const diff = e.touches[0].clientY - startY.current
      if (diff <= 0) {
        startY.current = null
        setPullDistance(0)
        setIsPulling(false)
        return
      }

      if (target.scrollHeight > target.clientHeight && target.scrollTop > 0) {
        return
      }

      e.preventDefault()

      const raw = diff * damping
      const clamped = Math.min(raw, maxPull)
      currentPull.current = clamped
      setPullDistance(clamped)
      setIsPulling(true)
    },
    [damping, isRefreshing, maxPull],
  )

  const onTouchEnd = useCallback(async () => {
    if (startY.current === null) return
    startY.current = null

    if (currentPull.current >= threshold && !isRefreshing) {
      setIsRefreshing(true)
      setPullDistance(44)
      try {
        await onRefresh()
      } finally {
        setIsRefreshing(false)
      }
    }
    setIsPulling(false)
    setPullDistance(0)
    currentPull.current = 0
  }, [isRefreshing, onRefresh, threshold])

  const containerProps = useMemo(
    () => ({ ref: containerRef, onTouchStart, onTouchMove, onTouchEnd }),
    [onTouchStart, onTouchMove, onTouchEnd],
  )

  const refreshIndicatorProps = useMemo(
    () => ({
      style: {
        transform: `translateY(${Math.max(pullDistance - 44, 0)}px)`,
        opacity: pullDistance > 0 || isRefreshing ? 1 : 0,
        transition: isRefreshing ? 'transform 200ms ease' : 'none',
        height: 44,
        overflow: 'hidden',
      } as CSSProperties,
      className: 'flex items-center justify-center w-full select-none',
      'aria-hidden': !isActive,
    }),
    [pullDistance, isRefreshing, isActive],
  )

  return { isPulling, pullDistance, isRefreshing, containerProps, refreshIndicatorProps }
}

// ---------------------------------------------------------------------------
// 4. useSmoothScroll
// ---------------------------------------------------------------------------

export interface UseSmoothScrollReturn {
  scrollTo: (options?: ScrollToOptions & { target?: HTMLElement }) => void
  savePosition: (key: string, container?: HTMLElement | null) => void
  restorePosition: (key: string, container?: HTMLElement | null) => void
  getSavedPosition: (key: string) => number | null
  clearPosition: (key: string) => void
}

export function useSmoothScroll(options?: { storagePrefix?: string }): UseSmoothScrollReturn {
  const prefix = options?.storagePrefix ?? 'scroll'
  const storageKey = useCallback((key: string) => `${prefix}:${key}`, [prefix])

  const getSavedPosition = useCallback((key: string): number | null => {
    if (typeof window === 'undefined') return null
    try {
      const raw = sessionStorage.getItem(storageKey(key))
      return raw !== null ? parseFloat(raw) : null
    } catch { return null }
  }, [storageKey])

  const savePosition = useCallback((key: string, container?: HTMLElement | null) => {
    if (typeof window === 'undefined') return
    const y = container ? container.scrollTop : window.scrollY
    try { sessionStorage.setItem(storageKey(key), String(y)) } catch { /* noop */ }
  }, [storageKey])

  const restorePosition = useCallback((key: string, container?: HTMLElement | null) => {
    const y = getSavedPosition(key)
    if (y === null) return
    const target = container ?? document.documentElement
    target.scrollTo({ top: y, behavior: 'instant' as ScrollBehavior })
  }, [getSavedPosition])

  const clearPosition = useCallback((key: string) => {
    if (typeof window === 'undefined') return
    try { sessionStorage.removeItem(storageKey(key)) } catch { /* noop */ }
  }, [storageKey])

  const scrollTo = useCallback((opts?: ScrollToOptions & { target?: HTMLElement }) => {
    const { target, ...scrollOpts } = opts ?? {}
    const el = target ?? document.documentElement
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ ...scrollOpts, behavior: 'smooth' })
    } else {
      window.scrollTo({ ...scrollOpts, behavior: 'smooth' })
    }
  }, [])

  return useMemo(
    () => ({ scrollTo, savePosition, restorePosition, getSavedPosition, clearPosition }),
    [scrollTo, savePosition, restorePosition, getSavedPosition, clearPosition],
  )
}

// ---------------------------------------------------------------------------
// 5. ShimmerSkeleton — Pure CSS shimmer (keyframes in globals.css)
// ---------------------------------------------------------------------------

export interface ShimmerSkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'text' | 'card' | 'circle' | 'chart'
  lines?: number
}

const variantBase: Record<string, string> = {
  text: 'h-4 w-full rounded bg-muted',
  card: 'h-40 w-full rounded-xl bg-muted',
  circle: 'h-12 w-12 rounded-full bg-muted',
  chart: 'h-48 w-full rounded-lg bg-muted',
}

export function ShimmerSkeleton({
  variant = 'text',
  lines,
  className,
  style,
  ...rest
}: ShimmerSkeletonProps) {
  const base = variantBase[variant] || variantBase.text

  if (variant === 'text' && lines && lines > 1) {
    return (
      <div className={cn('flex flex-col gap-2', className)} {...rest}>
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className={cn(base, 'skeleton', i === lines - 1 && 'w-2/3')}
            style={style}
          />
        ))}
      </div>
    )
  }

  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn(base, 'skeleton', className)}
      style={style}
      {...rest}
    />
  )
}
