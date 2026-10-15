// Test-only observer of the existing native per-slot answers. It never changes
// a request or substitutes the original transfer promise.
export function traceIndustryTransfers(backend, context, { limit = 64, putMode = 1 } = {}) {
  const original = backend.transfer;
  const owned = Object.hasOwn(backend, 'transfer');
  const receipts = [], errors = [];
  let omitted = 0;
  const clean = error => String(error?.message ?? error).slice(0, 300);
  function observed(request) {
    const promise = original.call(this, request);
    try {
      const frame = context();
      if (!frame || !promise?.then) return promise;
      if (receipts.length >= limit) { omitted++; return promise; }
      const receipt = {
        ...frame, mode: request.mode, pending: true,
        candidates: request.cells.slice(0, request.count).map(cell => cell.slice(0, 3)),
        items: (request.items ?? []).map(cell => [...cell]),
        velocity: [...(request.vel ?? [0, 0, 0])], accepted: [],
      };
      receipts.push(receipt);
      promise.then(bytes => {
        const answer = new Float32Array(bytes, 0, request.count * 4);
        receipt.accepted = receipt.candidates.flatMap((at, i) => {
          const value = Array.from(answer.subarray(i * 4, i * 4 + 4));
          if (value[0] < 0) return [];
          const rank = Math.round(value[0]);
          if (request.mode === putMode && !receipt.items[rank]) throw new Error('invalid native PUT rank');
          return [{ at, payload: request.mode === putMode ? [...receipt.items[rank]] : value }];
        });
        receipt.pending = false;
      }, error => { receipt.error = clean(error); receipt.pending = false; })
        .catch(error => { receipt.error = clean(error); receipt.pending = false; });
    } catch (error) { errors.push(clean(error)); }
    return promise;
  }
  backend.transfer = observed;
  return {
    receipts, errors,
    get omitted() { return omitted; },
    dispose() {
      if (backend.transfer !== observed) return;
      if (owned) backend.transfer = original;
      else delete backend.transfer;
    },
  };
}
