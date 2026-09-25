/**
 * Solouki — إدارة الطاقم من داخل النظام (STEP 54)
 * عمليات: create | reset_password | deactivate | reactivate
 *
 * Deploy:
 *   supabase functions deploy admin-manage-staff
 *
 * يتطلب: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STAFF_ROLES = new Set(['stage_manager', 'it_officer', 'counselor'])
const WEAK = new Set([
  'password', 'password1', '12345678', '123456789', 'qwertyui',
  '11111111', '00000000', 'admin123', 'iloveyou', 'solouki123',
])

function generatePassword(length = 12): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^&*'
  const arr = new Uint32Array(length)
  crypto.getRandomValues(arr)
  let out = Array.from(arr, (n) => chars[n % chars.length]).join('')
  if (!/[A-Z]/.test(out) || !/[a-z]/.test(out) || !/[0-9]/.test(out)) {
    return generatePassword(length)
  }
  return out
}

function isStrongEnough(pw: string): boolean {
  if (!pw || pw.length < 8) return false
  if (WEAK.has(pw.toLowerCase())) return false
  if (new Set(pw).size < 4) return false
  return true
}

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return json({ error: 'missing auth' }, 401)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data: { user }, error: userErr } = await userClient.auth.getUser()
    if (userErr || !user) return json({ error: 'unauthorized' }, 401)

    const { data: actor } = await admin
      .from('profiles')
      .select('id, role_type, school_id, full_name, is_active')
      .eq('id', user.id)
      .single()

    if (!actor?.is_active) return json({ error: 'actor inactive' }, 403)

    let body: any
    try {
      body = await req.json()
    } catch {
      return json({ error: 'invalid json' }, 400)
    }

    const action = String(body?.action || '').trim()

    // ─── create ─────────────────────────────────────────────
    if (action === 'create') {
      // المسؤول العام فقط ينشئ حسابات جديدة
      if (actor.role_type !== 'superadmin') {
        return json({ error: 'superadmin only' }, 403)
      }

      const full_name = String(body.full_name || '').trim()
      const email = String(body.email || '').trim().toLowerCase()
      const role_type = String(body.role_type || '').trim()
      let password = String(body.password || '').trim()
      const personal_whatsapp = String(body.personal_whatsapp || '').trim() || null
      const stage_ids: string[] = Array.isArray(body.stage_ids) ? body.stage_ids : []
      const classes: Array<{ stage_id: string; grade: string; class_name: string }> =
        Array.isArray(body.classes) ? body.classes : []

      if (!full_name || full_name.length < 2) {
        return json({ error: 'الاسم مطلوب' }, 400)
      }
      if (!isEmail(email)) {
        return json({ error: 'بريد إلكتروني غير صالح' }, 400)
      }
      if (!STAFF_ROLES.has(role_type)) {
        return json({ error: 'دور غير مدعوم' }, 400)
      }
      if (!password) password = generatePassword(12)
      if (!isStrongEnough(password)) {
        return json({ error: 'كلمة المرور ضعيفة (8 أحرف على الأقل)' }, 400)
      }

      // منع التكرار
      const { data: existing } = await admin
        .from('profiles')
        .select('id, email')
        .ilike('email', email)
        .maybeSingle()
      if (existing) {
        return json({ error: 'هذا البريد مسجّل مسبقاً في النظام' }, 409)
      }

      // إنشاء مستخدم Auth (مؤكد البريد لتجنب انتظار التفعيل)
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          full_name,
          role_type,
        },
      })
      if (createErr || !created?.user) {
        return json({ error: createErr?.message || 'فشل إنشاء الحساب' }, 400)
      }

      const uid = created.user.id

      // ضمان وجود/تحديث profile (الـ trigger قد يكون أنشأ صفاً)
      const { error: upsertErr } = await admin.from('profiles').upsert(
        {
          id: uid,
          full_name,
          email,
          role_type,
          school_id: actor.school_id,
          must_change_password: true,
          is_active: true,
          personal_whatsapp,
          phone: personal_whatsapp,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' }
      )
      if (upsertErr) {
        // محاولة تنظيف Auth إن فشل الملف
        try {
          await admin.auth.admin.deleteUser(uid)
        } catch (_) { /* ignore */ }
        return json({ error: upsertErr.message }, 400)
      }

      // إسناد المراحل
      if (stage_ids.length && role_type !== 'counselor') {
        const rows = stage_ids
          .filter((id) => UUID_RE.test(id))
          .map((stage_id) => ({
            profile_id: uid,
            stage_id,
            assigned_by: actor.id,
          }))
        if (rows.length) {
          await admin.from('stage_assignments').insert(rows)
        }
      }

      // إسناد فصول الأخصائي
      if (role_type === 'counselor' && classes.length) {
        const rows = classes
          .filter((c) => c.stage_id && c.grade && c.class_name)
          .map((c) => ({
            counselor_id: uid,
            stage_id: c.stage_id,
            grade: c.grade,
            class_name: c.class_name,
            class_key: `${c.stage_id}:${c.grade}:${c.class_name}`,
            section: 'arabic',
            assigned_by: actor.id,
          }))
        if (rows.length) {
          await admin.from('counselor_class_assignments').insert(rows)
        }
      }

      try {
        await admin.rpc('record_role_audit', {
          p_action: 'staff_create',
          p_details: `${full_name} <${email}> / ${role_type}`,
          p_level: 'info',
        })
      } catch (_) { /* ignore */ }

      return json({
        ok: true,
        action: 'create',
        profile_id: uid,
        email,
        full_name,
        role_type,
        password, // يُعرض مرة واحدة للمسؤول لينسخه
        must_change_password: true,
      })
    }

    // ─── reset_password ─────────────────────────────────────
    if (action === 'reset_password') {
      if (!['superadmin', 'it_officer'].includes(actor.role_type)) {
        return json({ error: 'not authorized' }, 403)
      }

      const profile_id = String(body.profile_id || '')
      if (!UUID_RE.test(profile_id)) {
        return json({ error: 'profile_id غير صالح' }, 400)
      }

      let password = String(body.password || '').trim()
      if (!password) password = generatePassword(12)
      if (!isStrongEnough(password)) {
        return json({ error: 'كلمة المرور ضعيفة' }, 400)
      }

      const { data: target } = await admin
        .from('profiles')
        .select('id, school_id, full_name, email, role_type, is_active')
        .eq('id', profile_id)
        .single()

      if (!target) return json({ error: 'المستخدم غير موجود' }, 404)
      if (actor.role_type !== 'superadmin' && target.school_id !== actor.school_id) {
        return json({ error: 'wrong school' }, 403)
      }
      if (actor.role_type === 'it_officer' && target.role_type === 'superadmin') {
        return json({ error: 'cannot reset superadmin' }, 403)
      }

      // التحقق من وجود حساب Auth المقابل قبل محاولة تحديث كلمة المرور.
      // هذا يمنع ظهور 400 غامضة عندما يوجد profile بدون مستخدم Auth.
      const { data: authTarget, error: authLookupErr } = await admin.auth.admin.getUserById(profile_id)
      if (authLookupErr || !authTarget?.user) {
        return json({
          error: 'لا يوجد حساب دخول Auth مرتبط بهذا العضو. يجب إصلاح ربط الحساب أولًا.',
          code: 'AUTH_USER_NOT_FOUND',
          details: authLookupErr?.message || null,
        }, 404)
      }

      const { error: updErr } = await admin.auth.admin.updateUserById(profile_id, {
        password,
      })
      if (updErr) return json({ error: `فشل تحديث كلمة المرور: ${updErr.message}`, code: 'AUTH_PASSWORD_UPDATE_FAILED' }, 400)

      await admin
        .from('profiles')
        .update({
          must_change_password: true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', profile_id)

      try {
        await admin.auth.admin.signOut(profile_id, 'global')
      } catch (_) { /* ignore */ }

      try {
        await admin.rpc('record_role_audit', {
          p_action: 'reset_password',
          p_details: `${target.full_name} <${target.email || ''}>`,
          p_level: 'info',
        })
      } catch (_) { /* ignore */ }

      return json({
        ok: true,
        action: 'reset_password',
        profile_id,
        email: target.email,
        full_name: target.full_name,
        password,
      })
    }

    // ─── deactivate (إيقاف ناعم — السجلات تبقى) ──────────────
    if (action === 'deactivate') {
      if (actor.role_type !== 'superadmin') {
        return json({ error: 'superadmin only' }, 403)
      }

      const profile_id = String(body.profile_id || '')
      if (!UUID_RE.test(profile_id)) {
        return json({ error: 'profile_id غير صالح' }, 400)
      }
      if (profile_id === actor.id) {
        return json({ error: 'لا يمكن إيقاف حسابك أنت' }, 400)
      }

      const { data: target } = await admin
        .from('profiles')
        .select('id, full_name, email, role_type, school_id')
        .eq('id', profile_id)
        .single()

      if (!target) return json({ error: 'المستخدم غير موجود' }, 404)
      if (target.role_type === 'superadmin') {
        return json({ error: 'لا يمكن إيقاف المسؤول العام من هنا' }, 403)
      }
      if (target.school_id !== actor.school_id) {
        return json({ error: 'wrong school' }, 403)
      }

      // إيقاف الملف
      await admin
        .from('profiles')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', profile_id)

      // منع الدخول: تعطيل مستخدم Auth
      try {
        await admin.auth.admin.updateUserById(profile_id, { ban_duration: '876000h' }) // ~100 سنة
      } catch (_) {
        // إن فشل الحظر، نحاول على الأقل إبطال الجلسات
      }
      try {
        await admin.auth.admin.signOut(profile_id, 'global')
      } catch (_) { /* ignore */ }

      // إزالة الإسنادات (الدور يتوقف عن الظهور في النطاقات)
      await admin.from('stage_assignments').delete().eq('profile_id', profile_id)
      await admin.from('counselor_class_assignments').delete().eq('counselor_id', profile_id)

      try {
        await admin.rpc('record_role_audit', {
          p_action: 'staff_deactivate',
          p_details: `${target.full_name} <${target.email || ''}>`,
          p_level: 'warn',
        })
      } catch (_) { /* ignore */ }

      return json({
        ok: true,
        action: 'deactivate',
        profile_id,
        full_name: target.full_name,
        note: 'تم الإيقاف. المخالفات والتكريمات المسجّلة باسمه محفوظة.',
      })
    }

    // ─── reactivate ─────────────────────────────────────────
    if (action === 'reactivate') {
      if (actor.role_type !== 'superadmin') {
        return json({ error: 'superadmin only' }, 403)
      }

      const profile_id = String(body.profile_id || '')
      if (!UUID_RE.test(profile_id)) {
        return json({ error: 'profile_id غير صالح' }, 400)
      }

      const { data: target } = await admin
        .from('profiles')
        .select('id, full_name, email, role_type, school_id')
        .eq('id', profile_id)
        .single()

      if (!target) return json({ error: 'المستخدم غير موجود' }, 404)
      if (target.school_id !== actor.school_id) {
        return json({ error: 'wrong school' }, 403)
      }

      await admin
        .from('profiles')
        .update({ is_active: true, updated_at: new Date().toISOString() })
        .eq('id', profile_id)

      // رفع الحظر
      try {
        await admin.auth.admin.updateUserById(profile_id, { ban_duration: 'none' })
      } catch (_) { /* ignore */ }

      try {
        await admin.rpc('record_role_audit', {
          p_action: 'staff_reactivate',
          p_details: `${target.full_name} <${target.email || ''}>`,
          p_level: 'info',
        })
      } catch (_) { /* ignore */ }

      return json({
        ok: true,
        action: 'reactivate',
        profile_id,
        full_name: target.full_name,
      })
    }

    return json({ error: 'action غير معروف. استخدم: create | reset_password | deactivate | reactivate' }, 400)
  } catch (e) {
    return json({ error: String((e as any)?.message || e) }, 500)
  }
})
