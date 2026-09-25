/**
 * Solouki — استيراد مستخدمين جماعي (STEP 55: بدون PIN)
 * يعتمد على البريد + كلمة المرور + Auth
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
}
const roles = new Set(['stage_manager', 'it_officer', 'counselor'])
const ok = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: cors })
const bad = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), { status, headers: cors })

function genPassword(length = 12): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^&*'
  const arr = new Uint32Array(length)
  crypto.getRandomValues(arr)
  return Array.from(arr, (n) => chars[n % chars.length]).join('')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return bad('POST only', 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return bad('Unauthorized', 401)

  const url = Deno.env.get('SUPABASE_URL')!
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin = createClient(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const token = authHeader.replace('Bearer ', '')
  const {
    data: { user },
    error: ue,
  } = await admin.auth.getUser(token)
  if (ue || !user) return bad('Unauthorized', 401)

  const { data: actor } = await admin
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .eq('is_active', true)
    .single()
  if (!actor || actor.role_type !== 'superadmin') {
    return bad('Only active superadmin can import users', 403)
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return bad('Invalid JSON')
  }

  const rows = Array.isArray(body.rows) ? body.rows : []
  if (!rows.length || rows.length > 1000) return bad('rows must contain 1..1000 records')

  const { data: stages } = await admin
    .from('stages')
    .select('*')
    .eq('school_id', actor.school_id)
    .eq('is_active', true)
    .order('sort_order')
  const stageByName = new Map((stages || []).map((s: any) => [String(s.name_ar).trim(), s]))

  let created = 0
  let updated = 0
  const results: any[] = []

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    try {
      const role = String(r.role_type || '').trim()
      const name = String(r.full_name || '').trim()
      const email = String(r.email || '').trim().toLowerCase()
      let password = String(r.password || '').trim()

      if (!roles.has(role) || !name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw Error('بيانات أساسية غير صحيحة (دور / اسم / بريد)')
      }

      let existing: any = null
      const { data: prof } = await admin
        .from('profiles')
        .select('*')
        .eq('school_id', actor.school_id)
        .ilike('email', email)
        .maybeSingle()
      existing = prof
      let uid = existing?.id

      if (!uid) {
        if (!password || password.length < 8) password = genPassword(12)
        const { data: au, error: ce } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: name, role_type: role },
        })
        if (ce || !au?.user) throw Error(ce?.message || 'فشل إنشاء Auth')
        uid = au.user.id
        created++
      } else {
        if (password && password.length >= 8) {
          const { error: ae } = await admin.auth.admin.updateUserById(uid, {
            email,
            password,
            email_confirm: true,
          })
          if (ae) throw Error(ae.message)
        }
        updated++
      }

      const sections =
        role === 'it_officer'
          ? String(r.sections || '')
              .split(';')
              .map((x: string) => x.trim())
              .filter(Boolean)
          : []

      const { error: pe } = await admin.from('profiles').upsert(
        {
          id: uid,
          school_id: actor.school_id,
          full_name: name,
          email,
          role_type: role,
          is_active: r.is_active !== false,
          must_change_password: true,
          sections,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' }
      )
      if (pe) throw Error(pe.message)

      await admin.from('stage_assignments').delete().eq('profile_id', uid)
      let names = String(r.stage_names || '')
        .split(';')
        .map((x: string) => x.trim())
        .filter(Boolean)
      if (role === 'it_officer' && names.some((x: string) => x === 'كل المراحل')) {
        names = (stages || []).map((s: any) => s.name_ar)
      }
      const assignments = []
      for (const n of names) {
        const st = stageByName.get(n)
        if (!st) throw Error(`المرحلة غير موجودة: ${n}`)
        assignments.push({ profile_id: uid, stage_id: st.id, assigned_by: actor.id })
      }
      if (assignments.length) {
        const { error: se } = await admin.from('stage_assignments').insert(assignments)
        if (se) throw Error(se.message)
      }

      if (role === 'counselor') {
        await admin.from('counselor_class_assignments').delete().eq('counselor_id', uid)
        const classes = String(r.classes || '')
          .split(';')
          .map((x: string) => x.trim())
          .filter(Boolean)
        const cr: any[] = []
        for (const c of classes) {
          const parts = c.split('|').map((x: string) => x.trim())
          if (parts.length !== 3) throw Error(`صيغة الفصل غير صحيحة: ${c}`)
          const [sn, grade, className] = parts
          const st = stageByName.get(sn)
          if (!st) throw Error(`مرحلة الفصل غير موجودة: ${sn}`)
          cr.push({
            counselor_id: uid,
            stage_id: st.id,
            grade,
            class_name: className,
            class_key: `${st.id}:${grade}:${className}`,
            section: 'arabic',
            assigned_by: actor.id,
          })
        }
        if (cr.length) {
          const { error: ce } = await admin.from('counselor_class_assignments').insert(cr)
          if (ce) throw Error(ce.message)
        }
      }

      try {
        await admin.rpc('record_role_audit', {
          p_action: 'bulk_user_import',
          p_details: `${name} <${email}> / ${role}`,
          p_level: 'info',
        })
      } catch (_) { /* ignore */ }

      results.push({
        row: i + 2,
        status: 'ok',
        email,
        action: existing ? 'updated' : 'created',
        full_name: name,
        role_type: role,
        password: existing ? undefined : password,
      })
    } catch (e) {
      results.push({ row: i + 2, status: 'error', message: String((e as any)?.message || e) })
    }
  }

  return ok({
    created,
    updated,
    failed: results.filter((x) => x.status === 'error').length,
    results,
  })
})
