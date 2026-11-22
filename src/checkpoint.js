// One repeatable, session-only bookmark, independent of the rolling Undo stack.
// Invalidating a map also invalidates any GPU readback still on its way back.
export function createCheckpoint({ capture, restore, onChange = () => {} }) {
  let saved = null, generation = 0, busy = null;
  const state = () => ({ ready: saved !== null, busy });
  const changed = () => onChange(state());
  async function run(kind, operation) {
    if (busy) return false;
    const epoch = generation;
    busy = kind;
    changed();
    const valid = () => epoch === generation;
    try { return await operation(valid); }
    finally { busy = null; changed(); }
  }
  return {
    get state() { return state(); },
    save: () => run('saving', async valid => {
      const next = await capture();
      if (!valid() || next == null) return false;
      saved = next;
      return true;
    }),
    reset: async () => saved !== null && run('restoring', async valid => !!await restore(saved, valid) && valid()),
    clear() { generation++; saved = null; changed(); },
  };
}
