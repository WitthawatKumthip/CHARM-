// รันทุกวันเสาร์ตาม cron เวลา 12:00 น. (ตั้งค่าใน SQL Editor ด้วย pg_cron):
// - แจ้งเตือนให้ทีมอัปโหลดรูปหน้างานประจำสัปดาห์ให้ครบทุกแปลง
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PHOTO_REMINDER_TEXT =
  "📸 แจ้งเตือนประจำสัปดาห์ฮะ อย่าลืมอัปโหลดรูปหน้างานของสัปดาห์นี้ให้ครบทุกแปลงด้วยนะฮะ";

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

  const ok = await pushLine(LINE_TOKEN, groupId, PHOTO_REMINDER_TEXT);
  return new Response(ok ? "Photo reminder sent" : "Photo reminder failed", { status: 200 });
});
