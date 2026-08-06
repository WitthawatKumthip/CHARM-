// รับ webhook จาก LINE — ใช้จับ groupId ตอนบอทถูกเชิญเข้ากลุ่ม LINE ของทีม
// แล้วบันทึกไว้ใน public.app_settings (key = 'line_group_id') ให้ line-daily-check ใช้ยิงข้อความ
// พร้อมทักทายกลับทันทีตอนเข้ากลุ่ม (ใช้ Reply API ไม่เสียโควตาข้อความรายเดือน)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const JOIN_GREETING_TEXT = "สวัสดีฮะ ผมน้องณาร์ม จะช่วยพี่ๆคอยติดตามและดูแลงานให้นะฮะ";

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
      if (event.type === "join" && event.source?.type === "group") {
        const groupId = event.source.groupId;
        await supabase.from("app_settings").upsert({
          key: "line_group_id",
          value: groupId,
          updated_at: new Date().toISOString(),
        });
        console.log("Saved LINE group id:", groupId);

        if (event.replyToken) {
          const res = await fetch("https://api.line.me/v2/bot/message/reply", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${LINE_TOKEN}`,
            },
            body: JSON.stringify({
              replyToken: event.replyToken,
              messages: [{ type: "text", text: JOIN_GREETING_TEXT }],
            }),
          });
          if (!res.ok) {
            console.error("LINE reply failed:", res.status, await res.text());
          }
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
