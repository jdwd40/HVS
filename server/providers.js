// Provider adapters: generateImage / generateVideo / getJobStatus / getCost.
// MOCK PROVIDERS ONLY. No paid APIs are ever called.
//
// A mock generation is an asynchronous job: generateX returns { providerJobId };
// getJobStatus reports 'processing' until latency has elapsed, then 'succeeded'
// with deterministic local SVG media specs.
import crypto from 'node:crypto';

const jobs = new Map(); // providerJobId -> { kind, startedAt, latencyMs, payload, fail }

function rid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export const mockImageProvider = {
  name: 'mock-image',
  generateImage(payload, { latencyMs = 1200 } = {}) {
    const id = rid('mimg');
    jobs.set(id, { kind: 'image', startedAt: Date.now(), latencyMs, payload, fail: !!payload.forceFail });
    return { providerJobId: id };
  },
  generateVideo() { throw new Error('mock-image provider does not generate video'); },
  getJobStatus(providerJobId) { return jobStatus(providerJobId); },
  getCost() { return 0.02; },
};

export const mockVideoProvider = {
  name: 'mock-video',
  generateImage() { throw new Error('mock-video provider does not generate images'); },
  generateVideo(payload, { latencyMs = 1200 } = {}) {
    const id = rid('mvid');
    jobs.set(id, { kind: 'video', startedAt: Date.now(), latencyMs, payload, fail: !!payload.forceFail });
    return { providerJobId: id };
  },
  getJobStatus(providerJobId) { return jobStatus(providerJobId); },
  getCost() { return 0.1; },
};

function jobStatus(providerJobId) {
  const j = jobs.get(providerJobId);
  if (!j) return { status: 'failed', error: 'unknown provider job id' };
  if (j.fail && Date.now() - j.startedAt >= j.latencyMs) {
    return { status: 'failed', error: 'mock provider forced failure' };
  }
  if (Date.now() - j.startedAt >= j.latencyMs) {
    return { status: 'succeeded', kind: j.kind, payload: j.payload };
  }
  return { status: 'processing' };
}

export function providerFor(kind) {
  return kind === 'video' ? mockVideoProvider : mockImageProvider;
}

// Test hook: clear in-flight provider jobs.
export function _resetMockProviders() {
  jobs.clear();
}
