'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';

// =====================================================================
// WEBSOCKET HOOK - Real-time connection to ERP WebSocket service
// Provides auto-reconnect, auth, event subscription, and online presence
//
// AUTO-DETECTION LOGIC:
//   1. NEXT_PUBLIC_WS_URL — explicit override (highest priority)
//   2. IP detection — if hostname is an IP (e.g., 192.168.x.x),
//      skip XTransformPort and connect directly to WS port (STB/LAN)
//   3. XTransformPort — try Caddy gateway pattern (z.ai dev), with
//      fast 2-attempt fallback to direct connection
//   4. Direct connection — infinite retry to survive network issues
//
// Why IP detection?
//   Caddy gateway only exists on z.ai (domain-based). When users access
//   via IP address (STB, LAN, localhost), XTransformPort will never work.
//   Detecting IP upfront saves ~3 seconds of failed attempts.
// =====================================================================

interface UseWebSocketOptions {
  userId: string;
  role: string;
  unitId?: string;
  userName?: string;
  authToken?: string;
  enabled?: boolean;
}

interface UseWebSocketReturn {
  socket: Socket | null;
  isConnected: boolean;
  onlineCount: number;
  onlineUserIds: string[];
  emit: (event: string, data: any) => void;
  on: (event: string, handler: (...args: any[]) => void) => void;
  off: (event: string, handler: (...args: any[]) => void) => void;
}

// Singleton socket to prevent multiple connections
let _socket: Socket | null = null;
let _lastAuthData: { userId: string; role: string; unitId: string; userName: string; authToken: string } | null = null;
let _refCount = 0;
let _connectionMode: 'xtransform' | 'direct' | 'custom' = 'xtransform';
let _directPortAttempted = false;

/** The port where the monitor-ws service runs */
const WS_SERVICE_PORT = 3004;

/** Check if a string is an IP address (IPv4 or IPv6) */
function isIpAddress(hostname: string): boolean {
  // IPv4: 4 groups of 1-3 digits separated by dots
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  // IPv6: contains colons
  if (hostname.includes(':')) return true;
  // localhost variations
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  return false;
}

/**
 * Determine the Socket.io connection URL based on environment.
 *
 * Priority:
 *   1. NEXT_PUBLIC_WS_URL (explicit override — e.g., "http://192.168.100.64:3004")
 *   2. IP address detected → direct connection (STB/LAN/localhost)
 *   3. XTransformPort pattern (z.ai gateway) with fast fallback
 */
function getSocketUrl(): { url: string; path: string; mode: 'xtransform' | 'direct' | 'custom' } {
  // 1. Explicit custom URL (set at build time via NEXT_PUBLIC_WS_URL)
  const customUrl = process.env.NEXT_PUBLIC_WS_URL;
  if (customUrl) {
    console.log('[WS] Using NEXT_PUBLIC_WS_URL:', customUrl);
    return { url: customUrl, path: '/', mode: 'custom' };
  }

  // 2. If hostname is an IP address, skip XTransformPort entirely
  //    (Caddy proxy doesn't exist on IP-based access)
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    if (isIpAddress(hostname)) {
      const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
      const directUrl = `${protocol}//${hostname}:${WS_SERVICE_PORT}`;
      console.log(`[WS] IP detected (${hostname}) — using direct connection: ${directUrl}`);
      return { url: directUrl, path: '/', mode: 'direct' };
    }
  }

  // 3. XTransformPort pattern (works with Caddy gateway on z.ai)
  return { url: '/?XTransformPort=' + WS_SERVICE_PORT, path: '/', mode: 'xtransform' };
}

/**
 * Get direct connection URL using current browser hostname + WS port.
 */
function getDirectUrl(): { url: string; path: string } {
  if (typeof window === 'undefined') {
    return { url: `http://127.0.0.1:${WS_SERVICE_PORT}`, path: '/' };
  }
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
  return { url: `${protocol}//${window.location.hostname}:${WS_SERVICE_PORT}`, path: '/' };
}

function createSocket(url: string, path: string, infiniteRetry = false): Socket {
  const socket = io(url, {
    path,
    transports: ['websocket', 'polling'],
    reconnection: true,
    // infiniteRetry=false: allow reconnect_failed to fire after 2 fast attempts
    // infiniteRetry=true: retry forever (for direct connections on STB)
    reconnectionAttempts: infiniteRetry ? Infinity : 2,
    reconnectionDelay: infiniteRetry ? 1000 : 500,
    reconnectionDelayMax: 30000,
    timeout: 30000,
    autoConnect: true,
    // @ts-expect-error - pingInterval is a valid socket.io option but not in types
    pingInterval: 25000,
    pingTimeout: 60000,
  });

  // Graceful fallback: stop reconnecting after max attempts exhausted
  socket.on('reconnect_failed', () => {
    console.warn('[WS] Reconnection failed (mode: ' + _connectionMode + ')');

    // If XTransformPort mode failed, try direct port connection
    if (_connectionMode === 'xtransform' && !_directPortAttempted) {
      _directPortAttempted = true;
      console.info('[WS] XTransformPort unavailable — switching to direct port connection...');

      const direct = getDirectUrl();
      _connectionMode = 'direct';

      // Clean up old socket
      _socket?.removeAllListeners();
      _socket?.disconnect();
      _socket = null;

      // Create new socket with infinite retry for direct connection
      _socket = createSocket(direct.url, direct.path, true);

      // Re-register if we have auth data
      _socket.on('connect', () => {
        console.log('[WS] ✅ Direct connection established:', _socket?.id);
        if (_lastAuthData) {
          _socket?.emit('register', {
            userId: _lastAuthData.userId,
            roles: [_lastAuthData.role],
            unitId: _lastAuthData.unitId,
            userName: _lastAuthData.userName,
          });
        }
      });

      _socket.on('connect_error', (err) => {
        console.warn('[WS] Direct connection error:', err.message);
      });

      return;
    }

    console.info('[WS] All connection methods failed. Real-time features disabled. Refresh to retry.');
  });

  // Global connection logging — re-auth on reconnect
  socket.on('connect', () => {
    console.log('[WS] ✅ Connected:', socket.id, `(mode: ${_connectionMode})`);
    if (_lastAuthData) {
      socket.emit('register', {
        userId: _lastAuthData.userId,
        roles: [_lastAuthData.role],
        unitId: _lastAuthData.unitId,
        userName: _lastAuthData.userName,
      });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('[WS] Disconnected:', reason);
  });

  socket.on('connect_error', (err) => {
    console.warn('[WS] Connection error:', err.message);
  });

  return socket;
}

function getOrCreateSocket(): Socket {
  if (_socket) return _socket;

  const { url, path, mode } = getSocketUrl();
  _connectionMode = mode;
  _directPortAttempted = false;

  // Direct connections get infinite retry; XTransformPort gets finite (2 attempts)
  const infiniteRetry = mode !== 'xtransform';
  _socket = createSocket(url, path, infiniteRetry);
  return _socket;
}

/** Force-disconnect the singleton socket (e.g., on logout) */
export function disconnectWebSocket(): void {
  if (_socket) {
    console.log('[WS] Force disconnecting singleton socket');
    _socket.disconnect();
    _socket = null;
    _lastAuthData = null;
    _refCount = 0;
    _directPortAttempted = false;
  }
}

export function useWebSocket(options: UseWebSocketOptions): UseWebSocketReturn {
  const { userId, role, unitId = '', userName = '', authToken = '', enabled = true } = options;
  const [isConnected, setIsConnected] = useState(false);
  const [onlineCount, setOnlineCount] = useState(0);
  const [onlineUserIds, setOnlineUserIds] = useState<string[]>([]);
  // Support multiple handlers per event using Set
  const handlersRef = useRef<Map<string, Set<(...args: any[]) => void>>>(new Map());

  useEffect(() => {
    if (!enabled || !userId) return;

    const socket = getOrCreateSocket();
    _refCount++;

    // Store auth data for reconnection
    _lastAuthData = { userId, role, unitId, userName, authToken };

    // Register with server using 'register' event (matches server-side listener)
    const registerWithServer = () => {
      socket.emit('register', {
        userId,
        roles: [role],
        unitId,
        userName,
      });
    };

    // Auth immediately if connected, otherwise the global 'connect' handler will do it
    if (socket.connected) {
      registerWithServer();
    }

    // Track connection state
    const onConnect = () => {
      setIsConnected(true);
      // Re-auth on every reconnection
      registerWithServer();
    };
    const onDisconnect = () => setIsConnected(false);
    const onPresence = (data: { onlineCount: number; onlineUserIds: string[] }) => {
      setOnlineCount(data.onlineCount);
      setOnlineUserIds(data.onlineUserIds);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('presence:update', onPresence);

    // Re-attach all registered handlers
    handlersRef.current.forEach((handlerSet, event) => {
      handlerSet.forEach(handler => socket.on(event, handler));
    });

    return () => {
      _refCount--;
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('presence:update', onPresence);

      // Remove all registered handlers
      handlersRef.current.forEach((handlerSet, event) => {
        handlerSet.forEach(handler => socket.off(event, handler));
      });

      if (_refCount <= 0 && _socket) {
        console.log('[WS] Destroying singleton socket');
        _socket.disconnect();
        _socket = null;
        _lastAuthData = null;
        _refCount = 0;
        _directPortAttempted = false;
      }
    };
  }, [enabled, userId, role, unitId, userName, authToken]);

  const emit = useCallback((event: string, data: any) => {
    if (_socket?.connected) {
      _socket.emit(event, data);
    }
  }, []);

  const on = useCallback((event: string, handler: (...args: any[]) => void) => {
    // Support multiple handlers per event
    if (!handlersRef.current.has(event)) {
      handlersRef.current.set(event, new Set());
    }
    handlersRef.current.get(event)!.add(handler);
    if (_socket?.connected) {
      _socket.on(event, handler);
    }
  }, []);

  const off = useCallback((event: string, handler: (...args: any[]) => void) => {
    const handlerSet = handlersRef.current.get(event);
    if (handlerSet) {
      handlerSet.delete(handler);
      if (handlerSet.size === 0) {
        handlersRef.current.delete(event);
      }
    }
    if (_socket?.connected) {
      _socket.off(event, handler);
    }
  }, []);

  return {
    socket: _socket,
    isConnected,
    onlineCount,
    onlineUserIds,
    emit,
    on,
    off,
  };
}
