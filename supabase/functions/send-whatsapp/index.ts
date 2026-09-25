// Solouki Phase 3 — WhatsApp sender abstraction.
// Configure WHATSAPP_ACCESS_TOKEN as a Supabase Edge Function secret.
// For Meta Cloud API, stage_whatsapp_settings.phone_number_id identifies the sender number.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type'};
const json=(body:any,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json'}});
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
 try{
  const supabase=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:req.headers.get('Authorization')||''}}});
  const {data:{user}}=await supabase.auth.getUser(); if(!user)return json({error:'unauthorized'},401);
  const {data:profile}=await supabase.from('profiles').select('role_type,is_active').eq('id',user.id).single();
  if(!profile?.is_active || !['superadmin','stage_manager','counselor'].includes(profile.role_type))return json({error:'not authorized'},403);
  const body=await req.json(); const {stage_id,to,message}=body;
  if(!stage_id||!to||!message)return json({error:'stage_id, to and message are required'},400);
  const {data:setting}=await supabase.from('stage_whatsapp_settings').select('business_number,phone_number_id,enabled').eq('stage_id',stage_id).single();
  if(!setting?.enabled || !setting.phone_number_id)return json({error:'WhatsApp stage configuration is incomplete'},400);
  const token=Deno.env.get('WHATSAPP_ACCESS_TOKEN');
  if(!token)return json({mode:'simulation',status:'ready',message:'API token is not configured. No external message was sent.'});
  const url=`https://graph.facebook.com/v23.0/${setting.phone_number_id}/messages`;
  const r=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to, type:'text',text:{body:message}})});
  const data=await r.json(); if(!r.ok)return json({error:'provider_error',details:data},502);
  return json({status:'sent',provider:'meta',provider_message_id:data?.messages?.[0]?.id||null});
 }catch(e){return json({error:String(e)},500)}
});
