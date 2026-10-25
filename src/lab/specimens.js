// Display recipes are separate from the catalog's indefinite-storage assessment.
// TPT's native CLONE → VOID stream renews matter instead of freezing its physics.
export function specimenPlan(entry) {
  const tags = new Set(entry.tags);
  if (entry.type === 'effect') return { mode: 'none', note: 'Effect tool; no stored material.' };
  if (tags.has('pressure-anomaly')) return { mode: 'none', note: 'Starved specimens evaporate; fed specimens can burst.' };
  if (tags.has('matter-consuming') && !tags.has('mobile-matter-only')) {
    return { mode: 'none', note: 'No compatible matter-consumption fixture.' };
  }
  const feed = entry.requirements.includes('thermal-control') || tags.has('decaying') || tags.has('neutron-emitter');
  if (feed && (tags.has('corrosive') || tags.has('annihilating'))) {
    return { mode: 'none', note: 'No compatible replacement-source fixture.' };
  }
  if (tags.has('annihilating')) return { mode: 'cup', note: 'Live specimen in a wall-lined tray.' };
  if (feed) return { mode: 'feed', note: tags.has('neutron-emitter') ?
    'Clone-fed tiny sample; neutrons are NOT shielded.' :
    'Clone-fed specimen; products drained, not temperature-locked.' };
  if (tags.has('air')) return { mode: 'sample', note: 'Air carrier; intentionally clear, not a missing sample.' };
  if (tags.has('gas')) return { mode: 'sample', note: 'Live gas; it may be optically clear. Keep reaction partners away.' };
  return { mode: 'sample', note: tags.has('radioactive') ?
    'Live specimen; keep neutrons away. NOT neutron-shielded.' :
    'Live isolated specimen; do not introduce reaction partners.' };
}
