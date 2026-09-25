// Solouki — دخول الطاقم برقم سري (مثل نظام رصد الدرجات)
// الاسم + PIN → جلسة Auth بدون الحاجة لكلمة مرور البريد
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceKey)

    let body: any
    try {
      body = await req.json()
    } catch {
      return json({ error: 'invalid json' }, 400)
    }

    const profileId = String(body?.profile_id || '').trim()
    const pin = String(body?.pin || '').trim()

    if (!UUID_RE.test(profileId)) return json({ error: 'profile_id غير صالح' }, 400)
    if (!pin || pin.length < 4) return json({ error: 'أدخل الرقم السري' }, 400)

    // Rate limit بسيط عبر failed_attempts إن وُجد العمود
    const { data: profile, error: pErr } = await admin
      .from('profiles')
      .select('id, full_name, email, role_type, is_active, pin_hash, locked_until, failed_attempts')
      .eq('id', profileId)
      .maybeSingle()

    if (pErr || !profile) return json({ error: 'الحساب غير موجود' }, 404)
    if (!profile.is_active) return json({ error: 'الحساب موقوف' }, 403)
    if (!profile.email) return json({ error: 'لا يوجد بريد مرتبط بهذا الحساب' }, 400)
    if (!profile.pin_hash) return json({ error: 'لم يُصدر رقم سري لهذا الحساب بعد — راجع المسؤول العام' }, 400)

    if (profile.locked_until && new Date(profile.locked_until) > new Date()) {
      return json({ error: 'الحساب مقفل مؤقتاً بسبب محاولات فاشلة. انتظر قليلاً.' }, 429)
    }

    // يجب أن يكون PIN مخزناً كـ bcrypt. لا نحاول مقارنة PIN مع قيمة خام
    // ولا نعتمد على verify_pin العامة أولاً، لأن نسخة قديمة منها قد تكون
    // موجودة في قاعدة البيانات وتعيد false حتى بعد تحديث الدوال.
    const looksLikeBcrypt = /^\$2[aby]?\$\d\d\$/.test(String(profile.pin_hash || ''))
    if (!looksLikeBcrypt) {
      return json({
        error: 'رقم PIN لهذا الحساب غير مهيأ بالتنسيق الآمن. أعد إصدار PIN جديداً من إدارة المستخدمين ثم حاول مرة أخرى.',
        code: 'PIN_HASH_NEEDS_RESET',
      }, 409)
    }

    // استخدم دالة الخدمة المخصصة أولاً؛ فهي مصممة للاستدعاء من Edge Function
    // باستخدام service_role. ثم نستخدم verify_pin كخطة بديلة للتوافق.
    let pinOk = false
    let verifyError: any = null

    const { data: serviceOk, error: serviceErr } = await admin.rpc('verify_pin_service', {
      p_user_id: profileId,
      p_pin: pin,
    })

    if (!serviceErr) {
      pinOk = serviceOk === true
    } else {
      verifyError = serviceErr
      const { data: ok, error: vErr } = await admin.rpc('verify_pin', {
        p_user_id: profileId,
        p_pin: pin,
      })
      if (!vErr) {
        pinOk = ok === true
      } else {
        verifyError = vErr
      }
    }

    if (verifyError && !pinOk) {
      console.error('PIN verification RPC failed', verifyError.message || verifyError)
      return json({
        error: 'تعذر التحقق من الرقم السري. تأكد من تنفيذ SQL الخاص بتسجيل دخول الطاقم (50.3) في Supabase.',
        code: 'PIN_VERIFY_NOT_READY',
      }, 500)
    }

    if (!pinOk) {
      // زيادة المحاولات الفاشلة
      try {
        const fails = (profile.failed_attempts || 0) + 1
        const lockSec = Math.min(60, Math.pow(2, Math.min(fails, 6)))
        await admin.from('profiles').update({
          failed_attempts: fails,
          locked_until: fails >= 5 ? new Date(Date.now() + lockSec * 1000).toISOString() : null,
        }).eq('id', profileId)
      } catch (_) { /* ignore */ }
      return json({ error: 'الرقم السري غير صحيح' }, 401)
    }

    // تصفير المحاولات
    try {
      await admin.from('profiles').update({
        failed_attempts: 0,
        locked_until: null,
        last_login_at: new Date().toISOString(),
      }).eq('id', profileId)
    } catch (_) { /* ignore */ }

    // إنشاء رابط سحري وتبادل الرمز لجلسة فورية (بدون إيميل)
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: profile.email,
    })
    if (linkErr || !linkData?.properties?.hashed_token) {
      return json({
        error: linkErr?.message || 'تعذّر إنشاء جلسة الدخول. تأكد أن الحساب موجود في Authentication.',
      }, 500)
    }

    return json({
      ok: true,
      token_hash: linkData.properties.hashed_token,
      email: profile.email,
      full_name: profile.full_name,
      role_type: profile.role_type,
      profile_id: profile.id,
    })
  } catch (e) {
    return json({ error: String((e as any)?.message || e) }, 500)
  }
})
