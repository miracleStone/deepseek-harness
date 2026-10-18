import { describe, expect, it } from 'vitest'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'

const dictionaries = { de, en, es, fr, ja, pt, ru, zh }

describe('Workspace locale dictionaries', () => {
  it.each(Object.entries(dictionaries))('provides every Workspace label in %s', (_locale, dictionary) => {
    expect(Object.keys(dictionary).sort()).toEqual(Object.keys(en).sort())
  })

  it.each(Object.entries(dictionaries))('preserves folder-label parameters in %s', (_locale, dictionary) => {
    for (const [key, text] of Object.entries(en)) {
      if (!key.startsWith('folders.') && !key.startsWith('toast.folder')) continue
      const translated = Object.entries(dictionary).find(([translatedKey]) => translatedKey === key)?.[1]
      expect(translated).toBeTruthy()
      expect(translated?.match(/\{\w+\}/g)?.sort() ?? []).toEqual(text.match(/\{\w+\}/g)?.sort() ?? [])
    }
  })
})
