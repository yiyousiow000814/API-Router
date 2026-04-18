import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const Z_INDEX_FILES = [
  ['../App.css', 'App.css'],
  ['./AppShared.css', 'components/AppShared.css'],
  ['./AppShared.layout.css', 'components/AppShared.layout.css'],
  ['./AppShared.tables.css', 'components/AppShared.tables.css'],
  ['./AppShared.usage.css', 'components/AppShared.usage.css'],
  ['./UsageStatisticsPanel.css', 'components/UsageStatisticsPanel.css'],
  ['./UsageHistoryModal.css', 'components/UsageHistoryModal.css'],
  ['./EventsTable.css', 'components/EventsTable.css'],
  ['./EventLogPanel.css', 'components/EventLogPanel.css'],
] as const

describe('global z-index scale', () => {
  it('defines one sequential token table in AppShared.css', () => {
    const css = fs.readFileSync(new URL('./AppShared.css', import.meta.url), 'utf8')
    const values = [...css.matchAll(/--z-[a-z-]+:\s*(\d+);/g)].map((match) => Number(match[1]))

    expect(values).toEqual(Array.from({ length: values.length }, (_, index) => index))
  })

  it('uses z-index tokens instead of hard-coded values in the shared app styles', () => {
    for (const [fileUrl, label] of Z_INDEX_FILES) {
      const css = fs.readFileSync(new URL(fileUrl, import.meta.url), 'utf8')
      const numericDeclarations = [...css.matchAll(/z-index:\s*\d+/g)]

      expect(
        numericDeclarations,
        `${label} should use global --z-* tokens for z-index`,
      ).toHaveLength(0)
    }
  })
})
