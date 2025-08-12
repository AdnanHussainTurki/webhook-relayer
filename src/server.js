'use strict';

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.set('trust proxy', true);

// JSON body parsing
app.use(express.json({ limit: '1mb' }));

// Simple request ID middleware
app.use((req, _res, next) => {
  req.requestId = crypto.randomUUID();
  next();
});

function maskUrlCredentials(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    if (parsed.username) {
      const maskedPassword = parsed.password ? '****' : '';
      parsed.username = parsed.username;
      parsed.password = maskedPassword;
    }
    return parsed.toString();
  } catch (_e) {
    return targetUrl;
  }
}

function normalizePathKey(key) {
  return String(key || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

function parseRoutesFromEnv() {
  const routes = {};

  // 1) JSON mapping: RELAY_ROUTES_JSON='{"dev":"https://...","us":"https://..."}'
  if (process.env.RELAY_ROUTES_JSON) {
    try {
      const obj = JSON.parse(process.env.RELAY_ROUTES_JSON);
      Object.entries(obj || {}).forEach(([k, v]) => {
        const key = normalizePathKey(k);
        if (key && typeof v === 'string' && v) routes[key] = v;
      });
    } catch (_e) {
      // Ignore malformed JSON; fall back to other formats
    }
  }

  // 2) CSV mapping: RELAY_ROUTES='dev=https://...,us->https://...,eu=https://...'
  if (process.env.RELAY_ROUTES) {
    String(process.env.RELAY_ROUTES)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((pair) => {
        const sep = pair.includes('->') ? '->' : '=';
        const [rawK, rawV] = pair.split(sep);
        const key = normalizePathKey(rawK);
        const value = (rawV || '').trim();
        if (key && value) routes[key] = value;
      });
  }

  // 3) Prefixed envs: RELAY_TARGET_<PATH>=https://...
  Object.keys(process.env)
    .filter((k) => k.startsWith('RELAY_TARGET_'))
    .forEach((k) => {
      const key = normalizePathKey(k.replace(/^RELAY_TARGET_/, ''));
      const value = process.env[k];
      if (key && value) routes[key] = value;
    });

  return routes;
}

function resolveTargetUrl(routes, normalizedPath) {
  const segments = normalizedPath.split('/').filter(Boolean);
  let matchedKey = '';
  let target = undefined;
  // Prefer the longest matching prefix
  for (let i = 1; i <= segments.length; i += 1) {
    const candidate = segments.slice(0, i).join('/');
    if (routes[candidate]) {
      matchedKey = candidate;
      target = routes[candidate];
    }
  }
  return { matchedKey, targetUrl: target };
}

// Signature verification intentionally removed per requirements

function getWebhookType(body) {
  try {
    if (body && Array.isArray(body.events) && body.events.length > 0) {
      return body.events.map((e) => e.type).join(',');
    }
  } catch (_e) {}
  return 'unknown';
}

function logJson(level, obj) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    ...obj,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}



app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/ready', (_req, res) => {
  const routes = parseRoutesFromEnv();
  const hasAny = Object.keys(routes).length > 0;
  if (hasAny) return res.status(200).json({ ready: true, routes: Object.keys(routes) });
  return res.status(503).json({ ready: false, routes: [] });
});

app.get('/config', (_req, res) => {
  const routes = parseRoutesFromEnv();
  const masked = Object.fromEntries(
    Object.entries(routes).map(([k, v]) => [k, maskUrlCredentials(v)])
  );
  res.status(200).json({
    port: process.env.PORT || 3000,
    routes: masked,
    timeoutMs: Number(process.env.TARGET_TIMEOUT_MS || 10000),
  });
});

app.all('/*', async (req, res) => {
  const start = Date.now();
  const pathKey = normalizePathKey(req.path || '');
  const routes = parseRoutesFromEnv();
  const { matchedKey, targetUrl } = resolveTargetUrl(routes, pathKey);
  console.log('matchedKey', matchedKey);
  console.log('targetUrl', targetUrl);
  const reqId = req.requestId;
  const webhookType = getWebhookType(req.body);

  if (!targetUrl) {
    logJson('error', {
      message: 'No target URL configured',
      path: pathKey,
      requestId: reqId,
      webhookType,
    });
    // Always 200 
    return res.status(200).json({ ok: true, forwarded: false, reason: 'no_target_configured' });
  }

  try {
    const parsed = new URL(targetUrl);
    const hasCreds = Boolean(parsed.username || parsed.password);
    const response = await axios({
      method: req.method,
      url: targetUrl,
      data: req.body,
      headers: {
        'content-type': req.get('content-type') || 'application/json',
        'x-request-id': reqId,
        'x-relayed-by': 'webhook-relayer',
      },
      auth: hasCreds
        ? { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) }
        : undefined,
      timeout: Number(process.env.TARGET_TIMEOUT_MS || 10000),
      maxBodyLength: 10 * 1024 * 1024,
      validateStatus: () => true,
    });

    const durationMs = Date.now() - start;
    logJson('info', {
      message: 'Received webhook',
      requestId: reqId,
      path: pathKey,
      matchedRoute: matchedKey,
      method: req.method,
      webhookType,
      durationMs,
      targetStatus: response.status,
    });

    // Always 200 back
    res.status(200).json({ ok: true, forwarded: true,  to: targetUrl, targetStatus: response.status });
  } catch (error) {
    const durationMs = Date.now() - start;
    const status = error?.response?.status || 0;
    logJson('error', {
      message: 'Forwarding failed',
      requestId: reqId,
      path: pathKey,
      matchedRoute: matchedKey,
      method: req.method,
      webhookType,
      durationMs,
      error: {
        message: error?.message,
        code: error?.code,
        status,
      },
    });
    res.status(200).json({ ok: true, forwarded: false, targetStatus: status });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  logJson('info', { message: 'Server started', port });
});

