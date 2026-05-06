#!/usr/bin/env node
// Keep-alive wrapper for Next.js dev server
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require('child_process');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs');
const logFile = fs.openSync('/home/z/my-project/dev.log', 'a');

const child = spawn('node', ['node_modules/.bin/next', 'dev', '-p', '3000'], {
  cwd: '/home/z/my-project',
  stdio: [logFile, logFile, logFile],
  detached: true,
  env: { ...process.env }
});

child.unref();

// Keep this process alive
setInterval(() => {
  try {
    process.kill(child.pid, 0);
  } catch {
    // Child died, this process can exit too
    process.exit(1);
  }
}, 5000);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
