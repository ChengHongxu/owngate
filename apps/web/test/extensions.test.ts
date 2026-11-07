import { describe, expect, it } from 'vitest'
import { enabledSelection, type ExtensionPreview } from '../src/lib/extensions-api'

describe('extension selection', () => {
  it('limits the install request to explicitly selected eligible reads when the preview contains actions', () => {
    const preview = { operations: [
      { id: 'read.get', eligible: true }, { id: 'delete.post', eligible: false }, { id: 'other.get', eligible: true },
    ] } as ExtensionPreview
    expect(enabledSelection(preview, ['read.get', 'delete.post', 'not-in-preview'])).toEqual(['read.get'])
    expect(enabledSelection(preview, [])).toEqual([])
  })
})
