import { supabase } from './supabase';
import { validateGenerationInput } from './providerValidation';
import type { GenerationJob } from '../types';

export { validateGenerationInput } from './providerValidation';

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
  outcomeUnknown?: boolean;
  jobId?: string;
  providerJobId?: string;
  message: string;
  outputUrl?: string;
  progress?: number;
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

async function simulateVideoGeneration(
  _input: VideoGenerationInput,
): Promise<GenerationSubmissionResult> {
  const jobId = `dev-job-${Math.random().toString(36).slice(2, 10)}`;

  return {
    ok: true,
    status: 'queued',
    jobId,
    message: 'Demo mock only: no video was generated or sent to a provider.',
    progress: 0,
  };
}

async function getAuthorizationHeader(): Promise<
  { ok: true; authorization: string } | { ok: false; message: string }
> {
  if (!supabase) {
    return {
      ok: false,
      message: 'Supabase must be configured and a user must be signed in for WAN generation.',
    };
  }

  try {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.access_token) {
      return {
        ok: false,
        message: 'Sign in with Supabase before submitting a WAN generation request.',
      };
    }

    return {
      ok: true,
      authorization: `Bearer ${data.session.access_token}`,
    };
  } catch {
    return {
      ok: false,
      message: 'The Supabase session could not be read.',
    };
  }
}

function isGenerationStatus(value: unknown): value is GenerationStatus {
  return (
    value === 'queued' ||
    value === 'processing' ||
    value === 'completed' ||
    value === 'failed'
  );
}

function isModelType(value: unknown): value is GenerationJob['model'] {
  return (
    value === 'wan-2.2-t2v' ||
    value === 'wan-2.2-i2v' ||
    value === 'wan-2.2-fast' ||
    value === 'custom'
  );
}

function isVideoMode(value: unknown): value is GenerationJob['mode'] {
  return value === 'text-to-video' || value === 'image-to-video';
}

function isAspectRatio(value: unknown): value is GenerationJob['aspectRatio'] {
  return value === '16:9' || value === '9:16' || value === '1:1';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readApiResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function getApiErrorMessage(value: unknown, fallback: string): string {
  return isRecord(value) && typeof value.message === 'string'
    ? value.message
    : fallback;
}

function getApiErrorCode(value: unknown): string | undefined {
  return isRecord(value) && typeof value.code === 'string'
    ? value.code
    : undefined;
}

async function authenticatedApiRequest(
  url: string,
  init: RequestInit = {},
): Promise<Response | undefined> {
  const authorization = await getAuthorizationHeader();
  if (!authorization.ok) {
    throw new Error(authorization.message);
  }

  return fetch(url, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: authorization.authorization,
    },
  });
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

  const authorization = await getAuthorizationHeader();
  if (!authorization.ok) {
    return {
      ok: false,
      status: 'failed',
      message: authorization.message,
    };
  }

  try {
    const requestInput: VideoGenerationInput = {
      ...input,
      id: input.id ?? crypto.randomUUID(),
    };
    const response = await fetch('/api/wan22', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization.authorization,
      },
      body: JSON.stringify({
        action: 'submit',
        payload: requestInput,
      }),
    });

    const result = await readApiResponse(response);
    if (!response.ok) {
      const code = getApiErrorCode(result);
      return {
        ok: false,
        status: 'failed',
        outcomeUnknown:
          code === 'PROVIDER_OUTCOME_UNKNOWN' ||
          code === 'HF_SUBMISSION_OUTCOME_UNKNOWN' ||
          code === 'INVALID_PROVIDER_RESPONSE' ||
          code === 'CREDIT_RESERVATION_OUTCOME_UNKNOWN' ||
          code === 'DUPLICATE_REQUEST_OUTCOME_UNKNOWN' ||
          code === 'DATABASE_UNAVAILABLE',
        message: getApiErrorMessage(result, 'GPU submission failed.'),
      };
    }

    if (
      !isRecord(result) ||
      result.ok !== true ||
      !isGenerationStatus(result.status) ||
      typeof result.jobId !== 'string' ||
      typeof result.providerJobId !== 'string' ||
      typeof result.message !== 'string'
    ) {
      return {
        ok: false,
        status: 'failed',
        outcomeUnknown: true,
        message: 'The WAN API returned an invalid response.',
      };
    }

    return {
      ok: true,
      outcomeUnknown: false,
      status: result.status,
      jobId: result.jobId,
      providerJobId: result.providerJobId,
      message: result.message,
      outputUrl: typeof result.outputUrl === 'string' ? result.outputUrl : undefined,
      progress: typeof result.progress === 'number' ? result.progress : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      outcomeUnknown: true,
      message: error instanceof Error ? error.message : 'Unknown provider error.',
    };
  }
}

export async function listVideoJobs(): Promise<{
  jobs: GenerationJob[];
  error?: string;
}> {
  try {
    const response = await authenticatedApiRequest('/api/wan22?action=list');
    if (!response) {
      return { jobs: [], error: 'Supabase sign-in is required to load generation history.' };
    }

    const body = await readApiResponse(response);
    if (!response.ok) {
      return {
        jobs: [],
        error: getApiErrorMessage(body, 'Generation history could not be loaded.'),
      };
    }
    if (!isRecord(body) || body.ok !== true || !Array.isArray(body.jobs)) {
      return { jobs: [], error: 'The history API returned an invalid response.' };
    }

    const jobs: GenerationJob[] = [];
    for (const row of body.jobs) {
      if (
        !isRecord(row) ||
        typeof row.id !== 'string' ||
        typeof row.prompt !== 'string' ||
        !isModelType(row.model) ||
        !isVideoMode(row.mode) ||
        !isAspectRatio(row.aspectRatio) ||
        typeof row.duration !== 'number' ||
        !Number.isInteger(row.duration) ||
        row.duration < 4 ||
        row.duration > 30 ||
        typeof row.resolution !== 'string' ||
        !isGenerationStatus(row.status) ||
        typeof row.progress !== 'number' ||
        !Number.isInteger(row.progress) ||
        row.progress < 0 ||
        row.progress > 100 ||
        typeof row.createdAt !== 'string' ||
        (row.provider !== 'wan22' &&
          row.provider !== 'huggingface' &&
          row.provider !== 'development')
      ) {
        return { jobs: [], error: 'The history API returned an invalid job record.' };
      }

      jobs.push({
        id: row.id,
        provider: row.provider,
        model: row.model,
        mode: row.mode,
        prompt: row.prompt,
        negativePrompt:
          typeof row.negativePrompt === 'string' ? row.negativePrompt : undefined,
        aspectRatio: row.aspectRatio,
        duration: row.duration,
        resolution: row.resolution,
        status: row.status,
        progress: row.progress,
        providerJobId:
          typeof row.providerJobId === 'string' ? row.providerJobId : undefined,
        errorMessage:
          typeof row.errorMessage === 'string' ? row.errorMessage : undefined,
        createdAt: row.createdAt,
        completedAt:
          typeof row.completedAt === 'string' ? row.completedAt : undefined,
        outputUrl:
          typeof row.outputUrl === 'string' ? row.outputUrl : undefined,
      });
    }

    return { jobs };
  } catch (error) {
    return {
      jobs: [],
      error:
        error instanceof Error
          ? error.message
          : 'Generation history could not be loaded.',
    };
  }
}

export async function getCreditBalance(): Promise<{
  balance?: number;
  error?: string;
}> {
  try {
    const response = await authenticatedApiRequest('/api/wan22?action=credits');
    if (!response) {
      return { error: 'Supabase sign-in is required to load credits.' };
    }

    const body = await readApiResponse(response);
    if (
      !response.ok ||
      !isRecord(body) ||
      body.ok !== true ||
      typeof body.balance !== 'number' ||
      body.balance < 0
    ) {
      return {
        error: getApiErrorMessage(body, 'Credit balance could not be loaded.'),
      };
    }

    return { balance: body.balance };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : 'Credit balance could not be loaded.',
    };
  }
}

export async function pollVideoJob(
  providerJobId: string,
): Promise<GenerationSubmissionResult> {
  const providerMode = import.meta.env.VITE_WAN22_MODE || 'development';

  if (providerMode === 'development') {
    return {
      ok: true,
      status: 'queued',
      providerJobId,
      message: 'Demo mock only: provider polling is not connected and no video was generated.',
    };
  }

  try {
    const response = await authenticatedApiRequest(
      `/api/wan22?action=status&id=${encodeURIComponent(providerJobId)}`,
    );
    if (!response) {
      return {
        ok: false,
        status: 'failed',
        providerJobId,
        message: 'Supabase sign-in is required to poll generation status.',
      };
    }
    const result = await readApiResponse(response);
    if (!response.ok) {
      return {
        ok: false,
        status: 'failed',
        providerJobId,
        message: getApiErrorMessage(result, 'Unable to fetch provider status.'),
      };
    }

    if (
      !isRecord(result) ||
      result.ok !== true ||
      !isGenerationStatus(result.status) ||
      typeof result.message !== 'string'
    ) {
      return {
        ok: false,
        status: 'failed',
        providerJobId,
        message: 'The WAN API returned an invalid status response.',
      };
    }

    return {
      ok: true,
      status: result.status,
      providerJobId:
        typeof result.providerJobId === 'string'
          ? result.providerJobId
          : providerJobId,
      message: result.message,
      progress: typeof result.progress === 'number' ? result.progress : undefined,
      outputUrl: typeof result.outputUrl === 'string' ? result.outputUrl : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      providerJobId,
      message:
        error instanceof Error ? error.message : 'Unable to fetch provider status.',
    };
  }
}
