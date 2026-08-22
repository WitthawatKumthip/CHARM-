// รันทุกวันตาม cron (ตั้งค่าใน SQL Editor ด้วย pg_cron) — เช็ค 2 เรื่อง แล้วส่งสรุปเข้ากลุ่ม LINE ของทีม:
// 1) แปลงบ้านที่ครบกำหนดวันเสร็จ (endDate) แล้ว แต่ Sequence ยังไม่ครบ/ไม่อนุมัติ
// 2) รายการสั่งของที่ใกล้ถึงวันที่ต้องสั่ง (order_due_date) แล้วยังไม่ได้สั่ง (status = pending)
// ข้ามการแจ้งเตือนทั้งหมดในวันอาทิตย์ และวันหยุดที่กำหนดไว้ใน HOLIDAYS
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const LEAD_DAYS_WARN = 1; // แจ้งเตือนล่วงหน้ากี่วันก่อนถึงกำหนดสั่งของ — ปรับเลขนี้ได้ตามต้องการ

// วันหยุดที่ไม่ต้องแจ้งเตือนใดๆ เลย (รูปแบบ YYYY-MM-DD ตามปฏิทินสากล) — เพิ่ม/ลบวันที่ได้ตามต้องการ
const HOLIDAYS = ["2026-08-12", "2026-10-13", "2026-12-05", "2026-12-31"];

Deno.serve(async (_req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const LINE_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN")!;

  // แปลงเวลาปัจจุบันเป็นเวลาไทย (UTC+7) เพื่อเช็ควันอาทิตย์/วันหยุดให้ตรง
  const nowThai = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const dayOfWeek = nowThai.getUTCDay(); // 0 = อาทิตย์
  const todayThaiStr = nowThai.toISOString().split("T")[0];

  if (dayOfWeek === 0 || HOLIDAYS.includes(todayThaiStr)) {
    console.log(`วันหยุด (${todayThaiStr}) — ข้ามการแจ้งเตือนทั้งหมด`);
    return new Response("Holiday - no notifications", { status: 200 });
  }

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

  // 1) แปลงบ้านล่าช้ากว่ากำหนด — จัดกลุ่มตามโครงการ
  const { data: projects } = await supabase.from("projects").select("id, name, units");
  const { data: records } = await supabase
    .from("sequence_records")
    .select("project_id, unit_id, seq_index, approval_status, status");

  const lateByProject = new Map<string, { unitName: string; done: number; total: number; daysLate: number }[]>();
  let lateUnitsCount = 0;
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
        const daysLate = Math.floor(
          (new Date(today).getTime() - new Date(u.endDate).getTime()) / (24 * 60 * 60 * 1000)
        );
        if (!lateByProject.has(p.name)) lateByProject.set(p.name, []);
        lateByProject.get(p.name)!.push({ unitName: u.name, done: approvedSeqSet.size, total: totalSeq, daysLate });
        lateUnitsCount++;
      }
    }
  }

  // 2) รายการสั่งของที่ใกล้/เลยกำหนดแล้วยังไม่สั่ง — จัดกลุ่มตามโครงการ
  const { data: procurements } = await supabase
    .from("procurements")
    .select("name, project_id, order_due_date, status");

  const projectNameMap = new Map((projects || []).map((p) => [p.id, p.name]));
  const procByProject = new Map<string, { name: string; overdue: boolean; daysOverdue: number; dueToday: boolean }[]>();
  let dueProcCount = 0;
  for (const item of procurements || []) {
    if (item.status !== "pending" || !item.order_due_date) continue;
    if (item.order_due_date <= warnDateStr) {
      const projName = projectNameMap.get(item.project_id) || "-";
      const overdue = item.order_due_date < today;
      const dueToday = item.order_due_date === today;
      const daysOverdue = overdue
        ? Math.floor((new Date(today).getTime() - new Date(item.order_due_date).getTime()) / (24 * 60 * 60 * 1000))
        : 0;
      if (!procByProject.has(projName)) procByProject.set(projName, []);
      procByProject.get(projName)!.push({ name: item.name, overdue, daysOverdue, dueToday });
      dueProcCount++;
    }
  }

  if (lateUnitsCount === 0 && dueProcCount === 0) {
    console.log("ไม่มีรายการต้องแจ้งเตือนวันนี้");
    return new Response("Nothing to notify", { status: 200 });
  }

  // สร้างข้อความแบบ Flex Message เพื่อให้กำหนดขนาดตัวอักษรให้เล็กลงได้ (ข้อความธรรมดาของ LINE ปรับขนาดตัวอักษรไม่ได้)
  let altText = "📋 สรุปแจ้งเตือน BuildTrack ประจำวัน";
  if (lateUnitsCount > 0) altText += ` | ล่าช้า ${lateUnitsCount} แปลง`;
  if (dueProcCount > 0) altText += ` | สั่งของ ${dueProcCount} รายการ`;
  altText = altText.slice(0, 400);

  const bodyContents: Record<string, unknown>[] = [
    { type: "text", text: "📋 สรุปแจ้งเตือน BuildTrack ประจำวัน", weight: "bold", size: "sm", color: "#111827", wrap: true },
  ];

  if (lateUnitsCount > 0) {
    bodyContents.push({ type: "separator", margin: "md" });
    bodyContents.push({
      type: "text",
      text: `🔴 แปลงบ้านล่าช้ากว่ากำหนด (${lateUnitsCount})`,
      weight: "bold",
      size: "12px",
      color: "#e11d48",
      margin: "md",
    });
    for (const [projName, items] of lateByProject) {
      bodyContents.push({ type: "text", text: projName, weight: "bold", size: "11px", color: "#374151", margin: "sm", wrap: true });
      for (const it of items) {
        bodyContents.push({
          type: "text",
          text: `• ${it.unitName} — คืบหน้า ${it.done}/${it.total} (เกิน ${it.daysLate} วัน)`,
          size: "11px",
          color: "#4b5563",
          wrap: true,
        });
      }
    }
  }

  if (dueProcCount > 0) {
    bodyContents.push({ type: "separator", margin: "md" });
    bodyContents.push({
      type: "text",
      text: `📦 รายการสั่งของที่ต้องดำเนินการ (${dueProcCount})`,
      weight: "bold",
      size: "12px",
      color: "#d97706",
      margin: "md",
    });
    for (const [projName, items] of procByProject) {
      bodyContents.push({ type: "text", text: projName, weight: "bold", size: "11px", color: "#374151", margin: "sm", wrap: true });
      for (const it of items) {
        const tag = it.overdue ? `⚠️ เกิน ${it.daysOverdue} วัน` : it.dueToday ? "📌 วันนี้" : "🗓 พรุ่งนี้";
        bodyContents.push({
          type: "text",
          text: `• ${it.name} — ${tag}`,
          size: "11px",
          color: "#4b5563",
          wrap: true,
        });
      }
    }
  }

  const flexMessage = {
    type: "flex",
    altText,
    contents: {
      type: "bubble",
      size: "giga",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "xs",
        paddingAll: "16px",
        contents: bodyContents,
      },
    },
  };

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify({
      to: groupId,
      messages: [flexMessage],
    }),
  });

  if (!res.ok) {
    console.error("LINE push failed:", res.status, await res.text());
  }

  return new Response("Sent", { status: 200 });
});
