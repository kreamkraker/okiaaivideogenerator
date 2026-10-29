import { Buffer } from 'node:buffer';
import type { VideoGenerationInput } from '../src/lib/provider';

const spaceBaseUrl =
  'https://makiblek-wan-2-2-i2v-14b-custom-lora-wow.hf.space';
const requestTimeoutMs = 8_000;

export const generateVideoParameters = [
  'input_image',
  'last_image',
  'prompt',
  'steps',
  'negative_prompt',
  'duration_seconds',
  'guidance_scale',
  'guidance_scale_2',
  'seed',
  'randomize_seed',
  'quality',
  'scheduler',
  'flow_shift',
  'frame_multiplier',
  'safe_mode',
  'lora1_preset',
  'lora1_high_scale',
  'lora1_low_scale',
  'lora2_preset',
  'lora2_high_scale',
  'lora2_low_scale',
  'lora3_preset',
  'lora3_high_scale',
  'lora3_low_scale',
  'my1_repo',
  'my1_high',
  'my1_hs',
  'my1_low',
  'my1_ls',
  'my2_repo',
  'my2_high',
  'my2_hs',
  'my2_low',
  'my2_ls',
  'my3_repo',
  'my3_high',
  'my3_hs',
  'my3_low',
  'my3_ls',
  'my4_repo',
  'my4_high',
  'my4_hs',
  'my4_low',
  'my4_ls',
  'my5_repo',
  'my5_high',
  'my5_hs',
  'my5_low',
  'my5_ls',
  'video_component',
] as const;

type JsonRecord = Record<string, unknown>;

export class HuggingFaceSpaceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
    readonly outcomeUnknown = false,
  ) {
    super(message);
  }
}

export interface HuggingFaceStatus {
  status: 'queued' | 'processing' | 'completed' | 'failed';
  progress: number;
  message: string;
  outputUrl?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs = requestTimeoutMs,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new HuggingFaceSpaceError(
        'The Hugging Face Space request timed out.',
        'HF_SPACE_TIMEOUT',
        504,
        true,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function authorizationHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function describeHttpFailure(response: Response): HuggingFaceSpaceError {
  if (response.status === 401 || response.status === 403) {
    return new HuggingFaceSpaceError(
      'Hugging Face rejected the configured server-side token.',
      'HF_AUTH_FAILED',
      502,
    );
  }
  if (response.status === 429) {
    return new HuggingFaceSpaceError(
      'The Hugging Face Space quota or request limit was reached.',
      'HF_QUOTA_EXHAUSTED',
      429,
    );
  }
  if (response.status >= 500) {
    return new HuggingFaceSpaceError(
      'The Hugging Face Space is temporarily unavailable.',
      'HF_SPACE_UNAVAILABLE',
      502,
      true,
    );
  }
  return new HuggingFaceSpaceError(
    'The Hugging Face Space rejected the request.',
    'HF_REQUEST_REJECTED',
    502,
  );
}

async function readGenerationSchema(token: string): Promise<{
  fnIndex: number;
  parameterNames: string[];
}> {
  const [infoResponse, configResponse] = await Promise.all([
    fetchWithTimeout(`${spaceBaseUrl}/gradio_api/info`, {
      headers: authorizationHeaders(token),
    }),
    fetchWithTimeout(`${spaceBaseUrl}/config`, {
      headers: authorizationHeaders(token),
    }),
  ]);
  if (!infoResponse.ok) throw describeHttpFailure(infoResponse);
  if (!configResponse.ok) throw describeHttpFailure(configResponse);

  const [info, config] = await Promise.all([
    readJson(infoResponse),
    readJson(configResponse),
  ]);
  const parameters =
    isRecord(info) &&
    isRecord(info.named_endpoints) &&
    isRecord(info.named_endpoints['/generate_video']) &&
    Array.isArray(info.named_endpoints['/generate_video'].parameters)
      ? info.named_endpoints['/generate_video'].parameters
      : undefined;
  const dependency = isRecord(config)
    ? (Array.isArray(config.dependencies)
        ? config.dependencies.find(
            (entry) => isRecord(entry) && entry.api_name === 'generate_video',
          )
        : undefined)
    : undefined;

  if (
    !parameters ||
    parameters.length !== generateVideoParameters.length ||
    !parameters.every(
      (parameter, index) =>
        isRecord(parameter) &&
        parameter.parameter_name === generateVideoParameters[index],
    ) ||
    !isRecord(dependency) ||
    typeof dependency.id !== 'number' ||
    !isRecord(config) ||
    config.enable_queue !== true
  ) {
    throw new HuggingFaceSpaceError(
      'The Hugging Face Space API schema changed; generation is disabled until it is reviewed.',
      'HF_API_SCHEMA_CHANGED',
      503,
    );
  }

  return {
    fnIndex: dependency.id,
    parameterNames: parameters.map((parameter) =>
      isRecord(parameter) && typeof parameter.parameter_name === 'string'
        ? parameter.parameter_name
        : '',
    ),
  };
}

function parseImageDataUrl(value: string): {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
} {
  const match =
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) {
    throw new HuggingFaceSpaceError(
      'A PNG, JPEG, or WEBP reference image is required.',
      'HF_IMAGE_INVALID',
      400,
    );
  }

  const bytes = Buffer.from(match[2], 'base64');
  if (
    bytes.length === 0 ||
    bytes.length > 3 * 1024 * 1024 ||
    bytes.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')
  ) {
    throw new HuggingFaceSpaceError(
      'The reference image is invalid or exceeds 3 MB.',
      'HF_IMAGE_INVALID',
      400,
    );
  }

  const signatures = {
    png: [137, 80, 78, 71, 13, 10, 26, 10],
    jpeg: [255, 216, 255],
  } as const;
  const validSignature =
    match[1] === 'webp'
      ? bytes.length >= 12 &&
        bytes.toString('ascii', 0, 4) === 'RIFF' &&
        bytes.toString('ascii', 8, 12) === 'WEBP'
      : signatures[match[1] as keyof typeof signatures].every(
          (byte, index) => bytes[index] === byte,
        );
  if (!validSignature) {
    throw new HuggingFaceSpaceError(
      'The reference image bytes do not match their declared image type.',
      'HF_IMAGE_INVALID',
      400,
    );
  }

  const mimeType = `image/${match[1]}`;
  return {
    bytes,
    mimeType,
    fileName: `reference.${match[1] === 'jpeg' ? 'jpg' : match[1]}`,
  };
}

async function uploadImage(
  token: string,
  input: VideoGenerationInput,
): Promise<{ path: string; mimeType: string; fileName: string; size: number }> {
  if (!input.imageFileName) {
    throw new HuggingFaceSpaceError(
      'An input image is required for this Hugging Face Space.',
      'HF_IMAGE_REQUIRED',
      400,
    );
  }

  const image = parseImageDataUrl(input.imageFileName);
  const form = new FormData();
  form.append(
    'files',
    new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }),
    image.fileName,
  );

  const response = await fetchWithTimeout(`${spaceBaseUrl}/gradio_api/upload`, {
    method: 'POST',
    headers: authorizationHeaders(token),
    body: form,
  });
  if (!response.ok) throw describeHttpFailure(response);

  const result = await readJson(response);
  const path =
    Array.isArray(result) && typeof result[0] === 'string'
      ? result[0]
      : typeof result === 'string'
        ? result
        : undefined;
  if (!path || !path.startsWith('/')) {
    throw new HuggingFaceSpaceError(
      'Hugging Face returned an invalid image upload response.',
      'HF_UPLOAD_RESPONSE_INVALID',
      502,
    );
  }

  return {
    path,
    mimeType: image.mimeType,
    fileName: image.fileName,
    size: image.bytes.length,
  };
}

function makeGenerationData(
  parameterNames: string[],
  input: VideoGenerationInput,
  image: { path: string; mimeType: string; fileName: string; size: number },
): unknown[] {
  const values: Record<string, unknown> = {
    input_image: {
      path: image.path,
      size: image.size,
      orig_name: image.fileName,
      mime_type: image.mimeType,
      is_stream: false,
      meta: { _type: 'gradio.FileData' },
    },
    last_image: null,
    prompt: input.prompt,
    steps: 6,
    negative_prompt: input.negativePrompt ?? '',
    duration_seconds: input.duration,
    guidance_scale: 1,
    guidance_scale_2: 1,
    seed: 42,
    randomize_seed: true,
    quality: 6,
    scheduler: 'UniPCMultistep',
    flow_shift: 3,
    frame_multiplier: '16',
    safe_mode: true,
    lora1_preset: '(None)',
    lora1_high_scale: 1,
    lora1_low_scale: 1,
    lora2_preset: '(None)',
    lora2_high_scale: 1,
    lora2_low_scale: 1,
    lora3_preset: '(None)',
    lora3_high_scale: 1,
    lora3_low_scale: 1,
    video_component: true,
  };

  for (let index = 1; index <= 5; index += 1) {
    values[`my${index}_repo`] = '';
    values[`my${index}_high`] = '(None)';
    values[`my${index}_hs`] = 1;
    values[`my${index}_low`] = '(None)';
    values[`my${index}_ls`] = 1;
  }

  return parameterNames.map((name) => values[name]);
}

export async function submitHuggingFaceSpaceJob(
  input: VideoGenerationInput,
  sessionHash: string,
  token: string,
): Promise<void> {
  if (input.mode !== 'image-to-video' || input.duration > 20) {
    throw new HuggingFaceSpaceError(
      'This Hugging Face Space supports image-to-video jobs up to 20 seconds.',
      'HF_INPUT_UNSUPPORTED',
      400,
    );
  }

  let schema: Awaited<ReturnType<typeof readGenerationSchema>>;
  let image: Awaited<ReturnType<typeof uploadImage>>;
  try {
    schema = await readGenerationSchema(token);
    image = await uploadImage(token, input);
  } catch (error) {
    if (error instanceof HuggingFaceSpaceError) {
      throw new HuggingFaceSpaceError(
        error.message,
        error.code,
        error.statusCode,
      );
    }
    throw new HuggingFaceSpaceError(
      'The Hugging Face Space could not prepare the request.',
      'HF_SPACE_UNAVAILABLE',
      502,
    );
  }
  const data = makeGenerationData(schema.parameterNames, input, image);

  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${spaceBaseUrl}/gradio_api/queue/join`,
      {
        method: 'POST',
        headers: {
          ...authorizationHeaders(token),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data,
          fn_index: schema.fnIndex,
          session_hash: sessionHash,
        }),
      },
    );
  } catch (error) {
    if (error instanceof HuggingFaceSpaceError) {
      throw new HuggingFaceSpaceError(
        'The Hugging Face queue submission outcome is unknown. The reserved credits remain held while the job is reconciled.',
        'HF_SUBMISSION_OUTCOME_UNKNOWN',
        504,
        true,
      );
    }
    throw new HuggingFaceSpaceError(
      'The Hugging Face queue submission outcome is unknown. The reserved credits remain held while the job is reconciled.',
      'HF_SUBMISSION_OUTCOME_UNKNOWN',
      502,
      true,
    );
  }

  if (!response.ok) {
    const error = describeHttpFailure(response);
    if (response.status >= 500) {
      throw new HuggingFaceSpaceError(
        'The Hugging Face queue response was inconclusive. The reserved credits remain held while the job is reconciled.',
        'HF_SUBMISSION_OUTCOME_UNKNOWN',
        502,
        true,
      );
    }
    throw error;
  }

  const result = await readJson(response);
  if (
    !isRecord(result) ||
    typeof result.event_id !== 'string' ||
    result.event_id.length === 0
  ) {
    throw new HuggingFaceSpaceError(
      'The Hugging Face queue response was malformed. The reserved credits remain held while the submission is reconciled.',
      'HF_SUBMISSION_OUTCOME_UNKNOWN',
      502,
      true,
    );
  }
}

function getOutputUrl(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.url !== 'string') return undefined;
  try {
    const url = new URL(value.url, spaceBaseUrl);
    return url.protocol === 'https:' &&
      url.hostname === 'makiblek-wan-2-2-i2v-14b-custom-lora-wow.hf.space'
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function parseQueueMessage(value: unknown): HuggingFaceStatus | undefined {
  if (!isRecord(value) || typeof value.msg !== 'string') return undefined;

  if (value.msg === 'estimation') {
    return {
      status: 'queued',
      progress: 0,
      message: 'Waiting for the Hugging Face ZeroGPU queue.',
    };
  }
  if (value.msg === 'process_starts' || value.msg === 'progress') {
    return {
      status: 'processing',
      progress: 0,
      message: 'The Hugging Face Space is generating the video.',
    };
  }
  if (value.msg === 'queue_full') {
    return {
      status: 'failed',
      progress: 0,
      message: 'The Hugging Face Space queue is full. Credits will be refunded.',
    };
  }
  if (value.msg === 'process_completed') {
    const output = isRecord(value.output) ? value.output : undefined;
    const data = output && Array.isArray(output.data) ? output.data : undefined;
    const videoUrl = data ? getOutputUrl(data[0]) : undefined;
    if (value.success === true && videoUrl) {
      return {
        status: 'completed',
        progress: 100,
        outputUrl: videoUrl,
        message:
          'Video generation completed. The Space-hosted download link may expire; download the result now.',
      };
    }
    if (value.success === true) {
      return {
        status: 'completed',
        progress: 100,
        message:
          'Video generation completed, but the Space did not return a usable temporary video URL.',
      };
    }
    return {
      status: 'failed',
      progress: 0,
      message: 'The Hugging Face Space reported that video generation failed.',
    };
  }
  if (value.msg === 'unexpected_error') {
    return {
      status: 'failed',
      progress: 0,
      message: 'The Hugging Face Space reported a generation failure.',
    };
  }
  return undefined;
}

function readSseEvent(block: string): HuggingFaceStatus | undefined {
  const data = block
    .split(/\r?\n/)
    .find((line) => line.startsWith('data:'))
    ?.slice(5)
    .trim();
  if (!data) return undefined;

  try {
    return parseQueueMessage(JSON.parse(data));
  } catch {
    return undefined;
  }
}

export async function pollHuggingFaceSpaceJob(
  sessionHash: string,
  token: string,
): Promise<HuggingFaceStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  let responseReceived = false;
  let latestStatus: HuggingFaceStatus = {
    status: 'queued',
    progress: 0,
    message: 'Waiting for the Hugging Face ZeroGPU queue.',
  };

  try {
    const response = await fetch(
      `${spaceBaseUrl}/gradio_api/queue/data?session_hash=${encodeURIComponent(sessionHash)}`,
      {
        headers: {
          ...authorizationHeaders(token),
          Accept: 'text/event-stream',
        },
        signal: controller.signal,
      },
    );
    responseReceived = true;
    if (!response.ok) throw describeHttpFailure(response);
    if (!response.body) {
      throw new HuggingFaceSpaceError(
        'The Hugging Face queue returned no status stream.',
        'HF_STATUS_STREAM_INVALID',
        502,
        true,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let receivedStatus = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const status = readSseEvent(block);
        if (!status) continue;
        receivedStatus = true;
        latestStatus = status;
        if (status.status === 'completed' || status.status === 'failed') {
          await reader.cancel();
          return status;
        }
      }
    }

    if (buffer) {
      const status = readSseEvent(buffer);
      if (status) {
        receivedStatus = true;
        latestStatus = status;
      }
    }
    if (!receivedStatus) {
      throw new HuggingFaceSpaceError(
        'The Hugging Face queue returned no valid status events.',
        'HF_STATUS_STREAM_INVALID',
        502,
        true,
      );
    }
    return latestStatus;
  } catch (error) {
    if (controller.signal.aborted && responseReceived) return latestStatus;
    if (error instanceof HuggingFaceSpaceError) throw error;
    throw new HuggingFaceSpaceError(
      'The Hugging Face job status could not be reached; its state remains unchanged.',
      'HF_STATUS_UNAVAILABLE',
      502,
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
}
