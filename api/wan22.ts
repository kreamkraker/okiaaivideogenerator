import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { VideoGenerationInput } from '../src/lib/provider';
import { validateGenerationInput } from '../src/lib/providerValidation';
import {
  HuggingFaceSpaceError,
  pollHuggingFaceSpaceJob,
  submitHuggingFaceSpaceJob,
} from '../server/huggingfaceSpace';

const requestTimeoutMs = 15_000;
const generationStatuses = new Set(['queued', 'processing', 'completed', 'failed']);

type JsonRecord = Record<string, unknown>;

class RequestTimeoutError extends Error {}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendError(
  res: VercelResponse,
  statusCode: number,
  code: string,
  message: string,
) {
  return res.status(statusCode).json({
    ok: false,
    status: 'failed',
    code,
    message,
  });
}

function getQueryValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getConfiguration() {
  const providerName = process.env.WAN22_PROVIDER?.trim() || 'wan22';
  if (providerName !== 'wan22' && providerName !== 'huggingface') {
    return {
      error: {
        statusCode: 503,
        code: 'VIDEO_PROVIDER_INVALID',
        message: 'WAN22_PROVIDER must be wan22 or huggingface.',
      },
    } as const;
  }

  const providerUrl = process.env.WAN22_API_URL?.trim();
  const providerApiKey = process.env.WAN22_API_KEY?.trim();
  const supabaseUrl = (
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    ''
  ).trim();
  const supabaseAnonKey = (
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    ''
  ).trim();
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    return {
      error: {
        statusCode: 503,
        code: 'SUPABASE_SERVER_CONFIG_NOT_CONFIGURED',
        message: 'Supabase URL, public anon or publishable key, and server-side service-role key are required.',
      },
    } as const;
  }

  let parsedSupabaseUrl: URL;
  try {
    parsedSupabaseUrl = new URL(supabaseUrl);
  } catch {
    return {
      error: {
        statusCode: 503,
        code: 'SUPABASE_URL_INVALID',
        message: 'The configured Supabase URL is invalid.',
      },
    } as const;
  }

  if (
    !['http:', 'https:'].includes(parsedSupabaseUrl.protocol) ||
    parsedSupabaseUrl.username ||
    parsedSupabaseUrl.password ||
    parsedSupabaseUrl.search ||
    parsedSupabaseUrl.hash
  ) {
    return {
      error: {
        statusCode: 503,
        code: 'SUPABASE_URL_INVALID',
        message: 'The configured Supabase URL must be an HTTP or HTTPS URL.',
      },
    } as const;
  }

  let providerBaseUrl: string | undefined;
  let providerConfigurationError:
    | { code: string; message: string }
    | undefined;
  const hfToken = process.env.HF_TOKEN?.trim();
  const hfSpaceEnabled = process.env.HF_SPACE_PROVIDER_ENABLED === 'true';
  if (providerName === 'huggingface') {
    if (!hfSpaceEnabled || !hfToken) {
      providerConfigurationError = {
        code: 'HF_SPACE_NOT_CONFIGURED',
        message: 'The Hugging Face Space provider is disabled or its server-side HF_TOKEN is not configured.',
      };
    }
  } else if (!providerUrl || !providerApiKey) {
    providerConfigurationError = {
      code: 'WAN_PROVIDER_NOT_CONFIGURED',
      message: 'WAN22_API_URL and WAN22_API_KEY must be configured server-side.',
    };
  } else {
    try {
      const parsedProviderUrl = new URL(providerUrl);
      if (
        !['http:', 'https:'].includes(parsedProviderUrl.protocol) ||
        parsedProviderUrl.username ||
        parsedProviderUrl.password ||
        parsedProviderUrl.search ||
        parsedProviderUrl.hash
      ) {
        throw new Error('invalid provider URL');
      }
      providerBaseUrl = parsedProviderUrl.toString().replace(/\/+$/, '');
    } catch {
      providerConfigurationError = {
        code: 'WAN_PROVIDER_URL_INVALID',
        message: 'WAN22_API_URL must be an HTTP or HTTPS URL without credentials or query parameters.',
      };
    }
  }

  const parsedCreditCost = Number(process.env.WAN22_GENERATION_CREDIT_COST);
  const generationCreditCost =
    Number.isFinite(parsedCreditCost) && parsedCreditCost > 0
      ? parsedCreditCost
      : undefined;

  return {
    providerName,
    providerBaseUrl,
    providerApiKey,
    hfToken,
    hfSpaceEnabled,
    supabaseUrl: parsedSupabaseUrl.toString().replace(/\/+$/, ''),
    supabaseAnonKey,
    supabaseServiceRoleKey,
    providerConfigurationError,
    providerContractConfirmed:
      process.env.WAN22_PROVIDER_CONTRACT_CONFIRMED === 'true',
    generationCreditCost,
  } as const;
}

type Configuration = Exclude<
  ReturnType<typeof getConfiguration>,
  { error: { statusCode: number } }
>;

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new RequestTimeoutError();
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function authenticateRequest(
  req: VercelRequest,
  configuration: Configuration,
): Promise<
  | { status: 'authenticated'; userId: string }
  | { status: 'unauthorized' }
  | { status: 'unavailable' }
> {
  const authorization = req.headers.authorization;
  const match =
    typeof authorization === 'string'
      ? /^Bearer\s+([^\s]+)$/i.exec(authorization)
      : null;

  if (!match) {
    return { status: 'unauthorized' };
  }

  try {
    const response = await fetchWithTimeout(
      `${configuration.supabaseUrl}/auth/v1/user`,
      {
        headers: {
          apikey: configuration.supabaseAnonKey,
          Authorization: `Bearer ${match[1]}`,
          Accept: 'application/json',
        },
      },
    );

    if (response.status === 401 || response.status === 403) {
      return { status: 'unauthorized' };
    }

    if (!response.ok) {
      return { status: 'unavailable' };
    }

    const user = await readJson(response);
    if (!isRecord(user) || typeof user.id !== 'string' || user.id.length === 0) {
      return { status: 'unauthorized' };
    }

    return { status: 'authenticated', userId: user.id };
  } catch {
    return { status: 'unavailable' };
  }
}

function providerEndpoint(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl}/`).toString();
}

function databaseEndpoint(
  supabaseUrl: string,
  resource: string,
  query?: URLSearchParams,
): string {
  const url = new URL(`/rest/v1/${resource}`, `${supabaseUrl}/`);
  if (query) {
    url.search = query.toString();
  }
  return url.toString();
}

async function databaseRequest(
  configuration: Configuration,
  resource: string,
  init: RequestInit,
  query?: URLSearchParams,
): Promise<Response> {
  return fetchWithTimeout(
    databaseEndpoint(configuration.supabaseUrl, resource, query),
    {
      ...init,
      headers: {
        apikey: configuration.supabaseServiceRoleKey,
        Authorization: `Bearer ${configuration.supabaseServiceRoleKey}`,
        Accept: 'application/json',
        ...init.headers,
      },
    },
  );
}

async function callDatabaseFunction(
  configuration: Configuration,
  functionName: string,
  parameters: JsonRecord,
): Promise<unknown> {
  const response = await databaseRequest(
    configuration,
    `rpc/${functionName}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parameters),
    },
  );

  if (!response.ok) {
    throw new Error('Supabase function request failed.');
  }

  return readJson(response);
}

async function consumeGenerationRateLimit(
  configuration: Configuration,
  userId: string,
  requestId: string,
): Promise<boolean> {
  const result = await callDatabaseFunction(
    configuration,
    'consume_generation_rate_limit',
    { p_user_id: userId, p_request_id: requestId },
  );
  if (typeof result !== 'boolean') {
    throw new Error('Supabase returned an invalid rate-limit response.');
  }

  return result;
}

async function reserveGenerationCredits(
  configuration: Configuration,
  userId: string,
  jobId: string,
): Promise<boolean> {
  const result = await callDatabaseFunction(
    configuration,
    'reserve_generation_credits',
    {
      p_user_id: userId,
      p_job_id: jobId,
      p_credit_cost: configuration.generationCreditCost,
    },
  );
  if (typeof result !== 'boolean') {
    throw new Error('Supabase returned an invalid credit reservation response.');
  }

  return result;
}

async function refundGenerationCredits(
  configuration: Configuration,
  userId: string,
  jobId: string,
): Promise<boolean> {
  try {
    return (
      (await callDatabaseFunction(
        configuration,
        'refund_generation_credits',
        { p_user_id: userId, p_job_id: jobId },
      )) === true
    );
  } catch {
    return false;
  }
}

function validOutputUrl(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validProgress(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100
  );
}

function validStatus(value: unknown): value is string {
  return typeof value === 'string' && generationStatuses.has(value);
}

function validProviderJobId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    value.trim() === value &&
    !/[\u0000-\u001f]/.test(value)
  );
}

async function createJobRecord(
  configuration: Configuration,
  userId: string,
  payload: VideoGenerationInput,
): Promise<
  | {
      id: string;
      created: boolean;
      providerJobId?: string;
      providerStatus?: string;
      status: string;
      progress: number;
    }
  | undefined
> {
  const jobId = payload.id;
  if (!jobId) {
    return undefined;
  }

  const response = await databaseRequest(
    configuration,
    'generation_jobs',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=representation',
      },
      body: JSON.stringify({
        id: jobId,
        request_id: jobId,
        user_id: userId,
        provider: configuration.providerName,
        model: payload.model,
        mode: payload.mode,
        prompt: payload.prompt,
        negative_prompt: payload.negativePrompt ?? null,
        aspect_ratio: payload.aspectRatio,
        duration_seconds: payload.duration,
        resolution: payload.resolution,
        status: 'queued',
        progress: 0,
      }),
    },
    new URLSearchParams({ on_conflict: 'user_id,request_id' }),
  );

  if (!response.ok) {
    throw new Error('Supabase generation job creation failed.');
  }

  const rows = await readJson(response);
  if (Array.isArray(rows) && isRecord(rows[0]) && typeof rows[0].id === 'string') {
    return {
      id: rows[0].id,
      created: true,
      status: validStatus(rows[0].status) ? rows[0].status : 'queued',
      progress: validProgress(rows[0].progress) ? rows[0].progress : 0,
      ...(typeof rows[0].provider_job_id === 'string'
        ? { providerJobId: rows[0].provider_job_id }
        : {}),
      ...(typeof rows[0].provider_status === 'string'
        ? { providerStatus: rows[0].provider_status }
        : {}),
    };
  }

  const existingQuery = new URLSearchParams({
    select: 'id,provider_job_id,provider_status,status,progress',
    user_id: `eq.${userId}`,
    request_id: `eq.${jobId}`,
    limit: '1',
  });
  const existingResponse = await databaseRequest(
    configuration,
    'generation_jobs',
    { method: 'GET' },
    existingQuery,
  );
  if (!existingResponse.ok) {
    throw new Error('Supabase could not verify an idempotent job request.');
  }

  const existingRows = await readJson(existingResponse);
  if (!Array.isArray(existingRows) || !isRecord(existingRows[0]) || typeof existingRows[0].id !== 'string') {
    return undefined;
  }

  return {
    id: existingRows[0].id,
    created: false,
    status: validStatus(existingRows[0].status) ? existingRows[0].status : 'queued',
    progress: validProgress(existingRows[0].progress) ? existingRows[0].progress : 0,
    ...(typeof existingRows[0].provider_job_id === 'string'
      ? { providerJobId: existingRows[0].provider_job_id }
      : {}),
    ...(typeof existingRows[0].provider_status === 'string'
      ? { providerStatus: existingRows[0].provider_status }
      : {}),
  };
}

async function updateJobRecord(
  configuration: Configuration,
  userId: string,
  jobId: string,
  fields: JsonRecord,
): Promise<boolean> {
  const query = new URLSearchParams({
    id: `eq.${jobId}`,
    user_id: `eq.${userId}`,
  });

  try {
    const response = await databaseRequest(
      configuration,
      'generation_jobs',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      },
      query,
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function findOwnedJob(
  configuration: Configuration,
  userId: string,
  providerJobId: string,
): Promise<{
  id: string;
  provider: string;
  status: string;
  progress: number;
} | undefined> {
  const query = new URLSearchParams({
    select: 'id,provider,status,progress',
    user_id: `eq.${userId}`,
    provider_job_id: `eq.${providerJobId}`,
    limit: '1',
  });
  const response = await databaseRequest(
    configuration,
    'generation_jobs',
    { method: 'GET' },
    query,
  );

  if (!response.ok) {
    throw new Error('Supabase job lookup failed.');
  }

  const rows = await readJson(response);
  if (!Array.isArray(rows)) {
    throw new Error('Supabase returned an invalid job lookup response.');
  }
  if (rows.length === 0) {
    return undefined;
  }
  if (!isRecord(rows[0]) || typeof rows[0].id !== 'string') {
    throw new Error('Supabase returned an invalid job record.');
  }

  if (
    typeof rows[0].provider !== 'string' ||
    !validStatus(rows[0].status) ||
    !validProgress(rows[0].progress)
  ) {
    throw new Error('Supabase returned an invalid job record.');
  }

  return {
    id: rows[0].id,
    provider: rows[0].provider,
    status: rows[0].status,
    progress: rows[0].progress,
  };
}

async function storeGeneratedVideo(
  configuration: Configuration,
  userId: string,
  jobId: string,
  outputUrl: string,
): Promise<boolean> {
  try {
    const response = await databaseRequest(
      configuration,
      'generated_videos',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({
          user_id: userId,
          job_id: jobId,
          title: 'Generated video',
          public_url: outputUrl,
        }),
      },
      new URLSearchParams({ on_conflict: 'job_id' }),
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function listUserJobs(
  configuration: Configuration,
  userId: string,
): Promise<JsonRecord[] | undefined> {
  const query = new URLSearchParams({
    select:
      'id,provider,model,mode,prompt,negative_prompt,aspect_ratio,duration_seconds,resolution,status,progress,provider_job_id,error_message,created_at,completed_at,generated_videos(public_url)',
    user_id: `eq.${userId}`,
    order: 'created_at.desc',
    limit: '50',
  });
  const response = await databaseRequest(
    configuration,
    'generation_jobs',
    { method: 'GET' },
    query,
  );
  if (!response.ok) {
    return undefined;
  }

  const rows = await readJson(response);
  if (!Array.isArray(rows) || !rows.every(isRecord)) {
    return undefined;
  }
  return rows;
}

async function getUserCreditBalance(
  configuration: Configuration,
  userId: string,
): Promise<number | undefined> {
  const result = await callDatabaseFunction(
    configuration,
    'get_generation_credit_balance',
    { p_user_id: userId },
  );
  if (
    !Array.isArray(result) ||
    !isRecord(result[0]) ||
    (typeof result[0].balance !== 'number' &&
      typeof result[0].balance !== 'string')
  ) {
    return undefined;
  }

  const balance = Number(result[0].balance);
  return Number.isFinite(balance) && balance >= 0 ? balance : undefined;
}

function safeProviderMessage(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length <= 500 ? value : fallback;
}

function validateImageSignature(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    return 'Reference image must be a base64 data URL.';
  }

  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) {
    return 'Reference image must be a PNG, JPEG, or WEBP base64 data URL.';
  }

  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 3 * 1024 * 1024 || bytes.length === 0) {
    return 'Reference image must be no larger than 3 MB.';
  }
  if (bytes.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) {
    return 'Reference image contains invalid base64 data.';
  }

  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  const isPng =
    match[1] === 'png' &&
    pngSignature.every((byte, index) => bytes[index] === byte);
  const isJpeg =
    match[1] === 'jpeg' &&
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
  const isWebp =
    match[1] === 'webp' &&
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP';

  return isPng || isJpeg || isWebp
    ? undefined
    : 'Reference image bytes do not match their declared PNG, JPEG, or WEBP type.';
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET and POST are supported.');
  }

  const contentLength = Number(req.headers['content-length']);
  if (req.method === 'POST' && Number.isFinite(contentLength) && contentLength > 4_500_000) {
    return sendError(res, 413, 'REQUEST_TOO_LARGE', 'Request payload exceeds the serverless request limit.');
  }

  const body = isRecord(req.body) ? req.body : undefined;
  const action =
    getQueryValue(req.query.action) ??
    (typeof body?.action === 'string' ? body.action : undefined);
  const id =
    getQueryValue(req.query.id) ??
    (typeof body?.id === 'string' ? body.id : undefined);
  const isSubmit = req.method === 'POST' && action === 'submit';
  const isStatus = req.method === 'GET' && action === 'status';
  const isList = req.method === 'GET' && action === 'list';
  const isCredits = req.method === 'GET' && action === 'credits';

  if (!isSubmit && !isStatus && !isList && !isCredits) {
    return sendError(res, 400, 'UNSUPPORTED_ACTION', 'Unsupported WAN provider action.');
  }

  if (isStatus && !validProviderJobId(id)) {
    return sendError(res, 400, 'INVALID_JOB_ID', 'A valid provider job ID is required.');
  }

  let payload: VideoGenerationInput | undefined;
  if (isSubmit) {
    if (!body || !isRecord(body.payload)) {
      return sendError(res, 400, 'INVALID_INPUT', 'A generation payload is required.');
    }

    const validation = validateGenerationInput(body.payload);
    if (!validation.valid) {
      return sendError(res, 400, 'INVALID_INPUT', validation.errors[0]);
    }

    const validatedPayload = validation.value;
    if (!validatedPayload.id) {
      return sendError(res, 400, 'INVALID_INPUT', 'A UUID request ID is required for idempotent submission.');
    }
    const imageError = validateImageSignature(validatedPayload.imageFileName);
    if (imageError) {
      return sendError(res, 400, 'INVALID_IMAGE', imageError);
    }
    payload = validatedPayload;
  }

  const configuration = getConfiguration();
  if ('error' in configuration && configuration.error) {
    return sendError(
      res,
      configuration.error.statusCode,
      configuration.error.code,
      configuration.error.message,
    );
  }

  if (isSubmit || isStatus) {
    if (configuration.providerName === 'huggingface') {
      if (!configuration.hfSpaceEnabled || !configuration.hfToken) {
        return sendError(
          res,
          503,
          configuration.providerConfigurationError?.code ?? 'HF_SPACE_NOT_CONFIGURED',
          configuration.providerConfigurationError?.message ??
            'The Hugging Face Space provider is disabled or not configured.',
        );
      }
      if (
        isSubmit &&
        (payload?.mode !== 'image-to-video' ||
          payload.duration > 20 ||
          (payload?.prompt.length ?? 0) > 2000)
      ) {
        return sendError(
          res,
          400,
          payload?.prompt.length && payload.prompt.length > 2000
            ? 'HF_PROMPT_TOO_LONG'
            : 'HF_INPUT_UNSUPPORTED',
          payload?.prompt.length && payload.prompt.length > 2000
            ? 'Hugging Face prompts must not exceed 2,000 characters.'
            : 'The Hugging Face Space supports image-to-video jobs up to 20 seconds.',
        );
      }
    } else {
      if (!configuration.providerBaseUrl || !configuration.providerApiKey) {
        return sendError(
          res,
          503,
          configuration.providerConfigurationError?.code ?? 'WAN_PROVIDER_NOT_CONFIGURED',
          configuration.providerConfigurationError?.message ??
            'WAN provider URL and key must be configured server-side.',
        );
      }
      if (!configuration.providerContractConfirmed) {
        return sendError(
          res,
          503,
          'WAN_PROVIDER_CONTRACT_UNVERIFIED',
          'Real generation is disabled until the WAN worker request and response contract is verified.',
        );
      }
    }
    if (isSubmit && configuration.generationCreditCost === undefined) {
      return sendError(
        res,
        503,
        'GENERATION_CREDIT_COST_NOT_CONFIGURED',
        'Set a server-side generation credit cost only after provider pricing has been verified.',
      );
    }
  }

  const authentication = await authenticateRequest(req, configuration);
  if (authentication.status === 'unauthorized') {
    return sendError(res, 401, 'UNAUTHENTICATED', 'A valid Supabase access token is required.');
  }
  if (authentication.status === 'unavailable') {
    return sendError(res, 503, 'AUTHENTICATION_UNAVAILABLE', 'Supabase authentication could not be verified.');
  }

  const userId = authentication.userId;

  if (isCredits) {
    try {
      const balance = await getUserCreditBalance(configuration, userId);
      if (balance === undefined) {
        return sendError(res, 503, 'DATABASE_UNAVAILABLE', 'The credit balance could not be loaded.');
      }
      return res.status(200).json({ ok: true, balance });
    } catch {
      return sendError(res, 503, 'DATABASE_UNAVAILABLE', 'The credit balance could not be loaded.');
    }
  }

  if (isList) {
    try {
      const rows = await listUserJobs(configuration, userId);
      if (!rows) {
        return sendError(res, 503, 'DATABASE_UNAVAILABLE', 'Generation history could not be loaded.');
      }
      return res.status(200).json({
        ok: true,
        jobs: rows.map((row) => ({
          id: row.id,
          provider: row.provider,
          model: row.model,
          mode: row.mode,
          prompt: row.prompt,
          negativePrompt: row.negative_prompt ?? undefined,
          aspectRatio: row.aspect_ratio,
          duration: row.duration_seconds,
          resolution: row.resolution,
          status: row.status,
          progress: row.progress,
          providerJobId: row.provider_job_id ?? undefined,
          errorMessage: row.error_message ?? undefined,
          createdAt: row.created_at,
          completedAt: row.completed_at ?? undefined,
          outputUrl:
            Array.isArray(row.generated_videos) &&
            isRecord(row.generated_videos[0]) &&
            typeof row.generated_videos[0].public_url === 'string'
              ? row.generated_videos[0].public_url
              : undefined,
        })),
      });
    } catch {
      return sendError(res, 503, 'DATABASE_UNAVAILABLE', 'Generation history could not be loaded.');
    }
  }

  if (
    configuration.providerName === 'huggingface' &&
    (!configuration.hfSpaceEnabled || !configuration.hfToken)
  ) {
    return sendError(
      res,
      503,
      configuration.providerConfigurationError?.code ?? 'HF_SPACE_NOT_CONFIGURED',
      configuration.providerConfigurationError?.message ??
        'The Hugging Face Space provider is disabled or not configured.',
    );
  }
  if (
    configuration.providerName === 'wan22' &&
    (!configuration.providerBaseUrl || !configuration.providerApiKey)
  ) {
    return sendError(
      res,
      503,
      configuration.providerConfigurationError?.code ?? 'WAN_PROVIDER_NOT_CONFIGURED',
      configuration.providerConfigurationError?.message ??
        'WAN provider URL and key must be configured server-side.',
    );
  }
  if (isStatus) {
    let ownedJob: Awaited<ReturnType<typeof findOwnedJob>>;
    try {
      ownedJob = await findOwnedJob(configuration, userId, id as string);
    } catch {
      return sendError(res, 503, 'DATABASE_UNAVAILABLE', 'The generation job could not be verified.');
    }

    if (!ownedJob) {
      return sendError(res, 404, 'JOB_NOT_FOUND', 'No generation job was found for this account.');
    }

    if (ownedJob.provider === 'huggingface') {
      if (!configuration.hfToken) {
        return sendError(res, 503, 'HF_SPACE_NOT_CONFIGURED', 'The server-side Hugging Face token is not configured.');
      }
      try {
        const status = await pollHuggingFaceSpaceJob(
          id as string,
          configuration.hfToken,
        );
        const fields: JsonRecord = {
          status: status.status,
          provider_status: status.status,
          progress: status.progress,
        };
        if (status.status === 'failed') {
          fields.error_message = status.message;
        }
        if (status.status === 'completed' || status.status === 'failed') {
          fields.completed_at = new Date().toISOString();
        }
        if (!(await updateJobRecord(configuration, userId, ownedJob.id, fields))) {
          return sendError(res, 503, 'DATABASE_UNAVAILABLE', 'The generation status could not be saved.');
        }
        if (
          status.status === 'failed' &&
          !(await refundGenerationCredits(configuration, userId, ownedJob.id))
        ) {
          return sendError(res, 503, 'CREDIT_REFUND_FAILED', 'The Hugging Face job failed, but its credit reservation could not be refunded.');
        }
        return res.status(200).json({
          ok: true,
          jobId: ownedJob.id,
          status: status.status,
          providerJobId: id,
          progress: status.progress,
          ...(status.outputUrl ? { outputUrl: status.outputUrl } : {}),
          message: status.message,
        });
      } catch (error) {
        if (error instanceof HuggingFaceSpaceError) {
          return sendError(res, error.statusCode, error.code, error.message);
        }
        return sendError(res, 502, 'HF_SPACE_UNAVAILABLE', 'The Hugging Face Space status could not be fetched.');
      }
    }

    if (!configuration.providerBaseUrl || !configuration.providerApiKey) {
      return sendError(
        res,
        503,
        configuration.providerConfigurationError?.code ?? 'WAN_PROVIDER_NOT_CONFIGURED',
        configuration.providerConfigurationError?.message ??
          'WAN provider URL and key must be configured server-side.',
      );
    }
    const providerBaseUrl = configuration.providerBaseUrl;

    try {
      const upstreamResponse = await fetchWithTimeout(
        providerEndpoint(
          providerBaseUrl,
          `jobs/${encodeURIComponent(id as string)}`,
        ),
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${configuration.providerApiKey}`,
          },
        },
      );

      if (upstreamResponse.status === 401 || upstreamResponse.status === 403) {
        return sendError(res, 502, 'PROVIDER_AUTH_FAILED', 'The WAN provider rejected its configured credentials.');
      }
      if (upstreamResponse.status === 429) {
        return sendError(res, 429, 'PROVIDER_RATE_LIMITED', 'The WAN provider rate limit was reached.');
      }
      if (!upstreamResponse.ok) {
        return sendError(res, 502, 'PROVIDER_REQUEST_FAILED', 'The WAN provider request failed.');
      }

      const data = await readJson(upstreamResponse);
      if (!isRecord(data) || !validStatus(data.status)) {
        return sendError(res, 502, 'INVALID_PROVIDER_RESPONSE', 'The WAN provider returned an invalid status response.');
      }
      if (data.progress !== undefined && !validProgress(data.progress)) {
        return sendError(res, 502, 'INVALID_PROVIDER_RESPONSE', 'The WAN provider returned invalid job progress.');
      }
      if (data.outputUrl !== undefined && !validOutputUrl(data.outputUrl)) {
        return sendError(res, 502, 'INVALID_PROVIDER_RESPONSE', 'The WAN provider returned an invalid output URL.');
      }
      if (data.status === 'completed' && !validOutputUrl(data.outputUrl)) {
        return sendError(res, 502, 'INVALID_PROVIDER_RESPONSE', 'A completed job must include a usable video URL.');
      }

      const fields: JsonRecord = {
        status: data.status,
        provider_status: data.status,
      };
      if (data.progress !== undefined) {
        fields.progress = data.progress;
      }
      if (data.status === 'completed' || data.status === 'failed') {
        fields.completed_at = new Date().toISOString();
      }

      if (!(await updateJobRecord(configuration, userId, ownedJob.id, fields))) {
        return sendError(res, 503, 'DATABASE_UNAVAILABLE', 'The generation status could not be saved.');
      }

      if (
        data.status === 'completed' &&
        typeof data.outputUrl === 'string' &&
        !(await storeGeneratedVideo(configuration, userId, ownedJob.id, data.outputUrl))
      ) {
        return sendError(res, 503, 'DATABASE_UNAVAILABLE', 'The generated video record could not be saved.');
      }
      if (data.status === 'failed' && !(await refundGenerationCredits(configuration, userId, ownedJob.id))) {
        return sendError(res, 503, 'CREDIT_REFUND_FAILED', 'The job failed, but its credit reservation could not be refunded.');
      }

      return res.status(200).json({
        ok: true,
        status: data.status,
        providerJobId: id,
        ...(data.progress === undefined ? {} : { progress: data.progress }),
        ...(data.outputUrl === undefined ? {} : { outputUrl: data.outputUrl }),
        message: safeProviderMessage(data.message, 'Provider status received.'),
      });
    } catch (error) {
      if (error instanceof RequestTimeoutError) {
        return sendError(res, 504, 'PROVIDER_TIMEOUT', 'The WAN provider request timed out.');
      }

      return sendError(res, 502, 'PROVIDER_UNAVAILABLE', 'The WAN provider could not be reached.');
    }
  }

  let rateLimitAllowed: boolean;
  try {
    rateLimitAllowed = await consumeGenerationRateLimit(
      configuration,
      userId,
      (payload as VideoGenerationInput).id as string,
    );
  } catch {
    return sendError(res, 503, 'DATABASE_UNAVAILABLE', 'Generation rate limits could not be checked.');
  }
  if (!rateLimitAllowed) {
    return sendError(res, 429, 'GENERATION_RATE_LIMITED', 'Too many generation requests. Please wait before trying again.');
  }

  let jobRecord: Awaited<ReturnType<typeof createJobRecord>>;
  try {
    jobRecord = await createJobRecord(configuration, userId, payload as VideoGenerationInput);
  } catch {
    return sendError(res, 503, 'DATABASE_UNAVAILABLE', 'A generation job record could not be created.');
  }
  if (!jobRecord) {
    return sendError(res, 503, 'DATABASE_UNAVAILABLE', 'A generation job record could not be created.');
  }
  const newJobId = jobRecord.id;

  if (!jobRecord.created) {
    if (jobRecord.status === 'failed') {
      return sendError(
        res,
        409,
        'DUPLICATE_REQUEST_FAILED',
        'This generation request already failed and will not be submitted again. Start a new request only after reviewing its history.',
      );
    }
    if (
      configuration.providerName === 'huggingface' &&
      jobRecord.providerStatus !== 'queued' &&
      jobRecord.providerStatus !== 'processing' &&
      jobRecord.providerStatus !== 'completed' &&
      jobRecord.providerStatus !== 'failed'
    ) {
      return sendError(
        res,
        409,
        'DUPLICATE_REQUEST_OUTCOME_UNKNOWN',
        'This request may have reached the Hugging Face queue, but its submission could not be confirmed. Retry with this same request ID to reconcile it.',
      );
    }
    if (!jobRecord.providerJobId) {
      return sendError(
        res,
        409,
        'DUPLICATE_REQUEST_OUTCOME_UNKNOWN',
        'This request was already received, but its provider job could not be confirmed. Do not retry with a new request ID until the job is reconciled.',
      );
    }
    return res.status(200).json({
      ok: true,
      jobId: newJobId,
      status: jobRecord.status,
      providerJobId: jobRecord.providerJobId,
      progress: jobRecord.progress,
      message: 'This generation request was already accepted.',
    });
  }

  let creditReserved: boolean;
  try {
    creditReserved = await reserveGenerationCredits(configuration, userId, newJobId);
  } catch {
    await updateJobRecord(configuration, userId, newJobId, {
      error_message: 'Credit reservation outcome could not be verified; do not retry before reconciliation.',
    });
    return sendError(
      res,
      503,
      'CREDIT_RESERVATION_OUTCOME_UNKNOWN',
      'Credit reservation could not be verified. No provider request was sent; reconcile this request before retrying.',
    );
  }
  if (!creditReserved) {
    await updateJobRecord(configuration, userId, newJobId, {
      status: 'failed',
      error_message: 'Insufficient generation credits.',
    });
    return sendError(res, 402, 'INSUFFICIENT_CREDITS', 'There are not enough credits for this generation.');
  }

  const failJobAndRespond = async (
    statusCode: number,
    code: string,
    message: string,
  ) => {
    const savedFailure = await updateJobRecord(configuration, userId, newJobId, {
      status: 'failed',
      error_message: message,
    });

    if (!savedFailure) {
      return sendError(res, 503, 'DATABASE_UNAVAILABLE', 'The provider request failed and its job record could not be updated.');
    }
    if (!(await refundGenerationCredits(configuration, userId, newJobId))) {
      return sendError(res, 503, 'CREDIT_REFUND_FAILED', 'The provider rejected the job, but the credit reservation could not be refunded.');
    }
    return sendError(res, statusCode, code, message);
  };

  const providerPayload = { ...(payload as VideoGenerationInput) };
  delete providerPayload.id;

  if (configuration.providerName === 'huggingface') {
    const providerJobId = randomUUID();
    if (
      !(await updateJobRecord(configuration, userId, newJobId, {
        provider_job_id: providerJobId,
        provider_status: 'queue_submitting',
      }))
    ) {
      return sendError(
        res,
        503,
        'DATABASE_UNAVAILABLE',
        'The generation request could not be prepared safely; no Hugging Face request was sent.',
      );
    }

    try {
      await submitHuggingFaceSpaceJob(
        payload as VideoGenerationInput,
        providerJobId,
        configuration.hfToken as string,
      );
    } catch (error) {
      if (error instanceof HuggingFaceSpaceError && error.outcomeUnknown) {
        await updateJobRecord(configuration, userId, newJobId, {
          error_message: error.message,
        });
        return sendError(res, error.statusCode, error.code, error.message);
      }
      if (error instanceof HuggingFaceSpaceError) {
        return failJobAndRespond(error.statusCode, error.code, error.message);
      }
      return failJobAndRespond(
        502,
        'HF_SPACE_UNAVAILABLE',
        'The Hugging Face Space could not accept the generation request.',
      );
    }

    if (
      !(await updateJobRecord(configuration, userId, newJobId, {
        provider_status: 'queued',
      }))
    ) {
      return sendError(
        res,
        503,
        'DATABASE_UNAVAILABLE',
        'The Hugging Face request was submitted but its status could not be saved. Retry with the same request ID to reconcile it.',
      );
    }

    return res.status(202).json({
      ok: true,
      jobId: newJobId,
      status: 'queued',
      providerJobId,
      progress: 0,
      message: 'Hugging Face accepted the request for its ZeroGPU queue. Availability and free quota are not guaranteed.',
    });
  }

  if (!configuration.providerBaseUrl || !configuration.providerApiKey) {
    return sendError(
      res,
      503,
      configuration.providerConfigurationError?.code ?? 'WAN_PROVIDER_NOT_CONFIGURED',
      configuration.providerConfigurationError?.message ??
        'WAN provider URL and key must be configured server-side.',
    );
  }

  const providerBaseUrl = configuration.providerBaseUrl;

  try {
    const upstreamResponse = await fetchWithTimeout(
      providerEndpoint(providerBaseUrl, 'jobs'),
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${configuration.providerApiKey}`,
        },
        body: JSON.stringify(providerPayload),
      },
    );

    if (upstreamResponse.status === 401 || upstreamResponse.status === 403) {
      return failJobAndRespond(502, 'PROVIDER_AUTH_FAILED', 'The WAN provider rejected its configured credentials.');
    }
    if (upstreamResponse.status === 429) {
      return failJobAndRespond(429, 'PROVIDER_RATE_LIMITED', 'The WAN provider rate limit was reached.');
    }
    if (!upstreamResponse.ok) {
      if (upstreamResponse.status >= 500) {
        await updateJobRecord(configuration, userId, newJobId, {
          error_message: 'Provider response was inconclusive; generation outcome requires reconciliation.',
        });
        return sendError(
          res,
          502,
          'PROVIDER_OUTCOME_UNKNOWN',
          'The provider response was inconclusive. The reserved credits remain held while the request is reconciled.',
        );
      }
      return failJobAndRespond(502, 'PROVIDER_REQUEST_FAILED', 'The WAN provider request failed.');
    }

    const data = await readJson(upstreamResponse);
    if (
      !isRecord(data) ||
      !validProviderJobId(data.providerJobId) ||
      (data.status !== undefined && !validStatus(data.status)) ||
      (data.progress !== undefined && !validProgress(data.progress)) ||
      (data.outputUrl !== undefined && !validOutputUrl(data.outputUrl))
    ) {
      await updateJobRecord(configuration, userId, newJobId, {
        error_message: 'Provider response was incomplete; generation outcome requires reconciliation.',
      });
      return sendError(
        res,
        502,
        'PROVIDER_OUTCOME_UNKNOWN',
        'The provider response was incomplete. The reserved credits remain held while the request is reconciled.',
      );
    }

    const status = (data.status ?? 'queued') as string;
    if (status === 'completed' && !validOutputUrl(data.outputUrl)) {
      await updateJobRecord(configuration, userId, newJobId, {
        provider_job_id: data.providerJobId.trim(),
        provider_status: status,
        error_message: 'Provider reported completion without a usable video URL; status requires reconciliation.',
      });
      return sendError(
        res,
        502,
        'PROVIDER_OUTCOME_UNKNOWN',
        'The provider reported completion without a usable video URL. Its job was recorded for reconciliation; retry with the same request ID.',
      );
    }
    const providerJobId = data.providerJobId.trim();
    const fields: JsonRecord = {
      provider_job_id: providerJobId,
      provider_status: status,
      status,
      progress: data.progress ?? 0,
    };
    if (status === 'completed' || status === 'failed') {
      fields.completed_at = new Date().toISOString();
    }

    if (!(await updateJobRecord(configuration, userId, newJobId, fields))) {
      return sendError(res, 503, 'DATABASE_UNAVAILABLE', 'The provider job was accepted but could not be linked to the account record.');
    }
    if (
      status === 'completed' &&
      typeof data.outputUrl === 'string' &&
      !(await storeGeneratedVideo(configuration, userId, newJobId, data.outputUrl))
    ) {
      return sendError(res, 503, 'DATABASE_UNAVAILABLE', 'The generated video record could not be saved.');
    }
    if (status === 'failed' && !(await refundGenerationCredits(configuration, userId, newJobId))) {
      return sendError(res, 503, 'CREDIT_REFUND_FAILED', 'The provider job failed, but its credit reservation could not be refunded.');
    }

    return res.status(200).json({
      ok: true,
      jobId: newJobId,
      status,
      providerJobId,
      progress: data.progress ?? 0,
      ...(data.outputUrl === undefined ? {} : { outputUrl: data.outputUrl }),
      message: safeProviderMessage(data.message, 'Provider accepted the generation request.'),
    });
  } catch (error) {
    const timedOut = error instanceof RequestTimeoutError;
    await updateJobRecord(configuration, userId, newJobId, {
      error_message: timedOut
        ? 'The WAN provider request timed out; its outcome could not be confirmed.'
        : 'The WAN provider could not be reached; its outcome could not be confirmed.',
    });
    return timedOut
      ? sendError(res, 504, 'PROVIDER_OUTCOME_UNKNOWN', 'The WAN provider request timed out. The reserved credits remain held; do not retry before reconciling its outcome.')
      : sendError(res, 502, 'PROVIDER_OUTCOME_UNKNOWN', 'The WAN provider could not be reached. The reserved credits remain held; do not retry before reconciling its outcome.');
  }
}
