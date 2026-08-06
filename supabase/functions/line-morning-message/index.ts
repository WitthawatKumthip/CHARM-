// รันทุกวันตาม cron เวลา 07:30 น. (ตั้งค่าใน SQL Editor ด้วย pg_cron):
// - ทักทายตอนเช้า จันทร์-เสาร์ (หยุดส่งวันอาทิตย์)
// - แจ้งเตือนวันเบิกเงิน เฉพาะวันที่ 1 และ 15 ของทุกเดือน (ส่งเพิ่มจากทักทาย)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GREETING_TEXT = "สวัสดีเช้าวันใหม่ขอให้มีความสุขกับการทำงานทุกคนนะฮะ";
const PAYMENT_REMINDER_TEXT = "วันนี้เป็นวันเบิกเงินประจำเดือนพี่ๆ อย่าลืมตามเอกสารและตรวจงานให้ผู้รับจ้างด้วยนะฮะ";

async function pushLine(token: string, groupId: string, text: string) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      to: groupId,
      messages: [{ type: "text", text }],
    }),
  });
  if (!res.ok) {
    console.error("LINE push failed:", res.status, await res.text());
  }
  return res.ok;
}

Deno.serve(async (_req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const LINE_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN")!;

  const { data: row } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "line_group_id")
    .maybeSingle();

  const groupId = row?.value as string | undefined;
  if (!groupId) {
    console.log("ยังไม่มี LINE group id — เชิญบอทเข้ากลุ่มก่อน");
    return new Response("No LINE group linked yet", { status: 200 });
  }

  // แปลงเวลาปัจจุบันเป็นเวลาไทย (UTC+7) เพื่ออ่านวัน/วันที่ให้ตรง
  const nowThai = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const dayOfWeek = nowThai.getUTCDay(); // 0 = อาทิตย์, 1 = จันทร์ ... 6 = เสาร์
  const dayOfMonth = nowThai.getUTCDate();

  const results: string[] = [];

  // ทักทายตอนเช้า จันทร์-เสาร์ (ข้ามวันอาทิตย์)
  if (dayOfWeek >= 1 && dayOfWeek <= 6) {
    const ok = await pushLine(LINE_TOKEN, groupId, GREETING_TEXT);
    results.push(`greeting: ${ok ? "sent" : "failed"}`);
  }

  // แจ้งเตือนวันเบิกเงิน วันที่ 1 และ 15 ของเดือน
  if (dayOfMonth === 1 || dayOfMonth === 15) {
    const ok = await pushLine(LINE_TOKEN, groupId, PAYMENT_REMINDER_TEXT);
    results.push(`payment reminder: ${ok ? "sent" : "failed"}`);
  }

  return new Response(results.join(", ") || "Nothing scheduled today", { status: 200 });
});
