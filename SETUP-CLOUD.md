# BuildTrack — คู่มือตั้งค่า Cloud (Supabase Auth + Database + Storage)

ทำครั้งเดียว ประมาณ 20 นาที

> **ก่อนเริ่ม:** แอปใช้งานได้ทันทีโดยไม่ต้องตั้งค่าอะไรเลย (โหมด Local — ล็อกอินด้วย `admin` / `123456`)
> ตั้งค่า Cloud เมื่อต้องการให้ทีมหลายคนใช้ข้อมูลชุดเดียวกัน และเก็บรูปบน Cloud

---

## 1. สร้างโปรเจกต์ Supabase

1. สมัคร/เข้าสู่ระบบที่ https://supabase.com
2. **New Project** → ชื่อ `buildtrack` → Region **Southeast Asia (Singapore)**
3. ตั้งรหัสผ่าน Database → Create (รอ ~2 นาที)

---

## 2. รัน SQL ตั้งค่าฐานข้อมูลและสิทธิ์

ไปที่ **SQL Editor** → **New query** → วางทั้งหมดนี้แล้วกด **Run**

```sql
-- ========================================
-- 1) ตาราง profiles : เก็บชื่อและสิทธิ์ของผู้ใช้แต่ละคน
-- ========================================
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  role       text not null default 'VIEWER'
             check (role in ('ADMIN','FOREMAN','VIEWER')),
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

-- ผู้ล็อกอินอ่าน profile ได้ทุกคน (ใช้แสดงชื่อผู้บันทึกงาน)
create policy "profiles read for authenticated"
  on public.profiles for select
  to authenticated using (true);

-- แก้ไขได้เฉพาะ profile ของตัวเอง และห้ามเปลี่ยน role ตัวเอง
create policy "profiles update own"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id and role = (select role from public.profiles where id = auth.uid()));

-- ฟังก์ชันเช็คว่าเป็น ADMIN หรือไม่ (security definer เพื่อเลี่ยง recursion ใน policy)
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'ADMIN');
$$;

-- ADMIN จัดการ profile คนอื่นได้
create policy "profiles admin all"
  on public.profiles for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- สร้าง profile อัตโนมัติทุกครั้งที่มีผู้ใช้ใหม่สมัคร
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
    coalesce(new.raw_user_meta_data->>'role', 'VIEWER')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ========================================
-- 2) ตารางข้อมูลจริง — แยกแถวต่อรายการ
--    (เวอร์ชันเก่าเก็บทุกอย่างในแถวเดียว ทำให้บันทึกพร้อมกันแล้วทับกัน)
-- ========================================

-- ฟังก์ชันเช็คว่าเป็นทีมงานที่แก้ไขข้อมูลได้
create or replace function public.is_staff()
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('ADMIN','FOREMAN')
  );
$$;

create table if not exists public.projects (
  id         text primary key,
  name       text not null,
  location   text,
  start_date date,
  end_date   date,
  site_plan  text,
  units      jsonb default '[]'::jsonb,
  updated_at timestamptz default now()
);

create table if not exists public.sequence_records (
  id              text primary key,
  project_id      text,
  unit_id         text,
  seq_index       int,
  seq_name        text,
  sub_task        text,
  status          text,
  approval_status text,
  record_date     date,
  recorded_by     text,
  approved_by     text,
  approved_date   date,
  remark          text,
  photos          jsonb default '[]'::jsonb,
  updated_at      timestamptz default now()
);

create table if not exists public.issues (
  id            text primary key,
  project_id    text,
  unit_id       text,
  title         text,
  report_date   date,
  assigned_to   text,
  status        text,
  resolved_date date,
  photo_before  text,
  photo_after   text,
  updated_at    timestamptz default now()
);

create table if not exists public.procurements (
  id             text primary key,
  project_id     text,
  unit_id        text,
  name           text,
  lead_days      int default 0,
  order_due_date date,
  required_date  date,
  status         text,
  remark         text,
  updated_at     timestamptz default now()
);

create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz default now()
);

-- ดัชนีช่วยให้ค้นหาเร็วเมื่อข้อมูลเยอะ
create index if not exists idx_records_project on public.sequence_records(project_id, unit_id);
create index if not exists idx_records_approval on public.sequence_records(approval_status);
create index if not exists idx_issues_project on public.issues(project_id, unit_id);
create index if not exists idx_proc_project on public.procurements(project_id, unit_id);

-- เปิด RLS + กำหนดสิทธิ์เหมือนกันทุกตาราง:
-- อ่าน = ผู้ล็อกอินทุกคน / เขียน-แก้ = ADMIN+FOREMAN / ลบ = ADMIN
do $$
declare t text;
begin
  foreach t in array array['projects','sequence_records','issues','procurements','app_settings']
  loop
    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists "%s read"   on public.%I', t, t);
    execute format('drop policy if exists "%s insert" on public.%I', t, t);
    execute format('drop policy if exists "%s update" on public.%I', t, t);
    execute format('drop policy if exists "%s delete" on public.%I', t, t);

    execute format($f$create policy "%s read" on public.%I
      for select to authenticated using (true)$f$, t, t);

    execute format($f$create policy "%s insert" on public.%I
      for insert to authenticated with check (public.is_staff())$f$, t, t);

    execute format($f$create policy "%s update" on public.%I
      for update to authenticated using (public.is_staff()) with check (public.is_staff())$f$, t, t);

    execute format($f$create policy "%s delete" on public.%I
      for delete to authenticated using (public.is_admin())$f$, t, t);
  end loop;
end $$;

-- เปิด Realtime เพื่อให้ทุกเครื่องเห็นการเปลี่ยนแปลงทันที
alter publication supabase_realtime add table public.projects;
alter publication supabase_realtime add table public.sequence_records;
alter publication supabase_realtime add table public.issues;
alter publication supabase_realtime add table public.procurements;
alter publication supabase_realtime add table public.app_settings;
```

> ถ้าบรรทัด `alter publication` แจ้ง `already member of publication` ไม่เป็นไร ข้ามได้เลย

<details>
<summary><b>ถ้าเคยใช้เวอร์ชันเก่า (ตาราง buildtrack_store) — กดดูขั้นตอนย้ายข้อมูล</b></summary>

รัน SQL นี้เพิ่มเพื่อให้อ่านข้อมูลเดิมได้ (ถ้ายังไม่มีตารางนี้อยู่แล้ว ข้ามไป):

```sql
alter table public.buildtrack_store enable row level security;
drop policy if exists "buildtrack read" on public.buildtrack_store;
create policy "legacy read" on public.buildtrack_store
  for select to authenticated using (true);
```

จากนั้นในแอป: **ตั้งค่า Cloud Database** → กดปุ่มม่วง **ย้ายข้อมูลไปตารางจริง**

ระบบจะอ่านข้อมูลจาก `buildtrack_store` แล้วเขียนกระจายลงตารางใหม่ให้เอง เมื่อเสร็จแล้วลบตารางเก่าทิ้งได้:

```sql
drop table if exists public.buildtrack_store;
```

</details>

---

## 3. สร้าง Bucket เก็บรูปภาพ

1. **Storage** → **New bucket** → ชื่อ `buildtrack-photos`
2. ติ๊ก **Public bucket** ✅ (ให้ `<img>` แสดงรูปได้โดยตรง)
3. Create

จากนั้นรัน SQL นี้เพื่อกำหนดสิทธิ์อัปโหลด:

```sql
-- ล้าง policy เดิมที่เปิดกว้าง (ถ้าเคยรันไว้)
drop policy if exists "photos public read" on storage.objects;
drop policy if exists "photos anon upload" on storage.objects;

-- ใครก็เปิดดูรูปได้ (จำเป็นสำหรับ public bucket)
create policy "photos public read"
  on storage.objects for select
  using (bucket_id = 'buildtrack-photos');

-- อัปโหลดได้เฉพาะ ADMIN / FOREMAN ที่ล็อกอินแล้ว
create policy "photos staff upload"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'buildtrack-photos'
    and exists (
      select 1 from public.profiles
      where id = auth.uid() and role in ('ADMIN','FOREMAN')
    )
  );

-- ลบรูปได้เฉพาะ ADMIN
create policy "photos admin delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'buildtrack-photos' and public.is_admin());
```

---

## 4. สร้างบัญชีผู้ใช้

ไปที่ **Authentication** → **Users** → **Add user** → **Create new user**

สร้างให้ครบตามทีมงาน (ติ๊ก **Auto Confirm User** ✅ เพื่อไม่ต้องยืนยันอีเมล):

| อีเมล | ชื่อ | สิทธิ์ |
|---|---|---|
| witthawat51@hotmail.com | Witthawat | ADMIN |
| siraprapa@... | siraprapa | FOREMAN |
| nanthana@... | nanthana | FOREMAN |
| theerapong@... | theerapong | FOREMAN |

จากนั้นกำหนดชื่อและสิทธิ์ใน **SQL Editor** (แก้อีเมลให้ตรงกับที่สร้างจริง):

```sql
update public.profiles set full_name = 'Witthawat',  role = 'ADMIN'
  where email = 'witthawat51@hotmail.com';

update public.profiles set full_name = 'siraprapa',  role = 'FOREMAN'
  where email = 'siraprapa@example.com';

update public.profiles set full_name = 'nanthana',   role = 'FOREMAN'
  where email = 'nanthana@example.com';

update public.profiles set full_name = 'theerapong', role = 'FOREMAN'
  where email = 'theerapong@example.com';

-- ตรวจผลลัพธ์
select email, full_name, role from public.profiles order by role;
```

> ⚠️ **สำคัญ:** ต้องมีอย่างน้อย 1 คนเป็น ADMIN ไม่งั้นจะไม่มีใครแก้ไขข้อมูลได้

### เพิ่มคนใหม่ทีหลัง

Authentication → Add user → แล้วรัน:

```sql
update public.profiles set full_name = 'ชื่อจริง', role = 'FOREMAN'
  where email = 'อีเมลใหม่@example.com';
```

---

## 5. เชื่อมต่อแอปกับ Supabase

1. **Project Settings** → **API** → คัดลอก **Project URL** และ **anon public** key
2. เปิดแอป → เมนู **ตั้งค่า Cloud Database** (หรือลิงก์ "ตั้งค่าการเชื่อมต่อ Cloud" ใต้หน้าล็อกอิน)
3. กรอก URL, Anon Key, Bucket = `buildtrack-photos` → **บันทึกและทดสอบการเชื่อมต่อ**
4. แอปจะเปลี่ยนเป็นโหมด Cloud และให้ล็อกอินใหม่ **ด้วยอีเมล** ที่สร้างไว้ในขั้นตอน 4

หน้าล็อกอินจะขึ้น 🛡️ **โหมด Cloud (Supabase Auth — รหัสผ่านเข้ารหัส)** เป็นสีเขียว

---

## 6. ย้ายรูปเก่าขึ้น Cloud (ถ้ามี)

ตั้งค่า Cloud → กด **เริ่มย้ายรูปขึ้น Cloud**

รูป base64 ที่ฝังในข้อมูลจะถูกอัปขึ้น Bucket แล้วแทนที่ด้วยลิงก์ URL

> ข้อมูลชุดที่มากับไฟล์นี้ **ลบรูปฝังออกหมดแล้ว** (15 รูป / 8.4 MB) จึงไม่ต้องย้าย

---

## สรุปสิทธิ์แต่ละ Role

| ความสามารถ | ADMIN | FOREMAN | VIEWER |
|---|:---:|:---:|:---:|
| ดูข้อมูลทั้งหมด | ✅ | ✅ | ✅ |
| บันทึกงาน / อัปโหลดรูป | ✅ | ✅ | ❌ |
| อนุมัติงาน (Approval) | ✅ | ❌ | ❌ |
| สร้าง/แก้โครงการ, ตั้งค่า Master | ✅ | ❌ | ❌ |
| Export/Import, ตั้งค่า Cloud | ✅ | ❌ | ❌ |
| ลบรูปบน Storage | ✅ | ❌ | ❌ |

สิทธิ์บังคับ **2 ชั้น** — ซ่อนปุ่มในหน้าเว็บ (UX) และ RLS ที่ฝั่ง Supabase (ของจริง กันคนแก้ผ่าน DevTools ได้)

---

## โหมด Local (ไม่ตั้งค่า Cloud)

แอปยังใช้ได้ครบทุกฟีเจอร์ เพียงแต่:

- ล็อกอินด้วยบัญชีในเครื่อง (`admin` / `123456`) — **รหัสผ่านเป็น plain text ใน localStorage**
- ข้อมูลอยู่แค่เบราว์เซอร์เครื่องนั้น เครื่องอื่นมองไม่เห็น
- รูปเก็บเป็น base64 → เบราว์เซอร์มีเพดาน 5–10 MB จะเต็มเร็ว

เหมาะกับทดลองใช้/หน้างานที่ไม่มีเน็ตเท่านั้น **ไม่แนะนำสำหรับใช้งานจริง**

---

## โควตาฟรีของ Supabase

- Storage 1 GB → รูปบีบอัดแล้ว (~200 KB/รูป) ประมาณ **5,000 รูป**
- Database 500 MB · Bandwidth 5 GB/เดือน · ผู้ใช้ Auth 50,000 คน/เดือน

---

## แก้ปัญหาที่พบบ่อย

### 🔑 เข้าโปรแกรมไม่ได้ / ล็อกอินไม่ผ่าน

หน้าล็อกอินขึ้นว่าต้องใช้ **อีเมล** แต่ยังไม่ได้สร้างบัญชีบน Supabase — ในกล่องสีเหลืองใต้ปุ่มเข้าสู่ระบบมี 2 ทางออก:

1. **เข้าสู่ระบบด้วยบัญชีในเครื่อง** → กลับไปใช้ `admin` / `123456` ได้ทันที
2. **ล้างการตั้งค่า Cloud ทั้งหมด** → ลบ URL/Key ออกจากเครื่อง กลับเป็นโหมด Local สมบูรณ์ (ข้อมูลงานไม่หาย)

ระบบยังมีทางสำรองอัตโนมัติ: ถ้ากรอก Username/รหัสที่ตรงกับบัญชีในเครื่อง แม้จะอยู่โหมด Cloud ก็เข้าได้เลย รวมถึงตอนเน็ตหลุดหรือ Supabase ล่ม

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| `Invalid login credentials` | อีเมล/รหัสผิด หรือยังไม่ได้สร้างใน Authentication → Users — หรือกดปุ่มสีเหลืองใช้บัญชีในเครื่อง |
| `Email not confirmed` | ตอนสร้าง user ไม่ได้ติ๊ก Auto Confirm — แก้ที่ user นั้น กด Confirm email |
| ล็อกอินได้แต่ปุ่มแก้ไขหายหมด | profile ยังเป็น VIEWER — รัน `update public.profiles set role='ADMIN' where email='...'` |
| บันทึกแล้วขึ้น "ซิงค์ Cloud ไม่สำเร็จ" | role เป็น VIEWER (เขียนไม่ได้) หรือยังไม่ได้รัน SQL ขั้นตอน 2 |
| อัปโหลดรูปไม่ขึ้น รูปกลายเป็น base64 | Bucket ยังไม่ได้สร้าง / ไม่ได้ตั้ง Public / ยังไม่ได้รัน SQL ขั้นตอน 3 |
| รูปอัปได้แต่แสดงไม่ขึ้น | Bucket ไม่ได้ตั้งเป็น Public |

---

## การทำงานพร้อมกันหลายคน

ระบบเก็บข้อมูล **แยกแถวต่อรายการ** และซิงค์แบบ **ส่งเฉพาะแถวที่เปลี่ยน** (diff-based)

- โฟร์แมน A บันทึก Block A / โฟร์แมน B บันทึก Block B พร้อมกัน → **ได้ทั้งคู่ ไม่ทับกัน**
- เปิด **Realtime** ไว้ อีกเครื่องจะเห็นงานที่เพิ่งบันทึกภายในไม่กี่วินาทีโดยไม่ต้องรีเฟรช
- เน็ตหลุดกลางคัน → ข้อมูลเก็บในเครื่องไว้ก่อน พอเน็ตกลับมาจะส่งส่วนที่ค้างขึ้นเองอัตโนมัติ

**ยังทับกันได้ในกรณีเดียว:** 2 คนแก้ **รายการเดียวกัน** (record ID เดียวกัน) พร้อมกันจริง ๆ — คนที่กดบันทึกทีหลังชนะ ในทางปฏิบัติแทบไม่เกิด เพราะแต่ละคนบันทึกคนละแปลงบ้าน

---

## ข้อจำกัดที่ยังเหลืออยู่

- **โหลดข้อมูลทั้งหมดมาไว้ในเครื่อง** — ที่ 205 บันทึกยังเร็วมาก แต่ถ้าโตเกินหลักหมื่นแถวควรเปลี่ยนเป็นโหลดเฉพาะโครงการที่เลือก
- **แก้รายการเดียวกันพร้อมกัน** ยังเป็น last-write-wins (ดูด้านบน)
- **Realtime ดึงข้อมูลใหม่ทั้งชุด** เมื่อมีคนแก้ ไม่ได้อัปเดตเฉพาะแถวนั้น — ง่ายและถูกต้อง แต่เปลืองแบนด์วิดท์กว่าเมื่อข้อมูลโตมาก
