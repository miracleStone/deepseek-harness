import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DesktopStartupReceipt, resolveDesktopStartupReceiptTarget } from '../src/startup-receipt.ts'

const roots: string[] = []
const nonce = '11111111-2222-4333-8444-555555555555'
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-startup-receipt-'))
  roots.push(root)
  const file = join(root, 'desktop-ready.json')
  return { root, file, receipt: new DesktopStartupReceipt({ file, nonce }, { mainPid: 41, version: '1.2.3' }) }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('is disabled without both explicit local launch fields and rejects incomplete or noncanonical requests', () => {
  expect(resolveDesktopStartupReceiptTarget({})).toBeUndefined()
  const f = fixture()
  expect(resolveDesktopStartupReceiptTarget({ DSH_DESKTOP_READY_RECEIPT: f.file, DSH_DESKTOP_READY_NONCE: nonce }))
    .toEqual({ file: f.file, nonce })
  for (const environment of [
    { DSH_DESKTOP_READY_RECEIPT: f.file }, { DSH_DESKTOP_READY_NONCE: nonce },
    { DSH_DESKTOP_READY_RECEIPT: 'relative/desktop-ready.json', DSH_DESKTOP_READY_NONCE: nonce },
    { DSH_DESKTOP_READY_RECEIPT: join(f.root, 'config.json'), DSH_DESKTOP_READY_NONCE: nonce },
    { DSH_DESKTOP_READY_RECEIPT: f.file, DSH_DESKTOP_READY_NONCE: 'not-a-nonce' },
  ]) expect(() => resolveDesktopStartupReceiptTarget(environment)).toThrow('Desktop startup receipt requires')
  expect(existsSync(f.file)).toBe(false)
})

it('publishes only explicit process/version facts and revokes synchronously before a Host generation changes', () => {
  const f = fixture()
  expect(existsSync(f.file)).toBe(false)
  f.receipt.publish(42)
  expect(JSON.parse(readFileSync(f.file, 'utf8'))).toEqual({ schemaVersion: 1, nonce, version: '1.2.3', mainPid: 41, hostPid: 42 })
  f.receipt.publish(42)
  f.receipt.revoke()
  expect(existsSync(f.file)).toBe(false)
  f.receipt.publish(43)
  expect(JSON.parse(readFileSync(f.file, 'utf8'))).toMatchObject({ mainPid: 41, hostPid: 43 })
  f.receipt.revoke()
  f.receipt.revoke()
  expect(existsSync(f.file)).toBe(false)
})

it('does not replace an existing file or delete a receipt changed by another owner', () => {
  const f = fixture()
  writeFileSync(f.file, 'foreign')
  expect(() => { f.receipt.publish(42) }).toThrow()
  expect(readFileSync(f.file, 'utf8')).toBe('foreign')
  f.receipt.revoke()
  expect(readFileSync(f.file, 'utf8')).toBe('foreign')
  unlinkSync(f.file)
  f.receipt.publish(42)
  writeFileSync(f.file, 'changed')
  expect(() => { f.receipt.revoke() }).toThrow('changed ownership')
  expect(readFileSync(f.file, 'utf8')).toBe('changed')
})

it('refuses a linked parent without following it to create or remove files', () => {
  const f = fixture()
  const link = join(f.root, 'linked')
  symlinkSync(f.root, link, 'junction')
  try {
    const receipt = new DesktopStartupReceipt({ file: join(link, 'desktop-ready.json'), nonce }, { mainPid: 41, version: '1.2.3' })
    expect(() => { receipt.publish(42) }).toThrow('linked')
    expect(existsSync(f.file)).toBe(false)
  } finally { unlinkSync(link) }
})
