import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

export interface TextBeeConfig {
  deviceId: string;
  apiKey: string;
  endpoint?: string | undefined;
}

/**
 * Resolves TextBee SMS gateway credentials from server environment or external production.json.
 * Strict security guarantee: Never hardcodes secrets and never reads from repo root or client code.
 */
export function getTextBeeConfig(): TextBeeConfig | null {
  if ((process.env.NODE_ENV === 'test' || process.env.VITEST) && !process.env.TEXTBEE_ENABLE_TEST) {
    return null;
  }

  if (process.env.TEXTBEE_DEVICE_ID && process.env.TEXTBEE_API_KEY) {
    return {
      deviceId: process.env.TEXTBEE_DEVICE_ID,
      apiKey: process.env.TEXTBEE_API_KEY,
      endpoint: process.env.TEXTBEE_ENDPOINT,
    };
  }

  const candidates = [
    process.env.LIMS_PRODUCTION_CONFIG_FILE,
    process.env.USERPROFILE ? join(process.env.USERPROFILE, 'production.json') : null,
    process.env.HOME ? join(process.env.HOME, 'production.json') : null,
    '/run/secrets/lims/production.json',
    '/srv/lims/production.json',
    '/home/metrolmis/production.json',
    '/etc/lims/production.json',
  ].filter((p): p is string => typeof p === 'string' && p.length > 0 && existsSync(p));

  for (const filePath of candidates) {
    try {
      const raw = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      const tb = parsed?.sms_gateway?.textbee;
      if (tb?.device_id && tb?.api_key) {
        return {
          deviceId: String(tb.device_id),
          apiKey: String(tb.api_key),
          endpoint: tb.endpoint ? String(tb.endpoint) : undefined,
        };
      }
    } catch {
      // Continue checking next candidate
    }
  }

  return null;
}

function postJsonThroughProxy(targetUrlStr: string, headers: Record<string, string>, payload: unknown, proxyUrlStr?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(targetUrlStr);
    const bodyStr = JSON.stringify(payload);
    const proxyStr = proxyUrlStr || process.env.LIMS_CORE_EGRESS_PROXY_URL || 'http://squid:3128';

    if (proxyStr) {
      const proxyUrl = new URL(proxyStr);
      const connectReq = http.request({
        host: proxyUrl.hostname,
        port: proxyUrl.port || '3128',
        method: 'CONNECT',
        path: `${targetUrl.hostname}:${targetUrl.port || '443'}`,
      });
      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          return reject(new Error(`Proxy CONNECT failed: HTTP ${res.statusCode}`));
        }
        const options: https.RequestOptions & { socket?: any } = {
          host: targetUrl.hostname,
          port: targetUrl.port || 443,
          path: targetUrl.pathname + targetUrl.search,
          method: 'POST',
          headers: Object.assign({}, headers, {
            'Content-Length': String(Buffer.byteLength(bodyStr)),
          }),
          socket,
          agent: false,
        };
        const req = https.request(options, (resp) => {
          let data = '';
          resp.on('data', chunk => data += chunk);
          resp.on('end', () => {
            try {
              resolve({ status: resp.statusCode || 500, body: JSON.parse(data) });
            } catch {
              resolve({ status: resp.statusCode || 500, body: data });
            }
          });
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
      });
      connectReq.on('error', reject);
      connectReq.end();
    } else {
      const options: https.RequestOptions = {
        host: targetUrl.hostname,
        port: targetUrl.port || 443,
        path: targetUrl.pathname + targetUrl.search,
        method: 'POST',
        headers: Object.assign({}, headers, {
          'Content-Length': String(Buffer.byteLength(bodyStr)),
        }),
      };
      const req = https.request(options, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => {
          try {
            resolve({ status: resp.statusCode || 500, body: JSON.parse(data) });
          } catch {
            resolve({ status: resp.statusCode || 500, body: data });
          }
        });
      });
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    }
  });
}

/**
 * Dispatches an SMS through the TextBee Android gateway device during development.
 */
export async function sendTextBeeSms(recipientPhoneE164: string, message: string): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const config = getTextBeeConfig();
  if (!config) {
    return { success: false, error: 'TextBee credentials not configured in environment or external production.json' };
  }

  const url = config.endpoint || `https://api.textbee.dev/api/v1/gateway/devices/${config.deviceId}/send-sms`;

  try {
    const res = await postJsonThroughProxy(
      url,
      {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
      },
      {
        recipients: [recipientPhoneE164],
        message,
      }
    );

    if (res.status >= 200 && res.status < 300) {
      return { success: true, data: res.body };
    }
    return { success: false, data: res.body, error: `TextBee returned HTTP ${res.status}` };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: errorMsg };
  }
}
