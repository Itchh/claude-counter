// Model ids arriving from the reporter are raw and unstable — the same family
// shows up as `claude-haiku-4-5`, `claude-haiku-4-5-20251001` and
// `claude-3-5-haiku-20241022`. We store them verbatim and collapse to a family
// here, at render time, so a newly released dated id never needs a migration.

export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'other'

interface ModelFamilyMeta {
  readonly family: ModelFamily
  readonly label: string
  readonly color: string
}

// Canonical order. Segments render in this sequence for every person so the
// bars stay comparable at a glance rather than re-sorting per row.
export const MODEL_FAMILIES: ReadonlyArray<ModelFamilyMeta> = [
  { family: 'opus', label: 'OPUS', color: '#ff2d95' },
  { family: 'sonnet', label: 'SONNET', color: '#00f0ff' },
  { family: 'haiku', label: 'HAIKU', color: '#00ff88' },
  { family: 'fable', label: 'FABLE', color: '#ffb020' },
  { family: 'other', label: 'OTHER', color: '#7a7a9e' },
]

const FAMILY_META = new Map<ModelFamily, ModelFamilyMeta>(
  MODEL_FAMILIES.map((meta) => [meta.family, meta])
)

export function modelFamily(rawModelId: string): ModelFamily {
  const id = rawModelId.toLowerCase()
  if (id.includes('opus')) return 'opus'
  if (id.includes('sonnet')) return 'sonnet'
  if (id.includes('haiku')) return 'haiku'
  if (id.includes('fable')) return 'fable'
  return 'other'
}

export function familyLabel(family: ModelFamily): string {
  return FAMILY_META.get(family)?.label ?? 'OTHER'
}

export function familyColor(family: ModelFamily): string {
  return FAMILY_META.get(family)?.color ?? '#7a7a9e'
}

export interface ModelSegment {
  readonly family: ModelFamily
  readonly label: string
  readonly color: string
  readonly tokens: number
  /** Share of this person's own attributed tokens, 0–1. */
  readonly share: number
}

/**
 * Collapse raw per-model totals into ordered, renderable segments.
 * Returns an empty array when nothing is attributed yet — callers should fall
 * back to a plain bar rather than drawing a zero-width stack.
 */
export function toModelSegments(
  tokensByModel: Readonly<Record<string, number>> | null | undefined
): ReadonlyArray<ModelSegment> {
  if (!tokensByModel) return []

  const byFamily = new Map<ModelFamily, number>()
  for (const [rawModelId, tokens] of Object.entries(tokensByModel)) {
    if (!Number.isFinite(tokens) || tokens <= 0) continue
    const family = modelFamily(rawModelId)
    byFamily.set(family, (byFamily.get(family) ?? 0) + tokens)
  }

  const attributed = [...byFamily.values()].reduce((sum, n) => sum + n, 0)
  if (attributed <= 0) return []

  return MODEL_FAMILIES.flatMap((meta) => {
    const tokens = byFamily.get(meta.family) ?? 0
    if (tokens <= 0) return []
    return [
      {
        family: meta.family,
        label: meta.label,
        color: meta.color,
        tokens,
        share: tokens / attributed,
      },
    ]
  })
}
