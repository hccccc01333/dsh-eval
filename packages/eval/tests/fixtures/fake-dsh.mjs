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
if (mode === 'merge') {
  const project = join(process.env.DSH_HOME, 'sessions', 'project')
  const parentDir = join(project, 'session-parent')
  mkdirSync(parentDir, { recursive: true })
  copyFileSync(process.env.FAKE_DASH_LOG, join(parentDir, 'session.jsonl'))
  const childDir = join(project, 'session-child')
  mkdirSync(childDir, { recursive: true })
  writeFileSync(join(childDir, 'session.jsonl'), [
    '{"type":"session","version":0,"id":"session-child","createdAt":1700000001000,"delegationDepth":1}',
    '{"seq":0,"type":"turn/start","time":1700000001000,"data":{"turn":0}}',
    '{"seq":1,"type":"step/start","time":1700000001002,"data":{"turn":0,"step":0}}',
    '{"seq":2,"type":"tool/call","time":1700000001003,"data":{"turn":0,"step":0,"callId":"child-1","name":"bash","arguments":"{}"}}',
    '{"seq":3,"type":"tool/result","time":1700000001100,"data":{"turn":0,"step":0,"message":{"id":"r","role":"user","content":[{"type":"tool-result","text":"ok","isError":false}],"source":{"kind":"tool","callId":"child-1"}}}}',
    '{"seq":4,"type":"step/end","time":1700000001101,"data":{"turn":0,"step":0}}',
    '{"seq":5,"type":"turn/end","time":1700000001102,"data":{"turn":0,"reason":{"kind":"completed"}}}',
    '',
  ].join('\n'))
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
