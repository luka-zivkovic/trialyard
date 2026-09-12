import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

// A feasibility seam, not the native runner protocol. Each invocation can
// claim its original callback once, and must await external permission.
export function callbackGate({ calls, permitted, record, timeoutMs = 15000 }) {
  const claimed = new Set();
  return async ({ id, tool, input, signal, execute }) => {
    const expected = calls.find(call => call.id === id);
    if (!expected || expected.name !== tool || !isDeepStrictEqual(expected.arguments, input) || claimed.has(id)) throw new Error('Unexpected or repeated scripted dispatch');
    claimed.add(id);
    record('intercept.before', { toolCallId: id, tool, input });
    const deadline = Date.now() + timeoutMs;
    try {
      while (!permitted(id)) {
        if (signal?.aborted) throw new Error('Aborted before original callback dispatch');
        if (Date.now() >= deadline) throw new Error('External gate was not released');
        await delay(20);
      }
      if (signal?.aborted) throw new Error('Aborted before original callback dispatch');
      record('intercept.dispatch', { toolCallId: id, tool });
      const result = await execute();
      record('intercept.result', { toolCallId: id, result });
      return result;
    } catch (error) {
      record('intercept.error', { toolCallId: id, error: String(error), aborted: signal?.aborted === true });
      throw error;
    }
  };
}
