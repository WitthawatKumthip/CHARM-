// รวมข้อความ LINE ทั้งหมดของแต่ละวันให้เหลือ push เดียว — เดิมแยกเป็น 3 ฟังก์ชัน (line-morning-message, line-daily-check, line-photo-reminder)
// คนละ cron ทำให้เสียโควตาข้อความ LINE คูณ 2-3 เท่าโดยไม่จำเป็น เพราะ LINE นับ push 1 ครั้งเข้ากลุ่ม = จำนวนสมาชิกในกลุ่ม ไม่ใช่ 1 ข้อความ
// รันทุกวันตาม cron เวลา 07:30 น. (ใช้ cron เดิมของฟังก์ชันนี้ตัวเดียว — ไปลบ cron ของ line-daily-check และ line-photo-reminder ออกได้เลย ฟังก์ชันนี้ทำแทนหมดแล้ว)
// รวม 4 เรื่องเป็น push เดียว/วัน:
// 1) ทักทายตอนเช้า จันทร์-เสาร์
// 2) แจ้งเตือนวันเบิกเงิน เฉพาะวันที่ 1 และ 15 ของเดือน
// 3) แปลงบ้านที่ครบกำหนดวันเสร็จแล้วแต่ Sequence ยังไม่ครบ/ไม่อนุมัติ + รายการสั่งของที่ใกล้/เลยกำหนดสั่งแล้วยังไม่ได้สั่ง (ของเดิมจาก line-daily-check)
// 4) เตือนถ่ายรูปหน้างานประจำสัปดาห์ เฉพาะวันเสาร์ (ของเดิมจาก line-photo-reminder)
// ข้ามการแจ้งเตือนทั้งหมดในวันอาทิตย์ และวันหยุดที่กำหนดไว้ใน HOLIDAYS
//
// กระจายความถี่ให้สม่ำเสมอทั้งเดือน: ส่งเฉพาะ "วันที่คี่" ของเดือน (1, 3, 5, ...) แทนที่จะส่งทุกวันจนครบโควตาแล้วเงียบไปช่วงปลายเดือน
// เลือกวันคี่เพราะวันเบิกเงิน (1 และ 15) เป็นเลขคี่ทั้งคู่พอดี ยังได้แจ้งตรงวันเป๊ะเหมือนเดิม
// ยกเว้น "วันเสาร์" ให้ส่งได้ทุกครั้งไม่ว่าจะตรงวันคู่หรือคี่ เพื่อให้เตือนถ่ายรูปหน้างานมาครบทุกสัปดาห์แน่นอน
//
// เพดานโควตารายเดือน (สำรองไว้เผื่อกรณีผิดปกติ เช่นจำนวนคนในกลุ่มเพิ่มขึ้นมาก): เก็บยอดข้อความที่ใช้ไปแล้วของเดือนนี้ไว้ใน app_settings
// (key "line_quota_usage") ก่อนส่งทุกครั้งจะเช็คจำนวนสมาชิกกลุ่มจริงจาก LINE (เรียกไม่สำเร็จ fallback เป็น FALLBACK_GROUP_SIZE) แล้วเทียบว่า
// ถ้าส่งวันนี้ไปจะเกิน MONTHLY_MESSAGE_CAP ไหม ถ้าเกินจะข้ามการส่งวันนั้นไปเลย (การันตีไม่มีทางเกินเพดานที่ตั้งไว้ไม่ว่ากรณีใด)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GREETING_TEXT = "สวัสดีเช้าวันใหม่ขอให้มีความสุขกับการทำงานทุกคนนะฮะ";
const PAYMENT_REMINDER_TEXT = "วันนี้เป็นวันเบิกเงินประจำเดือนพี่ๆ อย่าลืมตามเอกสารและตรวจงานให้ผู้รับจ้างด้วยนะฮะ";
const PHOTO_REMINDER_TEXT = "📸 อย่าลืมอัปโหลดรูปหน้างานของสัปดาห์นี้ให้ครบทุกแปลงด้วยนะฮะ";

const LEAD_DAYS_WARN = 1; // แจ้งเตือนล่วงหน้ากี่วันก่อนถึงกำหนดสั่งของ — ปรับเลขนี้ได้ตามต้องการ

// วันหยุดที่ไม่ต้องแจ้งเตือนใดๆ เลย (รูปแบบ YYYY-MM-DD ตามปฏิทินสากล) — เพิ่ม/ลบวันที่ได้ตามต้องการ
const HOLIDAYS = ["2026-08-12", "2026-10-13", "2026-12-05", "2026-12-31"];

const MONTHLY_MESSAGE_CAP = 300; // เพดานข้อความ push รวมต่อเดือน — ปรับให้ตรง/ต่ำกว่าโควตาจริงของแพ็กเกจ LINE OA ที่ใช้อยู่เล็กน้อย
const FALLBACK_GROUP_SIZE = 16; // ใช้แทนกรณีเรียก API เช็คจำนวนสมาชิกกลุ่มไม่สำเร็จ

async function getGroupMemberCount(token: string, groupId: string): Promise<number> {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/group/${groupId}/members/count`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return FALLBACK_GROUP_SIZE;
    const data = await res.json();
    return typeof data.count === "number" ? data.count : FALLBACK_GROUP_SIZE;
  } catch {
    return FALLBACK_GROUP_SIZE;
  }
}

Deno.serve(async (_req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const LINE_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN")!;

  // แปลงเวลาปัจจุบันเป็นเวลาไทย (UTC+7) เพื่ออ่านวัน/วันที่ให้ตรง
  const nowThai = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const dayOfWeek = nowThai.getUTCDay(); // 0 = อาทิตย์, 1 = จันทร์ ... 6 = เสาร์
  const dayOfMonth = nowThai.getUTCDate();
  const todayStr = nowThai.toISOString().split("T")[0];

  if (dayOfWeek === 0 || HOLIDAYS.includes(todayStr)) {
    console.log(`วันหยุด (${todayStr}) — ข้ามการแจ้งเตือนทั้งหมด`);
    return new Response("Holiday - no notifications", { status: 200 });
  }

  // ส่งเฉพาะวันที่คี่ของเดือน เพื่อกระจายโควตาให้ใช้ได้สม่ำเสมอตลอดทั้งเดือน แทนที่จะส่งถี่ช่วงต้นเดือนแล้วครบโควตาจนต้องเงียบไปช่วงปลายเดือน
  // ยกเว้นวันเสาร์ (dayOfWeek === 6) ให้ผ่านได้เสมอ เพื่อให้เตือนถ่ายรูปหน้างานมาครบทุกสัปดาห์
  const isSaturdayToday = dayOfWeek === 6;
  if (dayOfMonth % 2 === 0 && !isSaturdayToday) {
    console.log(`วันคู่ (${todayStr}) — ข้ามเพื่อกระจายความถี่การส่งให้สม่ำเสมอทั้งเดือน`);
    return new Response("Even day - skipped to spread frequency evenly", { status: 200 });
  }

  const { data: settingsRows } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", ["line_group_id", "master_seq"]);

  const groupId = settingsRows?.find((r) => r.key === "line_group_id")?.value as string | undefined;
  const masterSeq = settingsRows?.find((r) => r.key === "master_seq")?.value;
  const totalSeq = Array.isArray(masterSeq) && masterSeq.length > 0 ? masterSeq.length : 10;

  if (!groupId) {
    console.log("ยังไม่มี LINE group id — เชิญบอทเข้ากลุ่มก่อน");
    return new Response("No LINE group linked yet", { status: 200 });
  }

  // ---- เช็คเพดานโควตารายเดือนก่อน ถ้าส่งวันนี้แล้วจะเกิน MONTHLY_MESSAGE_CAP ให้ข้ามไปเลย ----
  const monthKey = todayStr.slice(0, 7); // "YYYY-MM"
  const { data: quotaRow } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "line_quota_usage")
    .maybeSingle();

  const storedQuota = quotaRow?.value as { month?: string; count?: number } | undefined;
  const usedThisMonth = storedQuota?.month === monthKey ? (storedQuota.count || 0) : 0;

  const groupSize = await getGroupMemberCount(LINE_TOKEN, groupId);

  if (usedThisMonth + groupSize > MONTHLY_MESSAGE_CAP) {
    console.log(`ข้ามการส่งวันนี้ — ใกล้ครบโควตาเดือนนี้แล้ว (ใช้ไป ${usedThisMonth}/${MONTHLY_MESSAGE_CAP})`);
    return new Response("Skipped - would exceed monthly cap", { status: 200 });
  }

  const today = todayStr;
  const warnDate = new Date(nowThai);
  warnDate.setDate(warnDate.getDate() + LEAD_DAYS_WARN);
  const warnDateStr = warnDate.toISOString().split("T")[0];

  // ---- แปลงบ้านล่าช้ากว่ากำหนด (จัดกลุ่มตามโครงการ) ----
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

  // ---- รายการสั่งของที่ใกล้/เลยกำหนดแล้วยังไม่สั่ง (จัดกลุ่มตามโครงการ) ----
  const { data: procurements } = await supabase
    .from("procurements")
    .select("name, project_id, unit_id, order_due_date, status");

  const projectNameMap = new Map((projects || []).map((p) => [p.id, p.name]));
  const unitNameByProject = new Map<string, Map<string, string>>();
  for (const p of projects || []) {
    const units = Array.isArray(p.units) ? p.units : [];
    unitNameByProject.set(p.id, new Map(units.map((u) => [u.id, u.name])));
  }

  const procByProject = new Map<
    string,
    { name: string; unitName: string; overdue: boolean; daysOverdue: number; dueToday: boolean }[]
  >();
  let dueProcCount = 0;
  for (const item of procurements || []) {
    if (item.status !== "pending" || !item.order_due_date) continue;
    if (item.order_due_date <= warnDateStr) {
      const projName = projectNameMap.get(item.project_id) || "-";
      const unitName = unitNameByProject.get(item.project_id)?.get(item.unit_id) || "-";
      const overdue = item.order_due_date < today;
      const dueToday = item.order_due_date === today;
      const daysOverdue = overdue
        ? Math.floor((new Date(today).getTime() - new Date(item.order_due_date).getTime()) / (24 * 60 * 60 * 1000))
        : 0;
      if (!procByProject.has(projName)) procByProject.set(projName, []);
      procByProject.get(projName)!.push({ name: item.name, unitName, overdue, daysOverdue, dueToday });
      dueProcCount++;
    }
  }

  // ---- ประกอบข้อความ Flex เดียว รวมทุกเรื่องของวันนี้ ----
  const isPaymentDay = dayOfMonth === 1 || dayOfMonth === 15;
  const isSaturday = isSaturdayToday;

  let altText = "☀️ สรุปประจำวัน BuildTrack";
  if (lateUnitsCount > 0) altText += ` | ล่าช้า ${lateUnitsCount} แปลง`;
  if (dueProcCount > 0) altText += ` | สั่งของ ${dueProcCount} รายการ`;
  altText = altText.slice(0, 400);

  const bodyContents: Record<string, unknown>[] = [
    { type: "text", text: GREETING_TEXT, weight: "bold", size: "sm", color: "#111827", wrap: true },
  ];

  if (isPaymentDay) {
    bodyContents.push({ type: "separator", margin: "md" });
    bodyContents.push({
      type: "text",
      text: `💰 ${PAYMENT_REMINDER_TEXT}`,
      size: "12px",
      color: "#374151",
      margin: "md",
      wrap: true,
    });
  }

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
          text: `• [${it.unitName}] ${it.name} — ${tag}`,
          size: "11px",
          color: "#4b5563",
          wrap: true,
        });
      }
    }
  }

  if (isSaturday) {
    bodyContents.push({ type: "separator", margin: "md" });
    bodyContents.push({
      type: "text",
      text: PHOTO_REMINDER_TEXT,
      size: "12px",
      color: "#374151",
      margin: "md",
      wrap: true,
    });
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
    return new Response("LINE push failed", { status: 200 });
  }

  // อัปเดตยอดใช้โควตาของเดือนนี้ (บวกเพิ่มด้วยจำนวนสมาชิกกลุ่มที่เพิ่งส่งไป)
  await supabase
    .from("app_settings")
    .upsert({ key: "line_quota_usage", value: { month: monthKey, count: usedThisMonth + groupSize } }, { onConflict: "key" });

  return new Response("Sent", { status: 200 });
});
