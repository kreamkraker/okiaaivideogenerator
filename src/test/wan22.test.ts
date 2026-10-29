import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { VideoGenerationInput } from '../lib/provider';
import {
  generateVideoParameters,
  submitHuggingFaceSpaceJob,
} from '../../server/huggingfaceSpace';
import handler from '../../api/wan22';

const validPayload = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  mode: 'text-to-video',
  model: 'wan-2.2-t2v',
  prompt: 'A cinematic drone shot over a mountain lake at sunrise.',
  negativePrompt: 'blurry',
  aspectRatio: '16:9',
  duration: 8,
  resolution: '1280x720',
};

function makeRequest(
  method: string,
  action: string,
  payload: unknown = validPayload,
): VercelRequest {
  return {
    method,
    query: method === 'GET' ? { action, id: 'provider-job-1' } : {},
    body: method === 'POST' ? { action, payload } : undefined,
    headers: { authorization: 'Bearer test-user-token' },
  } as unknown as VercelRequest;
}

function makeResponse() {
  const state: {
    statusCode: number;
    body: unknown;
    headers: Record<string, string>;
  } = {
    statusCode: 0,
    body: undefined,
    headers: {},
  };

  const response = {
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return response;
    },
    status(statusCode: number) {
      state.statusCode = statusCode;
      return response;
    },
    json(body: unknown) {
      state.body = body;
      return response;
    },
  } as unknown as VercelResponse;

  return { response, state };
}

function configureEnvironment() {
  vi.stubEnv('WAN22_PROVIDER', 'wan22');
  vi.stubEnv('WAN22_API_URL', 'https://gpu.example.test');
  vi.stubEnv('WAN22_API_KEY', 'test-provider-key');
  vi.stubEnv('SUPABASE_URL', 'https://project.example.test');
  vi.stubEnv('SUPABASE_ANON_KEY', 'test-public-anon-key');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
  vi.stubEnv('WAN22_PROVIDER_CONTRACT_CONFIRMED', 'true');
  vi.stubEnv('WAN22_GENERATION_CREDIT_COST', '1');
}

function configureHuggingFaceEnvironment() {
  vi.stubEnv('WAN22_PROVIDER', 'huggingface');
  vi.stubEnv('HF_SPACE_PROVIDER_ENABLED', 'true');
  vi.stubEnv('HF_TOKEN', 'test-huggingface-token');
  vi.stubEnv('SUPABASE_URL', 'https://project.example.test');
  vi.stubEnv('SUPABASE_ANON_KEY', 'test-public-anon-key');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
  vi.stubEnv('WAN22_GENERATION_CREDIT_COST', '1');
}

const huggingFacePayload: VideoGenerationInput = {
  id: validPayload.id,
  mode: 'image-to-video',
  model: 'wan-2.2-i2v',
  prompt: validPayload.prompt,
  negativePrompt: validPayload.negativePrompt,
  aspectRatio: '16:9',
  duration: validPayload.duration,
  resolution: validPayload.resolution,
  imageFileName: 'data:image/png;base64,iVBORw0KGgo=',
};

function huggingFaceSchemaResponses() {
  return [
    jsonResponse({
      named_endpoints: {
        '/generate_video': {
          parameters: generateVideoParameters.map((parameter_name) => ({
            parameter_name,
          })),
        },
      },
    }),
    jsonResponse({
      enable_queue: true,
      dependencies: [{ api_name: 'generate_video', id: 7 }],
    }),
  ];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WAN API handler', () => {
  it('rejects invalid methods without making network requests', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('DELETE', 'submit'), response);

    expect(state.statusCode).toBe(405);
    expect(state.body).toMatchObject({ ok: false, code: 'METHOD_NOT_ALLOWED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports missing provider configuration without making network requests', async () => {
    vi.stubEnv('WAN22_API_URL', '');
    vi.stubEnv('WAN22_API_KEY', '');
    vi.stubEnv('SUPABASE_URL', 'https://project.example.test');
    vi.stubEnv('SUPABASE_ANON_KEY', 'test-public-anon-key');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit'), response);

    expect(state.statusCode).toBe(503);
    expect(state.body).toMatchObject({
      ok: false,
      code: 'WAN_PROVIDER_NOT_CONFIGURED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps generation disabled when the provider contract is unconfirmed', async () => {
    configureEnvironment();
    vi.stubEnv('WAN22_PROVIDER_CONTRACT_CONFIRMED', 'false');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit'), response);

    expect(state.statusCode).toBe(503);
    expect(state.body).toMatchObject({
      ok: false,
      code: 'WAN_PROVIDER_CONTRACT_UNVERIFIED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires an explicitly configured server-side generation cost', async () => {
    configureEnvironment();
    vi.stubEnv('WAN22_GENERATION_CREDIT_COST', 'SET_AFTER_PROVIDER_PRICING');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit'), response);

    expect(state.statusCode).toBe(503);
    expect(state.body).toMatchObject({
      ok: false,
      code: 'GENERATION_CREDIT_COST_NOT_CONFIGURED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires server-side Supabase service credentials before submitting jobs', async () => {
    vi.stubEnv('WAN22_API_URL', 'https://gpu.example.test');
    vi.stubEnv('WAN22_API_KEY', 'test-provider-key');
    vi.stubEnv('SUPABASE_URL', 'https://project.example.test');
    vi.stubEnv('SUPABASE_ANON_KEY', 'test-public-anon-key');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit'), response);

    expect(state.statusCode).toBe(503);
    expect(state.body).toMatchObject({
      ok: false,
      code: 'SUPABASE_SERVER_CONFIG_NOT_CONFIGURED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid input before authenticating or contacting the provider', async () => {
    configureEnvironment();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(
      makeRequest('POST', 'submit', { ...validPayload, duration: 0 }),
      response,
    );

    expect(state.statusCode).toBe(400);
    expect(state.body).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects mismatched image data before authenticating or contacting the provider', async () => {
    configureEnvironment();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(
      makeRequest('POST', 'submit', {
        ...validPayload,
        mode: 'image-to-video',
        imageFileName: 'data:image/png;base64,AAAA',
      }),
      response,
    );

    expect(state.statusCode).toBe(400);
    expect(state.body).toMatchObject({ ok: false, code: 'INVALID_IMAGE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid Supabase tokens before contacting the provider', async () => {
    configureEnvironment();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit'), response);

    expect(state.statusCode).toBe(401);
    expect(state.body).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('submits the validated payload to the evidenced provider route', async () => {
    configureEnvironment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse([{ id: 'database-job-1' }]))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(
        jsonResponse({ providerJobId: 'provider-job-1', status: 'queued' }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit'), response);

    expect(state.statusCode).toBe(200);
    expect(state.body).toMatchObject({
      ok: true,
      status: 'queued',
      jobId: 'database-job-1',
      providerJobId: 'provider-job-1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls[4][0]).toBe('https://gpu.example.test/jobs');
    expect(fetchMock.mock.calls[4][1]?.headers).toHaveProperty('Authorization');
    const sentPayload = JSON.parse(String(fetchMock.mock.calls[4][1]?.body));
    const { id: _requestId, ...expectedProviderPayload } = validPayload;
    expect(sentPayload).toEqual(expectedProviderPayload);
    expect(fetchMock.mock.calls[5][0]).toContain('/rest/v1/generation_jobs?');
  });

  it('blocks generation when the database rate limiter denies the request', async () => {
    configureEnvironment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse(false));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit'), response);

    expect(state.statusCode).toBe(429);
    expect(state.body).toMatchObject({ ok: false, code: 'GENERATION_RATE_LIMITED' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not contact the provider when the credit ledger denies a reservation', async () => {
    configureEnvironment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse([{ id: 'database-job-1' }]))
      .mockResolvedValueOnce(jsonResponse(false))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit'), response);

    expect(state.statusCode).toBe(402);
    expect(state.body).toMatchObject({ ok: false, code: 'INSUFFICIENT_CREDITS' });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.some(([url]) => url === 'https://gpu.example.test/jobs')).toBe(false);
  });

  it('returns an existing idempotent job without resubmitting to the provider', async () => {
    configureEnvironment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        jsonResponse([{
          id: 'database-job-1',
          provider_job_id: 'provider-job-1',
          status: 'processing',
          progress: 50,
        }]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit'), response);

    expect(state.statusCode).toBe(200);
    expect(state.body).toMatchObject({
      ok: true,
      jobId: 'database-job-1',
      providerJobId: 'provider-job-1',
      status: 'processing',
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.some(([url]) => url === 'https://gpu.example.test/jobs')).toBe(false);
  });

  it('returns a rate-limit error when the provider responds with 429', async () => {
    configureEnvironment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse([{ id: 'database-job-1' }]))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse({ message: 'not exposed' }, 429))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(true));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit'), response);

    expect(state.statusCode).toBe(429);
    expect(state.body).toMatchObject({
      ok: false,
      code: 'PROVIDER_RATE_LIMITED',
    });
    expect(JSON.stringify(state.body)).not.toContain('not exposed');
  });

  it('keeps credits reserved when an upstream server error has an ambiguous outcome', async () => {
    configureEnvironment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse([{ id: 'database-job-1' }]))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit'), response);

    expect(state.statusCode).toBe(502);
    expect(state.body).toMatchObject({
      ok: false,
      code: 'PROVIDER_OUTCOME_UNKNOWN',
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('requires an output URL before accepting an immediately completed provider job', async () => {
    configureEnvironment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse([{ id: 'database-job-1' }]))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(
        jsonResponse({ providerJobId: 'provider-job-1', status: 'completed' }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit'), response);

    expect(state.statusCode).toBe(502);
    expect(state.body).toMatchObject({
      ok: false,
      code: 'PROVIDER_OUTCOME_UNKNOWN',
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('stores a completed output URL after persisting the provider job', async () => {
    configureEnvironment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse([{ id: 'database-job-1' }]))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(
        jsonResponse({
          providerJobId: 'provider-job-1',
          status: 'completed',
          outputUrl: 'https://videos.example.test/output.mp4',
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit'), response);

    expect(state.statusCode).toBe(200);
    expect(state.body).toMatchObject({
      ok: true,
      jobId: 'database-job-1',
      status: 'completed',
      outputUrl: 'https://videos.example.test/output.mp4',
    });
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(String(fetchMock.mock.calls[6][0])).toContain('/rest/v1/generated_videos?');
  });

  it('refunds the reserved credits when the provider confirms a failed job', async () => {
    configureEnvironment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse([{ id: 'database-job-1' }]))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(
        jsonResponse({ providerJobId: 'provider-job-1', status: 'failed' }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(true));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit'), response);

    expect(state.statusCode).toBe(200);
    expect(state.body).toMatchObject({ ok: true, status: 'failed' });
    expect(String(fetchMock.mock.calls[6][0])).toContain('/rpc/refund_generation_credits');
  });

  it('keeps the Hugging Face provider disabled unless explicitly enabled', async () => {
    configureHuggingFaceEnvironment();
    vi.stubEnv('HF_SPACE_PROVIDER_ENABLED', 'false');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit', huggingFacePayload), response);

    expect(state.statusCode).toBe(503);
    expect(state.body).toMatchObject({ ok: false, code: 'HF_SPACE_NOT_CONFIGURED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submits image-to-video through the verified Hugging Face Gradio queue', async () => {
    configureHuggingFaceEnvironment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse([{ id: 'database-job-1' }]))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockImplementationOnce(() => Promise.resolve(huggingFaceSchemaResponses()[0]))
      .mockImplementationOnce(() => Promise.resolve(huggingFaceSchemaResponses()[1]))
      .mockResolvedValueOnce(jsonResponse(['/gradio_api/file=reference.png']))
      .mockResolvedValueOnce(jsonResponse({ event_id: 'event-1' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit', huggingFacePayload), response);

    expect(state.statusCode).toBe(202);
    expect(state.body).toMatchObject({
      ok: true,
      status: 'queued',
      jobId: 'database-job-1',
    });
    expect(fetchMock.mock.calls[7][0]).toContain('/gradio_api/upload');
    expect(fetchMock.mock.calls[8][0]).toContain('/gradio_api/queue/join');
    const queueRequest = JSON.parse(String(fetchMock.mock.calls[8][1]?.body));
    expect(queueRequest.fn_index).toBe(7);
    expect(queueRequest.data).toHaveLength(generateVideoParameters.length);
    expect(queueRequest.data[2]).toBe(huggingFacePayload.prompt);
    expect(queueRequest.data[13]).toBe('16');
    expect(queueRequest.data[14]).toBe(true);
    expect(fetchMock.mock.calls[8][1]?.headers).toHaveProperty(
      'Authorization',
      'Bearer test-huggingface-token',
    );
    expect(JSON.stringify(state.body)).not.toContain('test-huggingface-token');
  });

  it('returns an existing Hugging Face job without submitting a duplicate queue request', async () => {
    configureHuggingFaceEnvironment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([{
        id: 'database-job-1',
        provider_job_id: 'existing-session-hash',
        provider_status: 'queued',
        status: 'queued',
        progress: 0,
      }]));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit', huggingFacePayload), response);

    expect(state.statusCode).toBe(200);
    expect(state.body).toMatchObject({
      ok: true,
      jobId: 'database-job-1',
      providerJobId: 'existing-session-hash',
      status: 'queued',
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/queue/join'))).toBe(false);
  });

  it('does not resubmit a Hugging Face job whose prior queue outcome is unknown', async () => {
    configureHuggingFaceEnvironment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([{
        id: 'database-job-1',
        provider_job_id: 'uncertain-session-hash',
        provider_status: 'queue_submitting',
        status: 'queued',
        progress: 0,
      }]));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit', huggingFacePayload), response);

    expect(state.statusCode).toBe(409);
    expect(state.body).toMatchObject({
      ok: false,
      code: 'DUPLICATE_REQUEST_OUTCOME_UNKNOWN',
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/queue/join'))).toBe(false);
  });

  it('rejects unsupported Hugging Face modes and durations before network calls', async () => {
    configureHuggingFaceEnvironment();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(
      makeRequest('POST', 'submit', {
        ...huggingFacePayload,
        mode: 'text-to-video',
        duration: 21,
      }),
      response,
    );

    expect(state.statusCode).toBe(400);
    expect(state.body).toMatchObject({ ok: false, code: 'HF_INPUT_UNSUPPORTED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects overlong Hugging Face prompts before authentication', async () => {
    configureHuggingFaceEnvironment();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(
      makeRequest('POST', 'submit', {
        ...huggingFacePayload,
        prompt: 'x'.repeat(2001),
      }),
      response,
    );

    expect(state.statusCode).toBe(400);
    expect(state.body).toMatchObject({ ok: false, code: 'HF_PROMPT_TOO_LONG' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refunds credits when the Hugging Face queue explicitly rejects the request', async () => {
    configureHuggingFaceEnvironment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse([{ id: 'database-job-1' }]))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockImplementationOnce(() => Promise.resolve(huggingFaceSchemaResponses()[0]))
      .mockImplementationOnce(() => Promise.resolve(huggingFaceSchemaResponses()[1]))
      .mockResolvedValueOnce(jsonResponse(['/gradio_api/file=reference.png']))
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(true));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit', huggingFacePayload), response);

    expect(state.statusCode).toBe(429);
    expect(state.body).toMatchObject({ ok: false, code: 'HF_QUOTA_EXHAUSTED' });
    expect(String(fetchMock.mock.calls[10][0])).toContain('/rpc/refund_generation_credits');
  });

  it('refunds the reservation when Hugging Face rejects the server token before queueing', async () => {
    configureHuggingFaceEnvironment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse([{ id: 'database-job-1' }]))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({
        enable_queue: true,
        dependencies: [{ api_name: 'generate_video', id: 7 }],
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(true));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit', huggingFacePayload), response);

    expect(state.statusCode).toBe(502);
    expect(state.body).toMatchObject({ ok: false, code: 'HF_AUTH_FAILED' });
    expect(JSON.stringify(state.body)).not.toContain('test-huggingface-token');
    expect(String(fetchMock.mock.calls[8][0])).toContain('/rpc/refund_generation_credits');
  });

  it('does not refund when the Hugging Face queue submission outcome is ambiguous', async () => {
    configureHuggingFaceEnvironment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse([{ id: 'database-job-1' }]))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockImplementationOnce(() => Promise.resolve(huggingFaceSchemaResponses()[0]))
      .mockImplementationOnce(() => Promise.resolve(huggingFaceSchemaResponses()[1]))
      .mockResolvedValueOnce(jsonResponse(['/gradio_api/file=reference.png']))
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit', huggingFacePayload), response);

    expect(state.statusCode).toBe(502);
    expect(state.body).toMatchObject({
      ok: false,
      code: 'HF_SUBMISSION_OUTCOME_UNKNOWN',
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/refund_generation_credits'))).toBe(false);
  });

  it('treats a malformed queue acknowledgment as an unknown submission outcome', async () => {
    configureHuggingFaceEnvironment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse([{ id: 'database-job-1' }]))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockImplementationOnce(() => Promise.resolve(huggingFaceSchemaResponses()[0]))
      .mockImplementationOnce(() => Promise.resolve(huggingFaceSchemaResponses()[1]))
      .mockResolvedValueOnce(jsonResponse(['/gradio_api/file=reference.png']))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit', huggingFacePayload), response);

    expect(state.statusCode).toBe(502);
    expect(state.body).toMatchObject({
      ok: false,
      code: 'HF_SUBMISSION_OUTCOME_UNKNOWN',
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/refund_generation_credits'))).toBe(false);
  });

  it('keeps credits reserved when the Hugging Face queue request times out', async () => {
    configureHuggingFaceEnvironment();
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(huggingFaceSchemaResponses()[0])
      .mockResolvedValueOnce(huggingFaceSchemaResponses()[1])
      .mockResolvedValueOnce(jsonResponse(['/gradio_api/file=reference.png']))
      .mockImplementationOnce((_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const submission = submitHuggingFaceSpaceJob(
      huggingFacePayload,
      'session-hash',
      'test-huggingface-token',
    );
    const submissionRejection = expect(submission).rejects.toMatchObject({
      code: 'HF_SUBMISSION_OUTCOME_UNKNOWN',
      outcomeUnknown: true,
    });

    for (let attempt = 0; attempt < 20 && fetchMock.mock.calls.length < 4; attempt += 1) {
      await Promise.resolve();
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(8_000);
    await submissionRejection;
  });

  it('refunds a reserved request when the verified Hugging Face schema has changed', async () => {
    configureHuggingFaceEnvironment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse([{ id: 'database-job-1' }]))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ named_endpoints: {} }))
      .mockResolvedValueOnce(jsonResponse({
        enable_queue: true,
        dependencies: [{ api_name: 'generate_video', id: 7 }],
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(true));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit', huggingFacePayload), response);

    expect(state.statusCode).toBe(503);
    expect(state.body).toMatchObject({ ok: false, code: 'HF_API_SCHEMA_CHANGED' });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/gradio_api/upload'))).toBe(false);
    expect(String(fetchMock.mock.calls[8][0])).toContain('/rpc/refund_generation_credits');
  });

  it('polls the Hugging Face queue and refunds a confirmed queue failure', async () => {
    configureHuggingFaceEnvironment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([{
        id: 'database-job-1',
        provider: 'huggingface',
        status: 'queued',
        progress: 0,
      }]))
      .mockResolvedValueOnce(new Response('data: {"msg":"queue_full"}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(true));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();
    await handler(makeRequest('GET', 'status'), response);

    expect(state.statusCode).toBe(200);
    expect(state.body).toMatchObject({ ok: true, status: 'failed' });
    expect(String(fetchMock.mock.calls[2][0])).toContain('/gradio_api/queue/data');
    expect(String(fetchMock.mock.calls[4][0])).toContain('/rpc/refund_generation_credits');
  });

  it('does not report fabricated progress for Hugging Face processing events', async () => {
    configureHuggingFaceEnvironment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([{
        id: 'database-job-1',
        provider: 'huggingface',
        status: 'queued',
        progress: 0,
      }]))
      .mockResolvedValueOnce(new Response('data: {"msg":"process_starts"}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('GET', 'status'), response);

    expect(state.statusCode).toBe(200);
    expect(state.body).toMatchObject({
      ok: true,
      status: 'processing',
      progress: 0,
    });
  });

  it('returns a validated Hugging Face video link without storing the temporary URL', async () => {
    configureHuggingFaceEnvironment();
    const videoUrl = 'https://makiblek-wan-2-2-i2v-14b-custom-lora-wow.hf.space/gradio_api/file=output.mp4';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([{
        id: 'database-job-1',
        provider: 'huggingface',
        status: 'queued',
        progress: 0,
      }]))
      .mockResolvedValueOnce(new Response(
        `data: ${JSON.stringify({
          msg: 'process_completed',
          success: true,
          output: { data: [{ url: videoUrl }] },
        })}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      ))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('GET', 'status'), response);

    expect(state.statusCode).toBe(200);
    expect(state.body).toMatchObject({
      ok: true,
      status: 'completed',
      outputUrl: videoUrl,
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/generated_videos'))).toBe(false);
  });

  it('rejects successful upstream responses that omit the provider job ID', async () => {
    configureEnvironment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse([{ id: 'database-job-1' }]))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse({ status: 'queued' }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('POST', 'submit'), response);

    expect(state.statusCode).toBe(502);
    expect(state.body).toMatchObject({
      ok: false,
      code: 'PROVIDER_OUTCOME_UNKNOWN',
    });
  });

  it('times out provider requests and records the failed job', async () => {
    configureEnvironment();
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse([{ id: 'database-job-1' }]))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockImplementationOnce(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new Error('request aborted')),
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    const request = handler(makeRequest('POST', 'submit'), response);
    await vi.advanceTimersByTimeAsync(15_000);
    await request;

    expect(state.statusCode).toBe(504);
    expect(state.body).toMatchObject({ ok: false, code: 'PROVIDER_OUTCOME_UNKNOWN' });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('does not poll provider jobs that do not belong to the authenticated user', async () => {
    configureEnvironment();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = makeResponse();

    await handler(makeRequest('GET', 'status'), response);

    expect(state.statusCode).toBe(404);
    expect(state.body).toMatchObject({ ok: false, code: 'JOB_NOT_FOUND' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
