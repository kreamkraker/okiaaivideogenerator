import { describe, expect, it } from 'vitest';
import { advanceGenerationStatus, validateGenerationInput } from '../lib/provider';

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
      duration: 6,
      resolution: '1024x1024',
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Image input is required');
  });
});

describe('job state transitions', () => {
  it('moves jobs forward safely', () => {
    expect(advanceGenerationStatus('queued')).toBe('processing');
    expect(advanceGenerationStatus('processing')).toBe('completed');
    expect(advanceGenerationStatus('completed')).toBe('completed');
  });
});
