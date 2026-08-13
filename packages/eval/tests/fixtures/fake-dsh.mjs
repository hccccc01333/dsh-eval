import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const mode = process.env.FAKE_DASH_MODE ?? 'log'
if (mode === 'log' || mode === 'badlog') {
  const dir = join(process.env.DSH_HOME, 'sessions', 'project', 'session-1')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, 'session.jsonl')
  if (mode === 'badlog') {
    writeFileSync(target, '{"type":"session","id":"x","createdAt":0}\nnot json\n')
  } else {
    copyFileSync(process.env.FAKE_DASH_LOG, target)
  }
}
if (mode === 'stderr') process.stderr.write('fake dsh exploded\n')
if (mode === 'output') {
  const chunk = 'x'.repeat(512 * 1024)
  process.stdout.write(chunk)
  process.stderr.write(chunk)
  await new Promise(resolve => setTimeout(resolve, 50))
  process.stdout.write(chunk)
  process.stderr.write(chunk)
}
if (mode === 'sleep') await new Promise(resolve => setTimeout(resolve, 10000))
