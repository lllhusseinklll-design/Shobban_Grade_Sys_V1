// Solouki STEP 60 — WhatsApp Cloud API delivery webhook
// Secrets: WHATSAPP_VERIFY_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const verifyToken = Deno.env.get('WHATSAPP_VERIFY_TOKEN') || ''
    const admin = createClient(url, service)

    if (req.method === 'GET') {
      const u = new URL(req.url)
      const mode = u.searchParams.get('hub.mode')
      const token = u.searchParams.get('hub.verify_token')
      const challenge = u.searchParams.get('hub.challenge')
      if (mode === 'subscribe' && token && token === verifyToken && challenge) {
        return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
      }
      return json({ error: 'verification failed' }, 403)
    }

    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
    const body = await req.json().catch(() => ({}))
    const entries = Array.isArray(body?.entry) ? body.entry : []
    let processed = 0

    for (const entry of entries) {
      for (const change of (entry?.changes || [])) {
        const value = change?.value || {}
        const statuses = Array.isArray(value?.statuses) ? value.statuses : []
        for (const st of statuses) {
          const providerMessageId = st?.id || null
          const eventStatus = st?.status || 'unknown'
          if (!providerMessageId) continue
          const eventTs = st?.timestamp ? new Date(Number(st.timestamp) * 1000).toISOString() : new Date().toISOString()
          const err = Array.isArray(st?.errors) && st.errors.length ? st.errors[0] : null

          const { data: notification } = await admin.from('whatsapp_notifications')
            .select('id,school_id')
            .eq('provider_message_id', providerMessageId)
            .maybeSingle()

          await admin.from('whatsapp_webhook_events').insert({
            school_id: notification?.school_id || null,
            notification_id: notification?.id || null,
            provider_message_id: providerMessageId,
            event_status: eventStatus,
            event_timestamp: eventTs,
            error_code: err?.code ? String(err.code) : null,
            error_title: err?.title || err?.message || null,
            payload: st,
          })

          if (notification?.id) {
            const update = {
              provider_status: eventStatus,
              provider_status_at: eventTs,
              provider_error_code: err?.code ? String(err.code) : null,
              error_text: eventStatus === 'failed' ? (err?.title || err?.message || 'فشل لدى مزود WhatsApp') : null,
            }
            await admin.from('whatsapp_notifications').update(update).eq('id', notification.id)
            if (eventStatus === 'failed') {
              await admin.rpc('record_audit_event', {
                p_action_key: 'whatsapp_notification_provider_failed',
                p_entity_type: 'whatsapp_notification',
                p_entity_id: notification.id,
                p_details: { provider_message_id: providerMessageId, error_code: err?.code || null },
              })
            }
          }
          processed++
        }
      }
    }
    return json({ ok: true, processed })
  } catch (e) {
    return json({ error: String((e as any)?.message || e) }, 500)
  }
})
