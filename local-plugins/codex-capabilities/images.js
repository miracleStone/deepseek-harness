/** Subscription image generation and editing, rendered through native attachment blocks. */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CodexError, requestJson } from './http.js'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const MODELS = {
  'gpt-image-2.5-flare': ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-image-2.5-sunburst': ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
}

/** Validate explicit render controls before issuing a quota-consuming request. */
export function resolveImageOptions(args, defaults) {
  const model = args.model ?? defaults.imageModel
  const quality = args.quality ?? defaults.imageQuality
  const background = args.background ?? 'auto'
  const size = args.size ?? 'auto'
  if (!Object.hasOwn(MODELS, model) || !MODELS[model].includes(quality)) {
    throw new CodexError('Unsupported image model or quality; choose a quality supported by the requested model.', 'CODEX_INVALID_INPUT')
  }
  if (!['auto', 'transparent', 'opaque'].includes(background)) {
    throw new CodexError('background must be auto, transparent, or opaque.', 'CODEX_INVALID_INPUT')
  }
  if (size !== 'auto') {
    const match = /^(\d+)x(\d+)$/u.exec(size)
    const width = Number(match?.[1])
    const height = Number(match?.[2])
    const short = Math.min(width, height)
    const long = Math.max(width, height)
    if (!match || width % 16 || height % 16 || long > 3840 || long > short * 3
      || width * height < 655360 || width * height > 8294400) {
      throw new CodexError('size must be auto or widthxheight: multiples of 16, at most 3840 per side, aspect ratio at most 3:1, and 655360–8294400 pixels.', 'CODEX_INVALID_INPUT')
    }
  }
  if (typeof args.prompt !== 'string' || !args.prompt.trim()) {
    throw new CodexError('prompt must be a non-empty image description.', 'CODEX_INVALID_INPUT')
  }
  return { model, quality, background, size, prompt: args.prompt.trim() }
}

/** Decode canonical base64 PNG bytes within the deployment's image-byte limit. */
export function decodePng(encoded, maximumBytes) {
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length % 4 !== 0
    || encoded.length > Math.ceil(maximumBytes / 3) * 4
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    throw new CodexError('Codex returned invalid or oversized base64 image data.', 'CODEX_INVALID_RESPONSE')
  }
  const data = Buffer.from(encoded, 'base64')
  if (data.length > maximumBytes || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString('base64') !== encoded) {
    throw new CodexError('Codex returned invalid or oversized PNG data.', 'CODEX_INVALID_RESPONSE')
  }
  return data
}

/** Resolve only references already present in this session; invalid edits never become generations. */
async function referenceImages(ids, session, attachments, signal) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 5 || new Set(ids).size !== ids.length) {
    throw new CodexError('referenceImages must contain 1–5 distinct session attachment IDs; omit it only for a new image.', 'CODEX_INVALID_INPUT')
  }
  const available = new Map()
  const visit = content => {
    for (const block of content) {
      if (block.type === 'image') available.set(block.attachment.attachmentId, block.attachment)
      else if (block.type === 'tool-result') visit(block.content)
    }
  }
  for (const message of session.deriveMessages()) visit(message.content)
  const refs = ids.map(id => {
    if (!/^sha256:[0-9a-f]{64}$/u.test(id) || !available.has(id)) {
      throw new CodexError('Image reference is not in this session. Copy its complete attachmentId from an image block, or read_image an actual local file first. Do not drop references or substitute text-only generation.', 'CODEX_INVALID_INPUT')
    }
    return available.get(id)
  })
  if (refs.reduce((sum, ref) => sum + ref.bytes, 0) > attachments.imageLimits.maxMessageImageBytes) {
    throw new CodexError('Reference images exceed the configured aggregate image-byte limit.', 'CODEX_INVALID_INPUT')
  }
  const images = []
  for (const ref of refs) {
    const stored = await attachments.readImage(ref, signal)
    images.push({ image_url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}` })
  }
  return images
}

/** Build the image tool; stored originals and previews survive session replay. */
export function createImageTool({ attachments, getAuth, config }) {
  return defineTool({
    name: 'codex_image_generate',
    description: 'Generate or edit an image using the signed-in Codex subscription only when the user requests image output. For a new image omit referenceImages. For an edit, supply complete attachment IDs copied from selected session image blocks or read_image results. Never replace an invalid edit with a new generation. The result includes a preview and the original PNG host path when available; copy, do not move, the original if saving to the workspace. Do not silently retry a failed request or switch models: requests can consume subscription quota.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Complete description of the requested image or edits.' },
      model: { type: 'string', enum: Object.keys(MODELS), description: 'Optional image engine, independent of the chat model. Defaults to gpt-image-2.5-flare when omitted. Honor the user\'s explicit model choice. Choose gpt-image-2.5-flare for fast everyday generation, quick drafts, and iterative concept exploration. Choose gpt-image-2.5-sunburst for quality-critical or complex generation and precise edits where preserving subject identity or product details matters more than speed. Both engines support generation and editing; do not choose solely by artistic style or the presence of reference images. Select before the first request; never silently retry or switch engines after a failure. Do not promise a fixed speedup, lower subscription usage, or perfect detail preservation. Account availability can vary.' },
      size: { type: 'string', description: 'auto or exact widthxheight; use auto unless the user requests dimensions.' },
      quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] },
      background: { type: 'string', enum: ['auto', 'transparent', 'opaque'] },
      referenceImages: { type: 'array', items: { type: 'string' }, description: '1–5 complete sha256: attachment IDs from this session. Omit for a new image.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        image: { type: 'json', required: true },
        original: { type: 'json', required: true },
        originalPath: { type: 'string' },
        requestedModel: { type: 'string', required: true },
        requestedSize: { type: 'string', required: true },
      } },
      render: (_args, value) => [
        { type: 'text', text: `Generated image with ${value.requestedModel}; requested size: ${value.requestedSize}. Preview: ${value.image.width}x${value.image.height}.${value.originalPath ? ` Original PNG saved on the host at ${JSON.stringify(value.originalPath)}. Copy it with a .png extension; leave the stored original in place.` : ' The original PNG is preserved in attachment storage; this backend exposes no host path.'}` },
        { type: 'image', attachment: value.image },
      ],
      presentationMeta: (_args, value) => ({ original: value.original, ...(value.originalPath ? { originalPath: value.originalPath } : {}) }),
    },
    timeoutMs: config.imageTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new CodexError('Image generation requires a session-owned tool call.', 'CODEX_INVALID_INPUT')
      const body = resolveImageOptions(args, config)
      if (!attachments.imageLimits.mediaTypes.includes('image/png')) {
        throw new CodexError('This attachment provider does not accept PNG images.', 'CODEX_INVALID_INPUT')
      }
      const editing = args.referenceImages !== undefined
      if (editing) body.images = await referenceImages(args.referenceImages, exec.agent.session, attachments, exec.signal)
      const maximumBytes = Math.min(config.maxImageBytes, attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
      const auth = await getAuth(exec.signal)
      const result = await requestJson(editing ? 'images/edits' : 'images/generations', body, auth, exec.signal, {
        baseURL: config.baseURL,
        timeoutMs: config.imageTimeoutMs,
        turnId: String(exec.callId),
        maxResponseBytes: Math.ceil(maximumBytes / 3) * 4 + config.imageEnvelopeBytes,
      })
      const data = decodePng(result?.data?.[0]?.b64_json, maximumBytes)
      exec.signal.throwIfAborted()
      await attachments.validateImage({ data, mediaType: 'image/png' })
      const original = await attachments.saveFile({ data, name: 'codex-original.png' })
      const image = await attachments.saveImage({ data, mediaType: 'image/png', name: 'codex-generated.png' })
      const originalPath = attachments.fileHostPath(original)
      return { image, original, ...(originalPath ? { originalPath } : {}), requestedModel: body.model, requestedSize: body.size }
    },
  })
}
