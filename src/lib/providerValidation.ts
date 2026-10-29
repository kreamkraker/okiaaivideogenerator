import type { VideoGenerationInput } from './provider';

export type GenerationInputValidation =
  | { valid: false; errors: string[] }
  | { valid: true; errors: []; value: VideoGenerationInput };

export function validateGenerationInput(
  input: unknown,
): GenerationInputValidation {
  const errors: string[] = [];
  const values =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  if (typeof values.prompt !== 'string' || values.prompt.trim().length < 10) {
    errors.push('Prompt must include at least 10 characters.');
  }

  if (!['text-to-video', 'image-to-video'].includes(String(values.mode))) {
    errors.push('A supported video generation mode is required.');
  }

  if (!['wan-2.2-t2v', 'wan-2.2-i2v', 'wan-2.2-fast', 'custom'].includes(String(values.model))) {
    errors.push('A supported video generation model is required.');
  }

  if (!['16:9', '9:16', '1:1'].includes(String(values.aspectRatio))) {
    errors.push('A supported aspect ratio is required.');
  }

  if (
    typeof values.duration !== 'number' ||
    !Number.isInteger(values.duration) ||
    values.duration < 4 ||
    values.duration > 30
  ) {
    errors.push('Duration must be a whole number between 4 and 30 seconds.');
  }

  if (typeof values.resolution !== 'string' || !/^[1-9]\d*x[1-9]\d*$/.test(values.resolution)) {
    errors.push('Resolution must follow a width x height format, e.g. 1280x720.');
  }

  if (values.negativePrompt !== undefined && typeof values.negativePrompt !== 'string') {
    errors.push('Negative prompt must be text.');
  }

  if (
    values.id !== undefined &&
    (typeof values.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        values.id,
      ))
  ) {
    errors.push('Request ID must be a UUID.');
  }

  if (
    values.imageFileName !== undefined &&
    (typeof values.imageFileName !== 'string' || values.imageFileName.length === 0)
  ) {
    errors.push('Image input must be a non-empty string.');
  }
  if (
    typeof values.imageFileName === 'string' &&
    values.imageFileName.length > 4_200_000
  ) {
    errors.push('Reference image is too large for the serverless request limit.');
  }

  if (values.mode === 'image-to-video' && !values.imageFileName) {
    errors.push('Image input is required for image-to-video generation.');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    value: {
      ...(typeof values.id === 'string' ? { id: values.id } : {}),
      mode: values.mode as VideoGenerationInput['mode'],
      model: values.model as VideoGenerationInput['model'],
      prompt: values.prompt as string,
      ...(typeof values.negativePrompt === 'string'
        ? { negativePrompt: values.negativePrompt }
        : {}),
      aspectRatio: values.aspectRatio as VideoGenerationInput['aspectRatio'],
      duration: values.duration as number,
      resolution: values.resolution as string,
      ...(typeof values.imageFileName === 'string'
        ? { imageFileName: values.imageFileName }
        : {}),
    },
  };
}
