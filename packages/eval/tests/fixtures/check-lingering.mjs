import { spawn } from 'node:child_process'

// Exit immediately while a detached grandchild keeps the inherited stdio pipes
// open for a short while. A naive `close`-only wait would hang until it exits.
spawn(process.execPath, ['-e', 'setTimeout(() => {}, 700)'], {
  detached: true,
  stdio: 'inherit',
  windowsHide: true,
})
