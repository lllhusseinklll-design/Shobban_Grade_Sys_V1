/**
 * Vercel Serverless — جسر رصد → سلوكي
 * المسار: /api/solouki-bridge
 *
 * متغيرات البيئة في Vercel (رصد فقط — لا تُوضع في المتصفح):
 *   SOLOUKI_BRIDGE_SECRET  = نفس TEACHER_BEHAVIOR_BRIDGE_SECRET في سلوكي
 *   SOLOUKI_CATALOG_URL    = https://<SOLOUKI_REF>.supabase.co/functions/v1/teacher-behavior-catalog
 *   SOLOUKI_RECORD_URL     = https://<SOLOUKI_REF>.supabase.co/functions/v1/teacher-behavior-record
 *   (أو SOLOUKI_BRIDGE_URL كبديل لـ RECORD)
 */
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  const secret = process.env.SOLOUKI_BRIDGE_SECRET || '';
  const catalogUrl = process.env.SOLOUKI_CATALOG_URL || '';
  const recordUrl =
    process.env.SOLOUKI_RECORD_URL ||
    process.env.SOLOUKI_BRIDGE_URL ||
    '';

  if (!secret) {
    return json(res, 500, { ok: false, error: 'server_missing_SOLOUKI_BRIDGE_SECRET' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return json(res, 400, { ok: false, error: 'invalid_json' });
  }

  const action = String(body.action || '').trim();
  let target = '';
  if (action === 'catalog' || action === 'list') {
    target = catalogUrl;
    if (!target) {
      return json(res, 500, { ok: false, error: 'server_missing_SOLOUKI_CATALOG_URL' });
    }
  } else {
    target = recordUrl;
    if (!target) {
      return json(res, 500, { ok: false, error: 'server_missing_SOLOUKI_RECORD_URL' });
    }
  }

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-solouki-bridge-secret': secret,
      },
      body: JSON.stringify(body),
    });
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { ok: false, error: 'invalid_upstream_json', raw: text.slice(0, 500) }; }
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data));
  } catch (e) {
    return json(res, 502, { ok: false, error: 'upstream_fetch_failed', detail: String(e && e.message || e) });
  }
};
