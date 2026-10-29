export type GenerationStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface VideoGenerationInput {
  id?: string;
  mode: 'text-to-video' | 'image-to-video';
  model: 'wan-2.2-t2v' | 'wan-2.2-i2v' | 'wan-2.2-fast' | 'custom';
  prompt: string;
  negativePrompt?: string;
  aspectRatio: '16:9' | '9:16' | '1:1';
  duration: number;
  resolution: string;
  imageFileName?: string;
}

export interface GenerationSubmissionResult {
  ok: boolean;
  status: GenerationStatus;
  providerJobId?: string;
  message: string;
  outputUrl?: string;
  progress?: number;
}

export function validateGenerationInput(input: Partial<VideoGenerationInput>) {
  const errors: string[] = [];

  if (!input.prompt || input.prompt.trim().length < 10) {
    errors.push('Prompt must include at least 10 characters.');
  }

  if (input.mode === 'image-to-video' && !input.imageFileName) {
    errors.push('Image input is required for image-to-video generation.');
  }

  if (input.duration && (input.duration < 4 || input.duration > 30)) {
    errors.push('Duration must be between 4 and 30 seconds.');
  }

  if (input.resolution && !/^\d+x\d+$/.test(input.resolution)) {
    errors.push('Resolution must follow a width x height format, e.g. 1280x720.');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function advanceGenerationStatus(status: GenerationStatus): GenerationStatus {
  switch (status) {
    case 'queued':
      return 'processing';
    case 'processing':
      return 'completed';
    case 'completed':
      return 'completed';
    default:
      return 'failed';
  }
}

async function simulateVideoGeneration(input: VideoGenerationInput): Promise<GenerationSubmissionResult> {
  const jobId = `dev-job-${Math.random().toString(36).slice(2, 10)}`;

  return {
    ok: true,
    status: 'queued',
    providerJobId: jobId,
    message: 'Development adapter accepted the generation request and will simulate processing.',
    progress: 0,
  };
}

export async function submitVideoJob(
  input: VideoGenerationInput,
): Promise<GenerationSubmissionResult> {
  const validation = validateGenerationInput(input);

  if (!validation.valid) {
    return {
      ok: false,
      status: 'failed',
      message: validation.errors[0],
    };
  }

  const providerMode = import.meta.env.VITE_WAN22_MODE || 'development';

  if (providerMode === 'development') {
    return simulateVideoGeneration(input);
  }

  try {
    const response = await fetch('/api/wan22', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'submit',
        payload: input,
      }),
    });

    if (!response.ok) {
      throw new Error('GPU submission failed.');
    }

    const result = await response.json();
    return {
      ok: true,
      status: result.status || 'queued',
      providerJobId: result.providerJobId,
      message: result.message || 'Provider accepted the generation request.',
      outputUrl: result.outputUrl,
    };
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      message: error instanceof Error ? error.message : 'Unknown provider error.',
    };
  }
}

export async function pollVideoJob(providerJobId: string): Promise<GenerationSubmissionResult> {
  const providerMode = import.meta.env.VITE_WAN22_MODE || 'development';

  if (providerMode === 'development') {
    const nextStatus = Math.random() > 0.5 ? 'processing' : 'completed';
    return {
      ok: true,
      status: nextStatus,
      providerJobId,
      message: 'Development adapter simulated provider polling.',
      progress: nextStatus === 'completed' ? 100 : 68,
      outputUrl: nextStatus === 'completed' ? 'https://example.com/generated-video.mp4' : undefined,
    };
  }

  const response = await fetch(`/api/wan22?action=status&id=${providerJobId}`);

  if (!response.ok) {
    throw new Error('Unable to fetch provider status.');
  }

  return response.json();
}
