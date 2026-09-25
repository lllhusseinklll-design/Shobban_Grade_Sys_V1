// Solouki — إعادة تعيين كلمة مرور مستخدم (المسؤول العام أو مسؤول الحاسب)
// Deploy: supabase functions deploy admin-reset-password
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

const WEAK_PASSWORDS = new Set([
  'password', 'password1', '12345678', '123456789', 'qwertyui',
  '11111111', '00000000', 'admin123', 'iloveyou',
])

function generatePassword(length = 12): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^&*'
  const arr = new Uint32Array(length)
  crypto.getRandomValues(arr)
  return Array.from(arr, (n) => chars[n % chars.length]).join('')
}

function isStrongEnough(pw: string): boolean {
  if (pw.length < 8) return false
  if (WEAK_PASSWORDS.has(pw.toLowerCase())) return false
  // يجب أن يحتوي على حرفين مختلفين على الأقل
  if (new Set(pw).size < 4) return false
  return true
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return json({ error: 'missing or invalid auth header' }, 401)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const admin = createClient(supabaseUrl, serviceKey)

    const { data: { user }, error: userErr } = await userClient.auth.getUser()
    if (userErr || !user) return json({ error: 'unauthorized' }, 401)

    const { data: actor } = await admin
      .from('profiles')
      .select('id, role_type, school_id, full_name, is_active')
      .eq('id', user.id)
      .single()

    if (!actor?.is_active || !['superadmin', 'it_officer'].includes(actor.role_type)) {
      return json({ error: 'not authorized' }, 403)
    }

    // parse body
    let body: any
    try {
      body = await req.json()
    } catch {
      return json({ error: 'invalid json body' }, 400)
    }

    const targetId = body?.profile_id
    if (!targetId || typeof targetId !== 'string' || !UUID_RE.test(targetId)) {
      return json({ error: 'valid profile_id required' }, 400)
    }

    let newPassword = (body?.new_password || '').trim()
    if (!newPassword) {
      newPassword = generatePassword(12)
    } else if (!isStrongEnough(newPassword)) {
      return json({ error: 'password too weak' }, 400)
    }

    const { data: target } = await admin
      .from('profiles')
      .select('id, school_id, full_name, email, role_type, is_active')
      .eq('id', targetId)
      .single()

    if (!target) return json({ error: 'profile not found' }, 404)
    if (!target.is_active) return json({ error: 'target is inactive' }, 400)

    if (actor.role_type !== 'superadmin' && target.school_id !== actor.school_id) {
      return json({ error: 'wrong school' }, 403)
    }
    if (actor.role_type === 'it_officer' && target.role_type === 'superadmin') {
      return json({ error: 'cannot reset superadmin' }, 403)
    }
    // اختياري: منع it_officer من إعادة تعيين it_officer آخر
    if (actor.role_type === 'it_officer' && target.role_type === 'it_officer' && target.id !== actor.id) {
      return json({ error: 'cannot reset another it_officer' }, 403)
    }

    const { error: updErr } = await admin.auth.admin.updateUserById(targetId, {
      password: newPassword,
    })
    if (updErr) return json({ error: updErr.message }, 400)

    // إبطال الجلسات القديمة
    try {
      await admin.auth.admin.signOut(targetId, 'global')
    } catch (e) {
      console.warn('signOut failed:', e)
    }

    // تسجيل التدقيق
    try {
      await admin.rpc('record_role_audit', {
        p_action: 'reset_password',
        p_details: `${target.full_name} <${target.email || ''}>`,
        p_level: 'info',
      })
    } catch (e) {
      console.warn('audit insert failed:', e)
    }

    return json({
      ok: true,
      password: newPassword,
      email: target.email,
      full_name: target.full_name,
    })
  } catch (e) {
    return json({ error: String((e as any)?.message || e) }, 500)
  }
})