/** Prepare all three plugins in an explicitly selected, isolated candidate directory. */
import { fileURLToPath } from 'node:url'
import { prepareCandidates } from '../build-candidates.mjs'

await prepareCandidates(fileURLToPath(new URL('../../', import.meta.url)), process.argv.slice(2))
