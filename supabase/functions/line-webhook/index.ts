// รับ webhook จาก LINE — ทำ 2 อย่าง:
// 1) ตอนบอทถูกเชิญเข้ากลุ่ม (event: join) → บันทึก groupId ไว้ใน app_settings แล้วทักทายกลับ
// 2) ตอนมีคนแท็กบอทในข้อความ (@ชื่อบอท) → ตอบสรุปความคืบหน้าทุกโครงการ (ดึงจากฐานข้อมูลตรงๆ ไม่ใช้ AI)
// ใช้ Reply API ทั้งคู่ ไม่เสียโควตาข้อความรายเดือน
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const JOIN_GREETING_TEXT = "สวัสดีฮะ ผมน้องณาร์ม จะช่วยพี่ๆคอยติดตามและดูแลงานให้นะฮะ";

async function replyLine(token: string, replyToken: string, text: string) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
  if (!res.ok) {
    console.error("LINE reply failed:", res.status, await res.text());
  }
}

// สร้างข้อความสรุปความคืบหน้าทุกโครงการ (แบบเดียวกับที่โชว์ในหน้า Dashboard ของเว็บ)
async function buildProgressSummary(supabase: ReturnType<typeof createClient>) {
  const { data: projects } = await supabase.from("projects").select("id, name, units");
  const { data: records } = await supabase
    .from("sequence_records")
    .select("project_id, unit_id, seq_index, approval_status, status");
  const { data: settingsRow } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "master_seq")
    .maybeSingle();

  const masterSeq = settingsRow?.value;
  const totalSeq = Array.isArray(masterSeq) && masterSeq.length > 0 ? masterSeq.length : 10;

  if (!projects || projects.length === 0) {
    return "ยังไม่มีข้อมูลโครงการในระบบครับ";
  }

  const lines = ["📊 สรุปความคืบหน้าทุกโครงการ"];

  for (const p of projects) {
    const units = Array.isArray(p.units) ? p.units : [];
    if (units.length === 0) {
      lines.push(`🏗️ ${p.name}: ยังไม่มีแปลงบ้านในระบบ`);
      continue;
    }

    let completedUnits = 0;
    for (const u of units) {
      const approvedSeqSet = new Set(
        (records || [])
          .filter(
            (r) =>
              r.project_id === p.id &&
              r.unit_id === u.id &&
              r.approval_status === "approved" &&
              r.status === "completed"
          )
          .map((r) => r.seq_index)
      );
      if (approvedSeqSet.size >= totalSeq) completedUnits++;
    }

    const pct = Math.round((completedUnits / units.length) * 100);
    lines.push(`🏗️ ${p.name}: ${completedUnits}/${units.length} หลัง (${pct}%)`);
  }

  return lines.join("\n");
}

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    const events = body.events || [];

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const LINE_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN")!;

    for (const event of events) {
      // ---------- บอทถูกเชิญเข้ากลุ่ม ----------
      if (event.type === "join" && event.source?.type === "group") {
        const groupId = event.source.groupId;
        await supabase.from("app_settings").upsert({
          key: "line_group_id",
          value: groupId,
          updated_at: new Date().toISOString(),
        });
        console.log("Saved LINE group id:", groupId);

        if (event.replyToken) {
          await replyLine(LINE_TOKEN, event.replyToken, JOIN_GREETING_TEXT);
        }
      }

      // ---------- มีคนแท็กบอทในข้อความ ----------
      if (event.type === "message" && event.message?.type === "text") {
        const mentionees = event.message.mention?.mentionees || [];
        const botIsMentioned = mentionees.some((m: { isSelf?: boolean }) => m.isSelf);

        if (botIsMentioned && event.replyToken) {
          const summary = await buildProgressSummary(supabase);
          await replyLine(LINE_TOKEN, event.replyToken, summary);
        }
      }
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("line-webhook error:", err);
    // ตอบ 200 เสมอ ไม่งั้น LINE จะ retry ส่ง event ซ้ำ
    return new Response("OK", { status: 200 });
  }
});
