/**
 * Vercel Serverless Function — وكيل جسر سلوكي
 * المسار: /api/solouki-bridge
 *
 * متغيرات البيئة المطلوبة في مشروع رصد على Vercel:
 *   SOLOUKI_BRIDGE_SECRET   = نفس السر المضبوط في Supabase سلوكي (TEACHER_BEHAVIOR_BRIDGE_SECRET)
 *   SOLOUKI_RECORD_URL      = https://<SOLOUKI_REF>.supabase.co/functions/v1/teacher-behavior-record
 *   SOLOUKI_CATALOG_URL     = https://<SOLOUKI_REF>.supabase.co/functions/v1/teacher-behavior-catalog
 *
 * الواجهة (index.html) تستدعي هذا المسار فقط — السر لا يصل للمتصفح أبداً.
 */

module.exports = async function handler(req, res) {
  // CORS بسيط لنفس الأصل / اختبار محلي
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
  }

  const secret = process.env.SOLOUKI_BRIDGE_SECRET || '';
  const recordUrl = process.env.SOLOUKI_RECORD_URL || '';
  const catalogUrl = process.env.SOLOUKI_CATALOG_URL || '';

  if (!secret) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({
      ok: false,
      error: 'server_misconfigured',
      message: 'SOLOUKI_BRIDGE_SECRET غير مضبوط في بيئة Vercel'
    }));
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  const action = body.action || 'record_violation';
  const targetUrl = (action === 'catalog' || action === 'list')
    ? catalogUrl
    : recordUrl;

  if (!targetUrl) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({
      ok: false,
      error: 'server_misconfigured',
      message: (action === 'catalog' ? 'SOLOUKI_CATALOG_URL' : 'SOLOUKI_RECORD_URL') + ' غير مضبوط'
    }));
  }

  // تنظيف الحمولة قبل الإرسال لسلوكي
  let outbound;
  if (action === 'catalog' || action === 'list') {
    outbound = { action: 'list' };
  } else if (action === 'record_merit') {
    outbound = {
      action: 'record_merit',
      external_teacher_id: String(body.external_teacher_id || ''),
      student_national_id: String(body.student_national_id || '').replace(/\D/g, ''),
      title: body.title || '',
      points: body.points != null ? Number(body.points) : undefined,
      notes: body.notes || ''
    };
  } else {
    outbound = {
      action: 'record_violation',
      external_teacher_id: String(body.external_teacher_id || ''),
      student_national_id: String(body.student_national_id || '').replace(/\D/g, ''),
      violation_id: body.violation_id,
      location_id: body.location_id,
      location_text: body.location_text || body.location || 'الفصل',
      notes: body.notes || 'أثناء الحصة'
    };
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-solouki-bridge-secret': secret
      },
      body: JSON.stringify(outbound)
    });
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch (e) {
      data = { ok: false, error: 'invalid_upstream_json', raw: text.slice(0, 400) };
    }
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify(data));
  } catch (e) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({
      ok: false,
      error: 'upstream_unreachable',
      message: e.message || String(e)
    }));
  }
};
