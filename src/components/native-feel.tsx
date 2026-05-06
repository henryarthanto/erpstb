'use client'

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// 1. NativeTransition
// ---------------------------------------------------------------------------

/**
 * Smooth page / module transition wrapper.
 *
 * Wraps children in `AnimatePresence` + `motion.div` with a subtle
 * fade + slide-from-bottom animation that mirrors native mobile transitions.
 *
 * Usage:
 * ```tsx
 * <NativeTransition key={pathname}>
 *   <CurrentPage />
 * </NativeTransition>
 * ```
 */
export interface NativeTransitionProps {
  /** React key – changing it triggers the transition */
  children: ReactNode
  className?: string
  /** Custom spring / tween duration in ms (default 200) */
  duration?: number
  /** Custom cubic-bezier ease (default iOS-style) */
  ease?: [number, number, number, number]
  /** Initial y offset in px (default 8) */
  offsetY?: number
  /** Wrap in AnimatePresence with mode="wait" (default true) */
  wait?: boolean
  /** HTML element to render (default "div") */
  as?: 'div' | 'section' | 'main' | 'article' | 'span'
}

const defaultEase = [0.25, 0.1, 0.25, 1] as const

// Pre-create motion components outside render to satisfy react-hooks/static-components
const MotionDiv = motion.div
const MotionSection = motion.section
const MotionMain = motion.main
const MotionArticle = motion.article
const MotionSpan = motion.span

const motionMap: Record<string, React.ComponentType<any>> = {
  div: MotionDiv,
  section: MotionSection,
  main: MotionMain,
  article: MotionArticle,
  span: MotionSpan,
}

export function NativeTransition({
  children,
  className,
  duration = 200,
  ease = defaultEase as unknown as [number, number, number, number],
  offsetY = 8,
  wait = true,
  as = 'div',
}: NativeTransitionProps) {
  const MotionTag = motionMap[as] || MotionDiv

  const variants = useMemo(
    () => ({
      initial: { opacity: 0, y: offsetY },
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 0, y: -offsetY * 0.5 },
    }),
    [offsetY],
  )

  const transition = useMemo(
    () => ({
      duration: duration / 1000,
      ease,
    }),
    [duration, ease],
  )

  const content = (
    <MotionTag
      initial="initial"
      animate="animate"
      exit="exit"
      variants={variants}
      transition={transition}
      className={className}
      style={{ willChange: 'opacity, transform' }}
    >
      {children}
    </MotionTag>
  )

  if (wait) {
    return <AnimatePresence mode="wait">{content}</AnimatePresence>
  }

  return content
}

// ---------------------------------------------------------------------------
// 2. useHapticFeedback
// ---------------------------------------------------------------------------

/**
 * Haptic feedback hook for mobile devices.
 *
 * Uses `navigator.vibrate()` on Android; no-op on iOS / desktop.
 * Returns named trigger functions so consumers can pick the intensity.
 *
 * ```tsx
 * const { triggerLight, triggerMedium, triggerHeavy, press } = useHapticFeedback()
 * <button onPress={press}>Tap me</button>
 * ```
 */

type VibrateFn = (pattern: number | number[]) => void

interface HapticFeedbackAPI {
  /** Fire once for a quick tap acknowledgement (~5 ms) */
  triggerLight: VibrateFn
  /** Medium-intensity burst (~15 ms) */
  triggerMedium: VibrateFn
  /** Strong confirmation pulse (~25 ms) */
  triggerHeavy: VibrateFn
  /** Convenience: light haptic mapped to typical button press */
  press: () => void
  /** Whether the runtime supports vibration */
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

  const triggerLight: VibrateFn = useCallback(
    () => vibrate(5),
    [vibrate],
  )
  const triggerMedium: VibrateFn = useCallback(
    () => vibrate(15),
    [vibrate],
  )
  const triggerHeavy: VibrateFn = useCallback(
    () => vibrate(25),
    [vibrate],
  )
  const press = useCallback(() => vibrate(5), [vibrate])

  return useMemo(
    () => ({
      triggerLight,
      triggerMedium,
      triggerHeavy,
      press,
      supported,
    }),
    [triggerLight, triggerMedium, triggerHeavy, press, supported],
  )
}

// ---------------------------------------------------------------------------
// 3. usePullToRefresh
// ---------------------------------------------------------------------------

/**
 * Pull-to-refresh hook mimicking the native mobile pattern.
 *
 * ```tsx
 * const { isPulling, pullDistance, refreshIndicatorProps } =
 *   usePullToRefresh({ onRefresh: fetchNewData })
 *
 * <div {...containerProps}>
 *   <div {...refreshIndicatorProps} />
 *   <MyContent />
 * </div>
 * ```
 */

export interface UsePullToRefreshOptions {
  /** Called when the user pulls past the threshold and releases */
  onRefresh: () => Promise<void> | void
  /** Pull distance in px required to trigger refresh (default 80) */
  threshold?: number
  /** Maximum pull distance in px (default 120) */
  maxPull?: number
  /** Damping multiplier applied to the pull delta (default 0.5) */
  damping?: number
}

export interface PullToRefreshReturn {
  isPulling: boolean
  pullDistance: number
  isRefreshing: boolean
  /** Spread onto the scrollable container element */
  containerProps: {
    ref: React.RefObject<HTMLDivElement | null>
    onTouchStart: (e: React.TouchEvent) => void
    onTouchMove: (e: React.TouchEvent) => void
    onTouchEnd: () => void
  }
  /** Spread onto a refresh-indicator element positioned at the top */
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

  const isActive =
    isPulling || pullDistance > 0 || isRefreshing

  // ---- touch handlers ----

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const target = containerRef.current
    if (!target) return
    // Only activate when scrolled to the very top
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
        // User is not pulling down
        startY.current = null
        setPullDistance(0)
        setIsPulling(false)
        return
      }

      // Don't steal vertical scroll when the content is scrollable
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
      setPullDistance(44) // indicator snap height
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

  // ---- derived props ----

  const containerProps = useMemo(
    () => ({
      ref: containerRef,
      onTouchStart,
      onTouchMove,
      onTouchEnd,
    }),
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
      className: cn(
        'flex items-center justify-center w-full select-none',
      ),
      'aria-hidden': !isActive,
    }),
    [pullDistance, isRefreshing, isActive],
  )

  return {
    isPulling,
    pullDistance,
    isRefreshing,
    containerProps,
    refreshIndicatorProps,
  }
}

// ---------------------------------------------------------------------------
// 4. useSmoothScroll
// ---------------------------------------------------------------------------

/**
 * Smooth-scroll hook with momentum-aware behaviour and scroll-position
 * persistence across module changes.
 *
 * ```tsx
 * const { scrollTo, savePosition, restorePosition } = useSmoothScroll('my-module')
 * ```
 */

export interface UseSmoothScrollOptions {
  /** Storage key prefix for persisting scroll positions (default "scroll") */
  storagePrefix?: string
}

export interface UseSmoothScrollReturn {
  /** Smoothly scroll to top or a specific y-offset */
  scrollTo: (options?: ScrollToOptions) => void
  /** Persist the current scroll position of the given container */
  savePosition: (key: string, container?: HTMLElement | null) => void
  /** Restore a previously saved scroll position */
  restorePosition: (key: string, container?: HTMLElement | null) => void
  /** Get a saved position without restoring */
  getSavedPosition: (key: string) => number | null
  /** Clear saved position */
  clearPosition: (key: string) => void
}

export function useSmoothScroll(
  options?: UseSmoothScrollOptions,
): UseSmoothScrollReturn {
  const prefix = options?.storagePrefix ?? 'scroll'

  const storageKey = useCallback(
    (key: string) => `${prefix}:${key}`,
    [prefix],
  )

  const getSavedPosition = useCallback(
    (key: string): number | null => {
      if (typeof window === 'undefined') return null
      try {
        const raw = sessionStorage.getItem(storageKey(key))
        return raw !== null ? parseFloat(raw) : null
      } catch {
        return null
      }
    },
    [storageKey],
  )

  const savePosition = useCallback(
    (key: string, container?: HTMLElement | null) => {
      if (typeof window === 'undefined') return
      const y = container ? container.scrollTop : window.scrollY
      try {
        sessionStorage.setItem(storageKey(key), String(y))
      } catch {
        // sessionStorage might be full or unavailable
      }
    },
    [storageKey],
  )

  const restorePosition = useCallback(
    (key: string, container?: HTMLElement | null) => {
      const y = getSavedPosition(key)
      if (y === null) return
      const target = container ?? document.documentElement
      target.scrollTo({ top: y, behavior: 'instant' as ScrollBehavior })
    },
    [getSavedPosition],
  )

  const clearPosition = useCallback(
    (key: string) => {
      if (typeof window === 'undefined') return
      try {
        sessionStorage.removeItem(storageKey(key))
      } catch {
        // noop
      }
    },
    [storageKey],
  )

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
    () => ({
      scrollTo,
      savePosition,
      restorePosition,
      getSavedPosition,
      clearPosition,
    }),
    [scrollTo, savePosition, restorePosition, getSavedPosition, clearPosition],
  )
}

// ---------------------------------------------------------------------------
// 5. ShimmerSkeleton
// ---------------------------------------------------------------------------

/**
 * Animated skeleton placeholder with a shimmer gradient sweep.
 *
 * Variants: `text` | `card` | `circle` | `chart`.
 *
 * ```tsx
 * <ShimmerSkeleton variant="card" className="h-40 w-full rounded-xl" />
 * <ShimmerSkeleton variant="text" className="h-4 w-2/3" />
 * <ShimmerSkeleton variant="circle" className="h-12 w-12" />
 * <ShimmerSkeleton variant="chart" className="h-48 w-full rounded-lg" />
 * ```
 */

export interface ShimmerSkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Pre-built shape variant (default "text") */
  variant?: 'text' | 'card' | 'circle' | 'chart'
  /** Number of text-line rows (only for variant="text") */
  lines?: number
  /** Shimmer animation duration in ms (default 1800) */
  shimmerDuration?: number
}

const variantBase: Record<NonNullable<ShimmerSkeletonProps['variant']>, string> = {
  text: 'h-4 w-full rounded',
  card: 'h-40 w-full rounded-xl',
  circle: 'h-12 w-12 rounded-full',
  chart: 'h-48 w-full rounded-lg',
}

function ShimmerSkeletonInner({
  variant = 'text',
  lines,
  shimmerDuration = 1800,
  className,
  style,
  ...rest
}: ShimmerSkeletonProps) {
  const baseClasses = variantBase[variant]

  // Keyframes injected once via <style> to keep CSS-in-JS minimal
  const animationName = 'nativeFeelShimmer'

  // Inject keyframes on mount
  useEffect(() => {
    if (typeof document === 'undefined') return
    const id = 'native-feel-shimmer-keyframes'
    if (document.getElementById(id)) return
    const sheet = document.createElement('style')
    sheet.id = id
    sheet.textContent = `
@keyframes ${animationName} {
  0%   { background-position: -400px 0; }
  100% { background-position:  400px 0; }
}
`
    document.head.appendChild(sheet)
    return () => {
      sheet.remove()
    }
  }, [])

  const shimmerStyle: CSSProperties = {
    ...style,
    background: `linear-gradient(
      90deg,
      hsl(var(--muted)) 0%,
      hsl(var(--muted) / 0.4) 20%,
      hsl(var(--accent)) 50%,
      hsl(var(--muted) / 0.4) 80%,
      hsl(var(--muted)) 100%
    )`,
    backgroundSize: '800px 100%',
    animation: `${animationName} ${shimmerDuration}ms ease-in-out infinite`,
  }

  // Multiple text lines
  if (variant === 'text' && lines && lines > 1) {
    return (
      <div className={cn('flex flex-col gap-2', className)} {...rest}>
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className={cn(
              baseClasses,
              i === lines - 1 && 'w-2/3', // last line shorter
            )}
            style={shimmerStyle}
          />
        ))}
      </div>
    )
  }

  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn(baseClasses, className)}
      style={shimmerStyle}
      {...rest}
    />
  )
}

export const ShimmerSkeleton = React.memo(ShimmerSkeletonInner)
