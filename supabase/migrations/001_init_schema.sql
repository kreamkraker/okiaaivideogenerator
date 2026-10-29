import type { VercelRequest, VercelResponse } from '@vercel/node';

const providerBaseUrl = process.env.WAN22_API_URL || '';
const providerApiKey = process.env.WAN22_API_KEY || '';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { method } = req;

  if (method !== 'POST' && method !== 'GET') {
    return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  }

  const action = typeof req.query.action === 'string' ? req.query.action : req.body?.action;
  const id = typeof req.query.id === 'string' ? req.query.id : req.body?.id;

  if (!providerBaseUrl) {
    return res.status(503).json({
      ok: false,
      status: 'failed',
      message: 'WAN22_API_URL is not configured. Real WAN 2.2 generation is not connected yet.',
    });
  }

  try {
    if (method === 'POST' && action === 'submit') {
      const payload = req.body?.payload || {};

      const upstreamResponse = await fetch(`${providerBaseUrl}/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(providerApiKey ? { Authorization: `Bearer ${providerApiKey}` } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!upstreamResponse.ok) {
        throw new Error('Submission to the GPU provider failed.');
      }

      const data = await upstreamResponse.json();
      return res.status(200).json({
        ok: true,
        status: 'queued',
        providerJobId: data.providerJobId || `wan-${Date.now()}`,
        message: 'Video generation job submitted to WAN 2.2 provider.',
      });
    }

    if (method === 'GET' && action === 'status') {
      const upstreamResponse = await fetch(`${providerBaseUrl}/jobs/${id}`, {
        method: 'GET',
        headers: {
          ...(providerApiKey ? { Authorization: `Bearer ${providerApiKey}` } : {}),
        },
      });

      if (!upstreamResponse.ok) {
        throw new Error('Status polling against the GPU provider failed.');
      }

      const data = await upstreamResponse.json();
      return res.status(200).json({
        ok: true,
        status: data.status || 'processing',
        providerJobId: id,
        progress: data.progress || 0,
        outputUrl: data.outputUrl,
        message: data.message || 'Provider status received.',
      });
    }

    return res.status(400).json({ ok: false, message: 'Unsupported provider action.' });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      status: 'failed',
      message: error instanceof Error ? error.message : 'Unexpected provider failure.',
    });
  }
}
