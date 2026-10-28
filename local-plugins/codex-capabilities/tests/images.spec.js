/** Keyless image protocol, storage, and edit authorization regressions. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createImageTool, decodePng, resolveImageOptions } from '../images.js'
import { Config } from '../index.js'

const id = `sha256:${'a'.repeat(64)}`
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64')
const ref = { attachmentId: id, mediaType: 'image/png', bytes: png.length, width: 1, height: 1, name: 'preview.png' }
const config = Config({})

function fixture(messages = []) {
  const attachments = {
    imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 100000, maxMessageImageBytes: 100000 },
    validateImage: vi.fn(async () => {}),
    saveFile: vi.fn(async () => ({ attachmentId: id, bytes: png.length, name: 'codex-original.png' })),
    saveImage: vi.fn(async () => ref),
    fileHostPath: () => 'C:\\attachments\\original',
    readImage: vi.fn(async () => ({ ref, data: png })),
  }
  const getAuth = vi.fn(async () => ({ access: 'secret-token', accountId: 'account' }))
  const exec = { signal: new AbortController().signal, callId: 'image-turn', agent: { session: { deriveMessages: () => messages } } }
  return { attachments, getAuth, exec, tool: createImageTool({ attachments, getAuth, config }) }
}

function mockResponse(value = { data: [{ b64_json: png.toString('base64') }] }) {
  const network = vi.fn(async () => Response.json(value))
  vi.stubGlobal('fetch', network)
  return network
}

afterEach(() => vi.unstubAllGlobals())

describe('subscription images', () => {
  it('uses JSON generation with OAuth headers and stores verbatim original before preview', async () => {
    const network = mockResponse()
    const { tool, exec, attachments } = fixture()
    const args = { prompt: 'A red cube', size: '1024x1024' }
    const result = await tool.execute(args, exec)
    const [url, init] = network.mock.calls[0]
    expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/images/generations')
    expect(init.redirect).toBe('error')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret-token')
    expect(new Headers(init.headers).get('chatgpt-account-id')).toBe('account')
    expect(new Headers(init.headers).get('x-codex-image-turn-id')).toBe('image-turn')
    expect(JSON.parse(init.body)).toEqual({ prompt: 'A red cube', model: 'gpt-image-2.5-flare', size: '1024x1024', quality: 'auto', background: 'auto' })
    expect(attachments.saveFile).toHaveBeenCalledWith({ data: png, name: 'codex-original.png' })
    expect(attachments.saveFile.mock.invocationCallOrder[0]).toBeLessThan(attachments.saveImage.mock.invocationCallOrder[0])
    expect(result.image).toEqual(ref)
    expect(tool.output.render(args, result)).toMatchSnapshot()
    expect(tool.description).toMatchSnapshot()
    expect(tool.parameters).toMatchSnapshot()
  })

  it('offers only the two 2.5 engines and defaults to flare', () => {
    const { tool } = fixture()
    expect(tool.parameters.properties.model.enum).toEqual(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])
    expect(Config({}).imageModel).toBe('gpt-image-2.5-flare')
    for (const model of tool.parameters.properties.model.enum) {
      expect(resolveImageOptions({ prompt: 'Image', model, quality: 'max' }, config)).toMatchObject({ model, quality: 'max' })
    }
  })

  it('guides model selection by speed, quality, and edit fidelity without fixed performance promises', () => {
    const { tool } = fixture()
    const description = tool.parameters.properties.model.description
    expect(description).toContain('Defaults to gpt-image-2.5-flare when omitted')
    expect(description).toContain("Honor the user's explicit model choice")
    expect(description).toContain('Choose gpt-image-2.5-flare for fast everyday generation, quick drafts, and iterative concept exploration')
    expect(description).toContain('Choose gpt-image-2.5-sunburst for quality-critical or complex generation and precise edits where preserving subject identity or product details matters more than speed')
    expect(description).toContain('Both engines support generation and editing')
    expect(description).toContain('do not choose solely by artistic style or the presence of reference images')
    expect(description).toContain('Select before the first request; never silently retry or switch engines after a failure')
    expect(description).toContain('Do not promise a fixed speedup, lower subscription usage, or perfect detail preservation')
  })

  it('preserves explicit engine choices instead of classifying prompt wording', async () => {
    const network = mockResponse()
    const { tool, exec } = fixture()
    await tool.execute({ prompt: 'A quality-critical final illustration', model: 'gpt-image-2.5-flare' }, exec)
    await tool.execute({ prompt: 'A quick everyday draft', model: 'gpt-image-2.5-sunburst' }, exec)
    expect(network.mock.calls.map(([, init]) => JSON.parse(init.body).model)).toEqual([
      'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst',
    ])
  })

  it('rejects the removed engine before authentication or network access', async () => {
    const network = mockResponse()
    const { tool, exec, getAuth, attachments } = fixture()
    await expect(tool.execute({ prompt: 'Image', model: 'gpt-image-2' }, exec)).rejects.toThrow()
    expect(() => resolveImageOptions({ prompt: 'Image', model: 'gpt-image-2' }, config)).toThrow(/Unsupported image model/u)
    expect(getAuth).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
    expect(attachments.saveFile).not.toHaveBeenCalled()
  })

  it('rejects the removed engine in deployment configuration', () => {
    expect(() => Config({ imageModel: 'gpt-image-2' })).toThrow()
  })

  it('edits only selected references resolved from durable session history', async () => {
    const network = mockResponse()
    const { tool, exec, attachments } = fixture([{ content: [{ type: 'tool-result', content: [{ type: 'image', attachment: ref }] }] }])
    await tool.execute({ prompt: 'Make it blue', referenceImages: [id] }, exec)
    expect(String(network.mock.calls[0][0])).toMatch(/\/images\/edits$/u)
    expect(JSON.parse(network.mock.calls[0][1].body).images).toEqual([{ image_url: `data:image/png;base64,${png.toString('base64')}` }])
    expect(attachments.readImage).toHaveBeenCalledWith(ref, exec.signal)
  })

  it.each([[], [id], ['C:\\image.png'], [id, id]])('does not turn an invalid edit into a generation: %j', async referenceImages => {
    const network = mockResponse()
    const { tool, exec, getAuth } = fixture()
    await expect(tool.execute({ prompt: 'Edit image', referenceImages }, exec)).rejects.toThrow()
    expect(network).not.toHaveBeenCalled()
    expect(getAuth).not.toHaveBeenCalled()
  })

  it('rejects invalid controls before consuming quota', async () => {
    const network = mockResponse()
    const { tool, exec } = fixture()
    await expect(tool.execute({ prompt: 'Image', model: 'gpt-image-2.5-flare', quality: 'unsupported' }, exec)).rejects.toThrow(/quality/u)
    await expect(tool.execute({ prompt: 'Image', size: '32x32' }, exec)).rejects.toThrow(/size/u)
    expect(network).not.toHaveBeenCalled()
    expect(resolveImageOptions({ prompt: 'Image', size: '3840x2160' }, config).size).toBe('3840x2160')
  })

  it('does not retry quota or permission failures and preserves existing attachments', async () => {
    const network = vi.fn(async () => new Response('private detail', { status: 429 }))
    vi.stubGlobal('fetch', network)
    const { tool, exec, attachments } = fixture()
    await expect(tool.execute({ prompt: 'Image' }, exec)).rejects.toMatchObject({ status: 429 })
    expect(network).toHaveBeenCalledTimes(1)
    expect(attachments.saveFile).not.toHaveBeenCalled()
  })

  it('does not publish success after storage failure', async () => {
    mockResponse()
    const { tool, exec, attachments } = fixture()
    attachments.saveImage.mockRejectedValue(new Error('storage unavailable'))
    await expect(tool.execute({ prompt: 'Image' }, exec)).rejects.toThrow('storage unavailable')
  })

  it('rejects invalid, noncanonical, and oversized image bytes', () => {
    for (const encoded of ['', '!!!!', 'AAAA', 'iVBORw0KGgo=bad', 'Zh==']) expect(() => decodePng(encoded, 100)).toThrow()
    expect(() => decodePng(png.toString('base64'), png.length - 1)).toThrow()
    expect(decodePng(png.toString('base64'), png.length)).toEqual(png)
  })
})
