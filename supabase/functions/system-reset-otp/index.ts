// Solouki STEP 63 — Edge Function: issue OTP + optional email + optional storage wipe
// Deploy: supabase functions deploy system-reset-otp
// Secrets (optional): RESEND_API_KEY, RESEND_FROM_EMAIL
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ ok: false, error: "missing_auth" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Client as the calling user (to verify identity)
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return json({ ok: false, error: "invalid_session" }, 401);
    }
    const userId = userData.user.id;

    // Service role client
    const admin = createClient(supabaseUrl, serviceKey);

    // Confirm superadmin
    const { data: profile, error: pErr } = await admin
      .from("profiles")
      .select("id, role_type, is_active, full_name")
      .eq("id", userId)
      .maybeSingle();
    if (pErr || !profile || profile.role_type !== "superadmin" || profile.is_active === false) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const action = body?.action || "send_otp";

    if (action === "send_otp") {
      const { data: issued, error: issErr } = await admin.rpc("admin_issue_system_reset_otp", {
        p_user_id: userId,
      });
      if (issErr) {
        console.error("issue otp error", issErr);
        return json({ ok: false, error: issErr.message || "issue_failed" }, 500);
      }
      if (!issued?.ok) {
        return json({ ok: false, error: issued?.error || "issue_failed" }, 400);
      }

      const email = issued.email as string;
      const code = issued.code as string;
      let emailed = false;
      let emailError: string | null = null;

      const resendKey = Deno.env.get("RESEND_API_KEY");
      const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "Solouki <onboarding@resend.dev>";

      if (resendKey) {
        try {
          const resp = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${resendKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: fromEmail,
              to: [email],
              subject: "كود تأكيد تنظيف نظام سلوكي",
              html: `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif">
                <h2>تأكيد تنظيف جميع بيانات سلوكي</h2>
                <p>طلبتَ تنفيذ عملية مسح كاملة للنظام.</p>
                <p>كود التحقق (صالح 10 دقائق):</p>
                <p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p>
                <p style="color:#b91c1c">إذا لم تطلب هذا، تجاهل الرسالة فوراً وغيّر كلمة المرور.</p>
              </div>`,
            }),
          });
          if (!resp.ok) {
            const t = await resp.text();
            emailError = t.slice(0, 200);
            console.error("resend failed", t);
          } else {
            emailed = true;
          }
        } catch (e) {
          emailError = String(e);
          console.error("resend exception", e);
        }
      } else {
        // بدون مزوّد بريد: سجّل الكود في سجلات الدالة للطوارئ أثناء الإعداد فقط
        console.log(`[SOLOUKI-RESET-OTP] user=${userId} email=${email} code=${code}`);
        emailError = "RESEND_API_KEY not configured — code logged to function logs only";
      }

      const hint = email.replace(/(^.).*(@.*$)/, "$1***$2");
      return json({
        ok: true,
        emailed,
        email_hint: hint,
        expires_in_seconds: 600,
        email_error: emailError,
      });
    }

    if (action === "wipe_storage") {
      // مسح ملفات student-files بعد نجاح المسح من قاعدة البيانات
      try {
        const bucket = "student-files";
        let removed = 0;
        const { data: listed, error: listErr } = await admin.storage.from(bucket).list("", {
          limit: 1000,
        });
        if (listErr) {
          console.error("storage list", listErr);
          return json({ ok: false, error: listErr.message }, 500);
        }
        // list top-level folders/files then recurse shallow
        const paths: string[] = [];
        for (const item of listed || []) {
          if (item.id) paths.push(item.name);
          else {
            const { data: sub } = await admin.storage.from(bucket).list(item.name, { limit: 1000 });
            for (const s of sub || []) {
              paths.push(`${item.name}/${s.name}`);
            }
          }
        }
        if (paths.length) {
          const { error: rmErr } = await admin.storage.from(bucket).remove(paths);
          if (rmErr) console.error("storage remove", rmErr);
          else removed = paths.length;
        }
        return json({ ok: true, removed });
      } catch (e) {
        console.error(e);
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
