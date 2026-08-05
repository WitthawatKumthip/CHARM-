// รันทุกวันตาม cron (ตั้งค่าใน SQL Editor ด้วย pg_cron) — เช็ค 2 เรื่อง แล้วส่งสรุปเข้ากลุ่ม LINE ของทีม:
// 1) แปลงบ้านที่ครบกำหนดวันเสร็จ (endDate) แล้ว แต่ Sequence ยังไม่ครบ/ไม่อนุมัติ
// 2) รายการสั่งของที่ใกล้ถึงวันที่ต้องสั่ง (order_due_date) แล้วยังไม่ได้สั่ง (status = pending)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const LEAD_DAYS_WARN = 3; // แจ้งเตือนล่วงหน้ากี่วันก่อนถึงกำหนดสั่งของ — ปรับเลขนี้ได้ตามต้องการ

Deno.serve(async (_req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const LINE_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN")!;

  const { data: settingsRows } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", ["line_group_id", "master_seq"]);

  const groupId = settingsRows?.find((r) => r.key === "line_group_id")?.value;
  const masterSeq = settingsRows?.find((r) => r.key === "master_seq")?.value;
  const totalSeq = Array.isArray(masterSeq) && masterSeq.length > 0 ? masterSeq.length : 10;

  if (!groupId) {
    console.log("ยังไม่มี LINE group id — เชิญบอทเข้ากลุ่มก่อน");
    return new Response("No LINE group linked yet", { status: 200 });
  }

  const today = new Date().toISOString().split("T")[0];
  const warnDate = new Date();
  warnDate.setDate(warnDate.getDate() + LEAD_DAYS_WARN);
  const warnDateStr = warnDate.toISOString().split("T")[0];

  // 1) แปลงบ้านล่าช้ากว่ากำหนด
  const { data: projects } = await supabase.from("projects").select("id, name, units");
  const { data: records } = await supabase
    .from("sequence_records")
    .select("project_id, unit_id, seq_index, approval_status, status");

  const lateUnits: string[] = [];
  for (const p of projects || []) {
    const units = Array.isArray(p.units) ? p.units : [];
    for (const u of units) {
      if (!u.endDate || u.endDate >= today) continue;
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
      if (approvedSeqSet.size < totalSeq) {
        lateUnits.push(
          `• ${p.name} — ${u.name} (ครบกำหนด ${u.endDate}, คืบหน้า ${approvedSeqSet.size}/${totalSeq})`
        );
      }
    }
  }

  // 2) รายการสั่งของที่ใกล้/เลยกำหนดแล้วยังไม่สั่ง
  const { data: procurements } = await supabase
    .from("procurements")
    .select("name, project_id, order_due_date, status");

  const projectNameMap = new Map((projects || []).map((p) => [p.id, p.name]));
  const dueProcurements: string[] = [];
  for (const item of procurements || []) {
    if (item.status !== "pending" || !item.order_due_date) continue;
    if (item.order_due_date <= warnDateStr) {
      const tag = item.order_due_date < today ? "เลยกำหนดแล้ว" : `กำหนด ${item.order_due_date}`;
      dueProcurements.push(`• ${item.name} (${projectNameMap.get(item.project_id) || "-"}) — ${tag}`);
    }
  }

  if (lateUnits.length === 0 && dueProcurements.length === 0) {
    console.log("ไม่มีรายการต้องแจ้งเตือนวันนี้");
    return new Response("Nothing to notify", { status: 200 });
  }

  let msg = "📋 สรุปแจ้งเตือน BuildTrack ประจำวัน\n";
  if (lateUnits.length > 0) {
    msg += `\n🔴 แปลงบ้านล่าช้ากว่ากำหนด (${lateUnits.length} แปลง):\n${lateUnits.join("\n")}\n`;
  }
  if (dueProcurements.length > 0) {
    msg += `\n📦 รายการสั่งของที่ต้องดำเนินการ (${dueProcurements.length} รายการ):\n${dueProcurements.join("\n")}\n`;
  }

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify({
      to: groupId,
      messages: [{ type: "text", text: msg.slice(0, 4900) }],
    }),
  });

  if (!res.ok) {
    console.error("LINE push failed:", res.status, await res.text());
  }

  return new Response("Sent", { status: 200 });
});
