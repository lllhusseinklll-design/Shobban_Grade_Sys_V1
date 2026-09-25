/**
 * Solouki STEP 72 — Secure teacher recording bridge (رصد → سلوكي)
 *
 * Deploy (Solouki Supabase project ONLY):
 *   supabase functions deploy teacher-behavior-record --project-ref <solouki-ref>
 *
 * Secrets (Solouki project):
 *   TEACHER_BEHAVIOR_BRIDGE_SECRET   — shared secret; same value رصد sends in header
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — auto in Edge Functions
 *   BRIDGE_RECORDED_BY_PROFILE_ID    — optional UUID if recorded_by/awarded_by are NOT NULL
 *
 * رصد (separate Vercel/Supabase) must NEVER receive Solouki service_role key.
 * رصد only stores:
 *   SOLOUKI_BRIDGE_URL = https://<solouki-ref>.supabase.co/functions/v1/teacher-behavior-record
 *   SOLOUKI_BRIDGE_SECRET = <same secret>
 *
 * Auth: header x-solouki-bridge-secret
 * Body JSON:
 * {
 *   "action": "record_violation" | "record_merit",
 *   "school_id": "uuid",                 // optional if resolvable from teacher
 *   "external_teacher_id": "T-123",
 *   "student_national_id": "14 digits",  // preferred cross-system key
 *   // or "student_id": "uuid"
 *   "violation_id": 12,                  // catalog id (violations)
 *   "location_id": 1,                    // optional
 *   "violation_date": "2026-09-25",      // optional
 *   "notes": "...",                      // optional
 *   "applied_penalty_id": null,          // optional
 *   // merits:
 *   "title": "...",
 *   "description": "...",
 *   "points": 10,
 *   "merit_date": "2026-09-25",
 *   "category": "general"
 * }
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-solouki-bridge-secret",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200);
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  try {
    const expected = Deno.env.get("TEACHER_BEHAVIOR_BRIDGE_SECRET") || "";
    const supplied = req.headers.get("x-solouki-bridge-secret") || "";
    if (!expected || !supplied || !safeEqual(expected, supplied)) {
      return json({ ok: false, error: "invalid_bridge_secret" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      return json({ ok: false, error: "server_configuration_error" }, 500);
    }

    const admin = createClient(supabaseUrl, serviceKey);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    const action = String(body.action || "").trim();
    const externalTeacherId = String(body.external_teacher_id || "").trim();
    if (!externalTeacherId) {
      return json({ ok: false, error: "external_teacher_id_required" }, 400);
    }

    // —— Resolve teacher ——
    let teacherQuery = admin
      .from("teacher_directory")
      .select("id, school_id, external_teacher_id, full_name, is_active")
      .eq("external_teacher_id", externalTeacherId)
      .eq("is_active", true);

    if (body.school_id) {
      teacherQuery = teacherQuery.eq("school_id", body.school_id);
    }

    const { data: teachers, error: tErr } = await teacherQuery.limit(2);
    if (tErr) {
      console.error("teacher_directory", tErr);
      return json({ ok: false, error: "teacher_lookup_failed" }, 500);
    }
    if (!teachers?.length) {
      return json({ ok: false, error: "teacher_not_found_or_inactive" }, 403);
    }
    if (teachers.length > 1 && !body.school_id) {
      return json({ ok: false, error: "school_id_required_ambiguous_teacher" }, 400);
    }
    const teacher = teachers[0];
    const schoolId = teacher.school_id;

    // —— Resolve student (national_id preferred) ——
    const nationalId = digits(body.student_national_id || body.national_id || "");
    let student: Record<string, unknown> | null = null;

    if (nationalId) {
      const { data, error } = await admin
        .from("students")
        .select(
          "id, school_id, stage_id, grade, class_name, section, full_name, national_id, student_code, is_active",
        )
        .eq("national_id", nationalId)
        .eq("school_id", schoolId)
        .eq("is_active", true)
        .limit(2);
      if (error) {
        console.error("students by national_id", error);
        return json({ ok: false, error: "student_lookup_failed" }, 500);
      }
      if (!data?.length) {
        return json({ ok: false, error: "student_not_found" }, 404);
      }
      if (data.length > 1) {
        return json({ ok: false, error: "student_ambiguous_national_id" }, 409);
      }
      student = data[0];
    } else if (body.student_id) {
      const { data, error } = await admin
        .from("students")
        .select(
          "id, school_id, stage_id, grade, class_name, section, full_name, national_id, student_code, is_active",
        )
        .eq("id", body.student_id)
        .eq("is_active", true)
        .maybeSingle();
      if (error) {
        console.error("students by id", error);
        return json({ ok: false, error: "student_lookup_failed" }, 500);
      }
      if (!data) return json({ ok: false, error: "student_not_found" }, 404);
      if (String(data.school_id) !== String(schoolId)) {
        return json({ ok: false, error: "student_school_mismatch" }, 403);
      }
      student = data;
    } else {
      return json({ ok: false, error: "student_national_id_or_student_id_required" }, 400);
    }

    const stageId = String(student.stage_id || "");
    const grade = String(student.grade || "");
    const className = String(student.class_name || "");
    const section = normalizeSection(student.section);

    // —— Switch: stage/section recording enabled? ——
    const kind = action === "record_merit" ? "merit" : "violation";
    const { data: switchOn, error: swErr } = await admin.rpc("teacher_recording_enabled", {
      p_school_id: schoolId,
      p_stage_id: stageId,
      p_section: section,
      p_kind: kind,
    });
    if (swErr) {
      console.error("teacher_recording_enabled", swErr);
      return json({ ok: false, error: "switch_check_failed", detail: swErr.message }, 500);
    }
    if (!switchOn) {
      return json({
        ok: false,
        error: "recording_disabled_for_stage_section",
        stage_id: stageId,
        section,
        kind,
      }, 403);
    }

    // —— Teacher class scope ——
    const { data: inScope, error: scopeErr } = await admin.rpc("teacher_is_assigned_to_class", {
      p_school_id: schoolId,
      p_external_teacher_id: externalTeacherId,
      p_stage_id: stageId,
      p_grade: grade,
      p_class_name: className,
      p_section: section,
    });
    if (scopeErr) {
      console.error("teacher_is_assigned_to_class", scopeErr);
      return json({ ok: false, error: "scope_check_failed", detail: scopeErr.message }, 500);
    }
    if (!inScope) {
      return json({
        ok: false,
        error: "teacher_not_assigned_to_student_class",
        stage_id: stageId,
        grade,
        class_name: className,
        section,
      }, 403);
    }

    const bridgeActor = Deno.env.get("BRIDGE_RECORDED_BY_PROFILE_ID") || null;
    const teacherNote = `معلم رصد: ${teacher.full_name} [${externalTeacherId}]`;

    if (action === "record_violation") {
      return await recordViolation(admin, {
        body,
        student,
        schoolId,
        stageId,
        teacher,
        externalTeacherId,
        bridgeActor,
        teacherNote,
      });
    }
    if (action === "record_merit") {
      return await recordMerit(admin, {
        body,
        student,
        schoolId,
        stageId,
        teacher,
        externalTeacherId,
        bridgeActor,
        teacherNote,
      });
    }

    return json({ ok: false, error: "unknown_action", allowed: ["record_violation", "record_merit"] }, 400);
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: "unexpected_error", detail: String(e?.message || e) }, 500);
  }
});

async function recordViolation(
  admin: ReturnType<typeof createClient>,
  ctx: {
    body: Record<string, unknown>;
    student: Record<string, unknown>;
    schoolId: string;
    stageId: string;
    teacher: { full_name: string };
    externalTeacherId: string;
    bridgeActor: string | null;
    teacherNote: string;
  },
) {
  const violationId = ctx.body.violation_id != null ? Number(ctx.body.violation_id) : null;
  if (!violationId || Number.isNaN(violationId)) {
    return json({ ok: false, error: "violation_id_required" }, 400);
  }

  const { data: cat, error: cErr } = await admin
    .from("violations_catalog")
    .select("id, code, description_ar, degree_id, is_active")
    .eq("id", violationId)
    .maybeSingle();
  if (cErr) {
    console.error(cErr);
    return json({ ok: false, error: "catalog_lookup_failed" }, 500);
  }
  if (!cat || cat.is_active === false) {
    return json({ ok: false, error: "violation_not_found_or_inactive" }, 400);
  }

  let locationId = ctx.body.location_id != null ? Number(ctx.body.location_id) : null;
  if (locationId != null && Number.isNaN(locationId)) locationId = null;

  const notes = [ctx.teacherNote, ctx.body.notes ? String(ctx.body.notes) : ""]
    .filter(Boolean)
    .join(" · ");

  const row: Record<string, unknown> = {
    student_id: ctx.student.id,
    stage_id: ctx.stageId,
    school_id: ctx.schoolId,
    violation_id: cat.id,
    degree_id: cat.degree_id,
    location_id: locationId,
    violation_date: ctx.body.violation_date || new Date().toISOString().slice(0, 10),
    registration_date: new Date().toISOString(),
    applied_penalty_id: ctx.body.applied_penalty_id != null
      ? Number(ctx.body.applied_penalty_id)
      : null,
    notes: notes || null,
    source: "teacher_bridge",
    external_teacher_id: ctx.externalTeacherId,
    external_teacher_name: ctx.teacher.full_name,
  };
  if (ctx.bridgeActor) row.recorded_by = ctx.bridgeActor;

  const { data: inserted, error } = await admin
    .from("violation_records")
    .insert(row)
    .select("id, violation_date, degree_id, student_id")
    .single();

  if (error) {
    console.error("insert violation", error);
    // common: recorded_by NOT NULL without BRIDGE_RECORDED_BY_PROFILE_ID
    if (/recorded_by|null value/i.test(error.message || "")) {
      return json({
        ok: false,
        error: "recorded_by_required",
        hint: "Set Edge secret BRIDGE_RECORDED_BY_PROFILE_ID to an active profiles.id",
      }, 500);
    }
    return json({ ok: false, error: "insert_failed", detail: error.message }, 500);
  }

  return json({
    ok: true,
    action: "record_violation",
    record_id: inserted.id,
    student_id: inserted.student_id,
    degree_id: inserted.degree_id,
    violation_date: inserted.violation_date,
    catalog: { id: cat.id, code: cat.code, description_ar: cat.description_ar },
    teacher: {
      external_teacher_id: ctx.externalTeacherId,
      full_name: ctx.teacher.full_name,
    },
  });
}

async function recordMerit(
  admin: ReturnType<typeof createClient>,
  ctx: {
    body: Record<string, unknown>;
    student: Record<string, unknown>;
    schoolId: string;
    stageId: string;
    teacher: { full_name: string };
    externalTeacherId: string;
    bridgeActor: string | null;
    teacherNote: string;
  },
) {
  const title = String(ctx.body.title || "").trim();
  if (!title) return json({ ok: false, error: "title_required" }, 400);

  const points = ctx.body.points != null ? Number(ctx.body.points) : 10;
  const notes = [ctx.teacherNote, ctx.body.notes ? String(ctx.body.notes) : ""]
    .filter(Boolean)
    .join(" · ");

  const row: Record<string, unknown> = {
    student_id: ctx.student.id,
    stage_id: ctx.stageId,
    school_id: ctx.schoolId,
    title,
    description: ctx.body.description ? String(ctx.body.description) : null,
    points: Number.isFinite(points) ? points : 10,
    merit_date: ctx.body.merit_date || new Date().toISOString().slice(0, 10),
    category: ctx.body.category ? String(ctx.body.category) : "general",
    notes: notes || null,
    source: "teacher_bridge",
    external_teacher_id: ctx.externalTeacherId,
    external_teacher_name: ctx.teacher.full_name,
  };
  if (ctx.bridgeActor) row.awarded_by = ctx.bridgeActor;

  const { data: inserted, error } = await admin
    .from("merit_records")
    .insert(row)
    .select("id, merit_date, points, student_id")
    .single();

  if (error) {
    console.error("insert merit", error);
    if (/awarded_by|null value/i.test(error.message || "")) {
      return json({
        ok: false,
        error: "awarded_by_required",
        hint: "Set Edge secret BRIDGE_RECORDED_BY_PROFILE_ID to an active profiles.id",
      }, 500);
    }
    return json({ ok: false, error: "insert_failed", detail: error.message }, 500);
  }

  return json({
    ok: true,
    action: "record_merit",
    record_id: inserted.id,
    student_id: inserted.student_id,
    points: inserted.points,
    merit_date: inserted.merit_date,
    teacher: {
      external_teacher_id: ctx.externalTeacherId,
      full_name: ctx.teacher.full_name,
    },
  });
}

function normalizeSection(raw: unknown): string {
  const s = String(raw || "").trim().toLowerCase();
  if (["languages", "lang", "language", "لغات", "لغة", "english"].includes(s)) {
    return "languages";
  }
  return "arabic";
}

function digits(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });
}
