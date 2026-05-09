#!/bin/bash
# Properly daemonize the Next.js dev server
cd /home/z/my-project

# Fork
(
  # Second fork to fully detach
  (
    exec node node_modules/.bin/next dev -p 3000 >> /home/z/my-project/dev.log 2>&1
  ) &
  disown
  exit 0
) &
disown
echo "Daemon launched"
