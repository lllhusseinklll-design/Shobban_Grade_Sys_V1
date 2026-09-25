// Solouki STEP 59 — WhatsApp Cloud API sender
// Required Edge Function secrets:
// WHATSAPP_ACCESS_TOKEN, WHATSAPP_API_VERSION (optional, default v23.0)
// The database never stores the token.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const auth = req.headers.get('Authorization')
    if (!auth?.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401)
    const url = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const token = Deno.env.get('WHATSAPP_ACCESS_TOKEN')
    const apiVersion = Deno.env.get('WHATSAPP_API_VERSION') || 'v23.0'
    if (!token) return json({ error: 'WHATSAPP_ACCESS_TOKEN is not configured' }, 503)

    const userClient = createClient(url, anon, { global: { headers: { Authorization: auth } } })
    const admin = createClient(url, service)
    const { data: { user } } = await userClient.auth.getUser()
    if (!user) return json({ error: 'unauthorized' }, 401)
    const { data: actor } = await admin.from('profiles').select('id,role_type,is_active,school_id').eq('id', user.id).single()
    if (!actor?.is_active || !['superadmin','stage_manager','counselor'].includes(actor.role_type)) return json({ error: 'not authorized' }, 403)

    const body = await req.json().catch(() => ({}))
    const notificationId = body?.notification_id
    if (!notificationId) return json({ error: 'notification_id required' }, 400)

    const { data: n, error: nErr } = await admin.from('whatsapp_notifications').select('id,student_id,stage_id,recipient_phone,message,status,attempts').eq('id', notificationId).single()
    if (nErr || !n) return json({ error: 'notification not found' }, 404)
    if (!['queued','failed'].includes(n.status)) return json({ error: 'notification already sent or in progress', status: n.status }, 409)
    if (actor.role_type === 'stage_manager') {
      const { data: a } = await admin.from('stage_assignments').select('stage_id').eq('profile_id', actor.id).eq('stage_id', n.stage_id).maybeSingle()
      if (!a) return json({ error: 'not authorized for this stage' }, 403)
    }
    if (actor.role_type === 'counselor') {
      const { data: st } = await admin.from('students').select('stage_id,grade,class_name,section').eq('id', n.student_id).single()
      const { data: a } = st ? await admin.from('counselor_class_assignments').select('stage_id').eq('counselor_id', actor.id).eq('stage_id', st.stage_id).eq('grade', st.grade).eq('class_name', st.class_name).eq('section', st.section).maybeSingle() : { data: null }
      if (!a) return json({ error: 'not authorized for this student' }, 403)
    }

    await admin.from('whatsapp_notifications').update({ status: 'sending', attempts: (n.attempts || 0) + 1, last_attempt_at: new Date().toISOString(), error_text: null }).eq('id', n.id)

    const { data: settings } = await admin.from('stage_whatsapp_settings').select('phone_number_id,enabled').eq('stage_id', n.stage_id).maybeSingle()
    if (!settings?.enabled || !settings.phone_number_id) {
      const errorText = 'إعدادات WhatsApp للمرحلة غير مكتملة أو غير مفعلة'
      await admin.from('whatsapp_notifications').update({ status: 'failed', error_text: errorText }).eq('id', n.id)
      return json({ error: errorText }, 400)
    }

    // Cloud API free-form text is subject to WhatsApp conversation/template rules.
    // For proactive school notifications, configure an approved template in a later step.
    const endpoint = `https://graph.facebook.com/${apiVersion}/${settings.phone_number_id}/messages`
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: n.recipient_phone, type: 'text', text: { preview_url: false, body: n.message } }),
    })
    const result = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      const errorText = result?.error?.message || `WhatsApp API HTTP ${resp.status}`
      await admin.from('whatsapp_notifications').update({ status: 'failed', error_text: errorText }).eq('id', n.id)
      return json({ error: errorText, provider: result }, 400)
    }
    const messageId = result?.messages?.[0]?.id || null
    await admin.from('whatsapp_notifications').update({ status: 'sent', provider_message_id: messageId, sent_at: new Date().toISOString(), error_text: null }).eq('id', n.id)
    await admin.rpc('record_audit_event', { p_action_key: 'whatsapp_notification_sent', p_entity_type: 'whatsapp_notification', p_entity_id: n.id, p_details: { student_id: n.student_id, provider_message_id: messageId } })
    return json({ ok: true, notification_id: n.id, provider_message_id: messageId })
  } catch (e) {
    return json({ error: String((e as any)?.message || e) }, 500)
  }
})
