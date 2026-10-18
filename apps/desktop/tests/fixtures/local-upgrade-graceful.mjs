// Native qualification only: isolated Electron data, no Harness home, Host, network, or product login.
import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const root = process.argv[2]
if (!root) throw new Error('qualification directory required')
app.setPath('userData', join(root, 'electron-data'))
app.disableHardwareAcceleration()
let quitting = false
process.on('message', message => { if (message?.type === 'qualification-finish') { quitting = true; app.quit() } })
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 360, height: 180, show: true, webPreferences: { sandbox: true } })
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide() } })
  window.on('session-end', () => {
    writeFileSync(join(root, 'session-end.json'), JSON.stringify({ sessionEnd: true }), { flag: 'wx', flush: true })
    quitting = true
    app.quit()
  })
  await window.loadURL('data:text/html,<html><title>DSH local upgrade shutdown qualification</title><body>Isolated graceful shutdown qualification</body></html>')
  writeFileSync(join(root, 'ready.json'), JSON.stringify({ pid: process.pid }), { flag: 'wx', flush: true })
})
