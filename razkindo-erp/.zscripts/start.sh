#!/bin/sh

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR"

# 存储所有子进程的 PID
pids=""

# ─── STB Mode Detection ───
export STB_MODE="${STB_MODE:-false}"
if [ "$STB_MODE" = "true" ] || [ "$STB_MODE" = "1" ]; then
    IS_STB=true
else
    # Auto-detect: if total RAM <= 3GB, assume STB
    TOTAL_MEM_KB=$(cat /proc/meminfo 2>/dev/null | grep MemTotal | awk '{print $2}')
    if [ -n "$TOTAL_MEM_KB" ] && [ "$TOTAL_MEM_KB" -le 3145728 ]; then
        IS_STB=true
        export STB_MODE=true
        echo "🔧 Auto-detected STB mode (RAM: $((TOTAL_MEM_KB / 1024))MB ≤ 3GB)"
    else
        IS_STB=false
    fi
fi

# 清理函数：优雅关闭所有服务
cleanup() {
    echo ""
    echo "🛑 Shutting down all services..."
    
    # 发送 SIGTERM 信号给所有子进程
    for pid in $pids; do
        if kill -0 "$pid" 2>/dev/null; then
            service_name=$(ps -p "$pid" -o comm= 2>/dev/null || echo "unknown")
            echo "   Stopping $pid ($service_name)..."
            kill -TERM "$pid" 2>/dev/null
        fi
    done
    
    # 等待所有进程退出（最多等待 5 秒）
    sleep 1
    for pid in $pids; do
        if kill -0 "$pid" 2>/dev/null; then
            timeout=4
            while [ $timeout -gt 0 ] && kill -0 "$pid" 2>/dev/null; do
                sleep 1
                timeout=$((timeout - 1))
            done
            if kill -0 "$pid" 2>/dev/null; then
                echo "   Force killing $pid..."
                kill -KILL "$pid" 2>/dev/null
            fi
        fi
    done
    
    echo "✅ All services stopped"
    exit 0
}

trap cleanup SIGTERM SIGINT SIGQUIT

echo "🚀 Starting all services..."
if [ "$IS_STB" = "true" ]; then
    echo "🔧 STB Mode: ENABLED (RAM-constrained)"
else
    echo "🔧 STB Mode: DISABLED (standard server)"
fi
echo ""

# 切换到构建目录
cd "$BUILD_DIR" || exit 1

ls -lah

DEFAULT_PACKAGED_DB_PATH="/app/db/custom.db"
DEFAULT_PACKAGED_DATABASE_URL="file:$DEFAULT_PACKAGED_DB_PATH"

# 启动 Next.js 服务器
if [ -f "./next-service-dist/server.js" ]; then
    echo "🚀 Starting Next.js server..."
    cd next-service-dist/ || exit 1
    
    # 设置环境变量
    export NODE_ENV=production
    export PORT="${PORT:-3000}"
    export HOSTNAME="${HOSTNAME:-0.0.0.0}"
    export DATABASE_URL="${DATABASE_URL:-$DEFAULT_PACKAGED_DATABASE_URL}"

    if [ "$DATABASE_URL" = "$DEFAULT_PACKAGED_DATABASE_URL" ]; then
        if [ ! -f "$DEFAULT_PACKAGED_DB_PATH" ]; then
            echo "❌ Database not found: $DEFAULT_PACKAGED_DB_PATH"
            echo "   Aborting to prevent starting with empty database."
            exit 1
        fi
        echo "🗄️  Using packaged DB: $DEFAULT_PACKAGED_DB_PATH"
    else
        echo "🗄️  Using external DB: $DATABASE_URL"
    fi

    # Determine heap limit based on STB mode
    if [ "$IS_STB" = "true" ]; then
        HEAP_LIMIT="--max-old-space-size=384"
        echo "🧠 Heap limit: 384MB (STB mode)"
    else
        HEAP_LIMIT=""
    fi
    
    # Background start Next.js with optional heap limit
    bun $HEAP_LIMIT server.js &
    NEXT_PID=$!
    pids="$NEXT_PID"
    
    # Wait and check if process started successfully
    sleep 1
    if ! kill -0 "$NEXT_PID" 2>/dev/null; then
        echo "❌ Next.js server failed to start"
        echo "   Retrying without heap limit..."
        bun server.js &
        NEXT_PID=$!
        pids="$NEXT_PID"
        sleep 1
        if ! kill -0 "$NEXT_PID" 2>/dev/null; then
            echo "❌ Next.js server failed to start (retry also failed)"
            exit 1
        fi
    fi
    echo "✅ Next.js started (PID: $NEXT_PID, Port: $PORT)"
    
    cd ../
else
    echo "⚠️  Next.js server not found: ./next-service-dist/server.js"
fi

# 启动 mini-services
if [ -f "./mini-services-start.sh" ]; then
    echo "🚀 Starting mini-services..."
    
    sh ./mini-services-start.sh &
    MINI_PID=$!
    pids="$pids $MINI_PID"
    
    sleep 1
    if ! kill -0 "$MINI_PID" 2>/dev/null; then
        echo "⚠️  mini-services may have failed to start, continuing..."
    else
        echo "✅ mini-services started (PID: $MINI_PID)"
    fi
elif [ -d "./mini-services-dist" ]; then
    echo "⚠️  mini-services-start.sh not found but mini-services-dist directory exists"
else
    echo "ℹ️  No mini-services directory, skipping"
fi

# 启动 Caddy（如果存在 Caddyfile）
echo "🚀 Starting Caddy..."

echo "✅ Caddy starting (foreground)"
echo ""
echo "🎉 All services started!"
echo ""
echo "💡 Press Ctrl+C to stop all services"
echo ""

# Caddy 作为主进程运行
exec caddy run --config Caddyfile --adapter caddyfile
