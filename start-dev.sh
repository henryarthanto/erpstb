#!/bin/bash
cd /home/z/my-project
while true; do
  echo "[$(date)] Starting Next.js dev server..."
  npx next dev -p 3000
  echo "[$(date)] Server exited. Restarting in 3s..."
  sleep 3
done
