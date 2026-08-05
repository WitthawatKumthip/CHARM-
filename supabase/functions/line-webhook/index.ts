// รับ webhook จาก LINE — ใช้จับ groupId ตอนบอทถูกเชิญเข้ากลุ่ม LINE ของทีม
// แล้วบันทึกไว้ใน public.app_settings (key = 'line_group_id') ให้ line-daily-check ใช้ยิงข้อความ
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    const events = body.events || [];

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    for (const event of events) {
      if (event.type === "join" && event.source?.type === "group") {
        const groupId = event.source.groupId;
        await supabase.from("app_settings").upsert({
          key: "line_group_id",
          value: groupId,
          updated_at: new Date().toISOString(),
        });
        console.log("Saved LINE group id:", groupId);
      }
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("line-webhook error:", err);
    // ตอบ 200 เสมอ ไม่งั้น LINE จะ retry ส่ง event ซ้ำ
    return new Response("OK", { status: 200 });
  }
});
