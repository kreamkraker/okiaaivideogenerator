import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  advanceGenerationStatus,
  pollVideoJob,
  submitVideoJob,
  validateGenerationInput,
} from '../lib/provider';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('provider validation', () => {
  it('accepts a valid text-to-video job', () => {
    const result = validateGenerationInput({
      mode: 'text-to-video',
      model: 'wan-2.2-t2v',
      prompt: 'A cinematic drone shot flying over a glowing mountain lake at sunrise.',
      aspectRatio: '16:9',
      duration: 8,
      resolution: '1280x720',
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects image-to-video without image metadata', () => {
    const result = validateGenerationInput({
      mode: 'image-to-video',
      prompt: 'Transform this still frame into a smooth cinematic motion clip.',
      model: 'wan-2.2-i2v',
      aspectRatio: '16:9',
      duration: 6,
      resolution: '1024x1024',
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Image input is required');
  });

  it('rejects unsupported runtime values and out-of-range durations', () => {
    const result = validateGenerationInput({
      mode: 'unsupported',
      model: 'wan-2.2-t2v',
      prompt: 'A cinematic scene with a clear subject.',
      aspectRatio: '16:9',
      duration: 31,
      resolution: '1280x720',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('A supported video generation mode is required.');
    expect(result.errors).toContain('Duration must be a whole number between 4 and 30 seconds.');
  });

  it('rejects a malformed idempotency request ID', () => {
    const result = validateGenerationInput({
      mode: 'text-to-video',
      model: 'wan-2.2-t2v',
      prompt: 'A cinematic scene with a clear subject.',
      aspectRatio: '16:9',
      duration: 8,
      resolution: '1280x720',
      id: 'not-a-uuid',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Request ID must be a UUID.');
  });

  it('only returns fields from the supported generation input schema', () => {
    const result = validateGenerationInput({
      mode: 'text-to-video',
      model: 'wan-2.2-t2v',
      prompt: 'A cinematic scene with a clear subject.',
      aspectRatio: '16:9',
      duration: 8,
      resolution: '1280x720',
      unexpectedProviderOption: 'not forwarded',
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.value).not.toHaveProperty('unexpectedProviderOption');
  });
});

describe('job state transitions', () => {
  it('moves jobs forward safely', () => {
    expect(advanceGenerationStatus('queued')).toBe('processing');
    expect(advanceGenerationStatus('processing')).toBe('completed');
    expect(advanceGenerationStatus('completed')).toBe('completed');
  });
});

describe('development demo adapter', () => {
  it('creates only a local demo entry without a provider job or generated video', async () => {
    vi.stubEnv('VITE_WAN22_MODE', 'development');

    const result = await submitVideoJob({
      mode: 'text-to-video',
      model: 'wan-2.2-t2v',
      prompt: 'A cinematic scene with a clear subject.',
      aspectRatio: '16:9',
      duration: 8,
      resolution: '1280x720',
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'queued',
      message: expect.stringContaining('Demo mock only'),
    });
    expect(result.jobId).toMatch(/^dev-job-/);
    expect(result.providerJobId).toBeUndefined();
    expect(result.outputUrl).toBeUndefined();
  });

  it('never reports a completed job or fabricated output while polling in demo mode', async () => {
    vi.stubEnv('VITE_WAN22_MODE', 'development');

    const result = await pollVideoJob('demo-job');

    expect(result).toMatchObject({
      ok: true,
      status: 'queued',
      message: expect.stringContaining('no video was generated'),
    });
    expect(result.progress).toBeUndefined();
    expect(result.outputUrl).toBeUndefined();
  });
});
