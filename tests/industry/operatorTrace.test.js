import assert from 'node:assert/strict';
import test from 'node:test';
import { E } from '../../src/elements.js';
import { TRANSFER_PUT, TRANSFER_TAKE } from '../../src/shaders/transfer.js';
import { traceIndustryTransfers } from '../../tools/fixtures/industry-transfer-trace.js';

test('native PUT tracing preserves request/promise and maps accepted ranks to exact slots', async () => {
  const answer = new Float32Array([0, 0, 0, 0, -1, 0, 0, 0, 1, 0, 0, 0]).buffer;
  const promise = Promise.resolve(answer);
  let received;
  const backend = { transfer(request) { assert.equal(this, backend); received = request; return promise; } };
  const original = backend.transfer;
  const trace = traceIndustryTransfers(backend, () => ({ nativeFrame: 12 }));
  const request = { mode: TRANSFER_PUT, count: 3, cells: [[17, 14, 18, -1], [18, 14, 18, -1], [17, 13, 18, -1]],
    items: [[E.SCRAP, 20, 0, 0.625], [E.SCRAP, 21, 0, 0.375]], vel: [0, -0.1, 0] };
  assert.equal(backend.transfer(request), promise);
  assert.equal(received, request);
  await promise;
  assert.deepEqual(trace.receipts[0].accepted, [
    { at: [17, 14, 18], payload: request.items[0] },
    { at: [17, 13, 18], payload: request.items[1] },
  ]);
  assert.equal(trace.receipts[0].pending, false);
  assert.deepEqual(trace.receipts[0].velocity, request.vel);
  trace.dispose();
  assert.equal(backend.transfer, original);
});

test('native TAKE tracing records actual payload without interpreting IDs as PUT ranks', async () => {
  const promise = Promise.resolve(new Float32Array([E.BROKENCOAL, 20.15, 1, 0.375]).buffer);
  class Backend { transfer() { return promise; } }
  const backend = new Backend();
  const trace = traceIndustryTransfers(backend, () => ({ tool: 'SHOVEL' }));
  assert.equal(backend.transfer({ mode: TRANSFER_TAKE, count: 1, cells: [[96, 30, 96, -1]] }), promise);
  await promise;
  assert.equal(trace.receipts[0].accepted[0].payload[0], E.BROKENCOAL);
  assert.equal(trace.receipts[0].accepted[0].payload[2], 1);
  trace.dispose();
  assert.equal(Object.hasOwn(backend, 'transfer'), false);
});

test('trace limits and observation errors do not interfere with native dispatch', async () => {
  const promise = Promise.resolve(new Float32Array([0, 0, 0, 0]).buffer);
  let calls = 0;
  const backend = { transfer() { calls++; return promise; } };
  const request = { mode: TRANSFER_PUT, count: 1, cells: [[1, 1, 1, -1]], items: [[E.SCRAP, 20, 0, 0]] };
  const trace = traceIndustryTransfers(backend, () => ({}), { limit: 1 });
  assert.equal(backend.transfer(request), promise);
  assert.equal(backend.transfer(request), promise);
  await promise;
  assert.equal(trace.omitted, 1);
  assert.equal(calls, 2);
  trace.dispose();
  const badContext = traceIndustryTransfers(backend, () => { throw new Error('observer failed'); });
  assert.equal(backend.transfer(request), promise);
  assert.equal(calls, 3);
  assert.deepEqual(badContext.errors, ['observer failed']);
  badContext.dispose();
});

test('native rejection is still delivered to the caller and recorded by the observer', async () => {
  const error = new Error('native readback failed');
  const promise = Promise.reject(error);
  const backend = { transfer: () => promise };
  const trace = traceIndustryTransfers(backend, () => ({}));
  assert.equal(backend.transfer({ mode: TRANSFER_TAKE, count: 1, cells: [[1, 1, 1, -1]] }), promise);
  await assert.rejects(promise, /native readback failed/);
  assert.equal(trace.receipts[0].error, 'native readback failed');
  assert.equal(trace.receipts[0].pending, false);
  trace.dispose();
});
