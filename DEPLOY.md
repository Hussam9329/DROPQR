# رفع DropQR أونلاين

عندك طريقتين. **Railway أسهل** (بدون سيرفر تديره)، و**VPS أرخص وتتحكم بيه بالكامل**.

> قبل كلشي: ارفع المشروع على GitHub (مستودع Private يكفي):
> ```bash
> git init
> git add .
> git commit -m "DropQR"
> git branch -M main
> git remote add origin https://github.com/Hussam9329/dropqr.git
> git push -u origin main
> ```
> (لازم تسوي المستودع `dropqr` بحسابك على GitHub أول.)
> مجلد `data/` و `node_modules/` ما يترفعن، وهذا مقصود.

---

## الطريقة 1: Railway

1. ادخل https://railway.com وسجّل بحساب GitHub.
2. **New Project → Deploy from GitHub repo** → اختار `dropqr`.
   Railway راح يلگه `Dockerfile` و `railway.json` ويبني لوحده.
3. **أهم خطوة: أضف Volume** حتى الملفات ما تنمسح مع كل تحديث:
   - افتح الخدمة → **Settings** (أو كليك يمين على الخدمة) → **Attach Volume**
   - **Mount path:** `/app/data`
4. **Settings → Networking → Generate Domain** → يطلعلك رابط مثل
   `dropqr-production.up.railway.app`.
   - تكدر تربط دومين خاص بيك من نفس المكان (Custom Domain).
5. افتح الرابط وجرّب ارفع ملف. ✅

**متغيرات اختيارية** (تبويب **Variables**):

| المتغير | متى تحتاجه |
|---|---|
| `MAX_FILE_MB` | تغيّر الحد الأقصى للملف (الافتراضي 500) |
| `BASE_URL` | ما تحتاجه عادةً — الموقع يعرف رابطه لوحده. ضعه بس إذا الروابط طلعت غلط |

**ملاحظات:**
- الـ Volume يحتاج خطة مدفوعة (Hobby). تأكد من حجم التخزين المسموح بخطتك.
- كل `git push` على `main` = تحديث تلقائي للموقع.

---

## الطريقة 2: VPS (Ubuntu)

تحتاج: سيرفر Ubuntu 22.04 أو أحدث (Hetzner، DigitalOcean، Contabo…) + دومين.

### 1) وجّه الدومين للسيرفر
بلوحة الدومين أضف سجل **A**:
`drop.yourdomain.com` → عنوان IP مال السيرفر.

> ⚠️ إذا تستخدم Cloudflare: خلّي السحابة **رمادية (DNS only)**.
> البروكسي المجاني مال Cloudflare يرفض أي رفع أكبر من 100MB.

### 2) ادخل السيرفر ونصّب Docker
```bash
ssh root@SERVER_IP
```
```bash
curl -fsSL https://get.docker.com | sh
```

### 3) نزّل المشروع وشغّله
```bash
git clone https://github.com/Hussam9329/dropqr.git
cd dropqr
cp .env.example .env
nano .env
```
عدّل `DOMAIN=drop.yourdomain.com` واحفظ (Ctrl+O ثم Enter ثم Ctrl+X).

```bash
docker compose up -d --build
```

خلال دقيقة يشتغل على `https://drop.yourdomain.com`.
Caddy يجيب شهادة HTTPS مجانية ويجددها لوحده.

### 4) أوامر مفيدة
| الأمر | شنو يسوي |
|---|---|
| `docker compose logs -f app` | تشوف سجل الموقع |
| `docker compose ps` | تتأكد إنه شغّال |
| `git pull && docker compose up -d --build` | تحدّث الموقع بعد أي تعديل |
| `docker compose down` | توكّفه (الملفات تبقى محفوظة) |

### 5) الجدار الناري (إذا مفعّل)
```bash
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable
```

---

## إذا صارت مشكلة

| المشكلة | الحل |
|---|---|
| Railway: الملفات تختفي بعد كل تحديث | ما ضفت Volume على `/app/data` |
| رابط الـ QR يطلع `http://` بدل `https://` | ضيف متغير `BASE_URL=https://دومينك` |
| رفع الملفات الكبيرة يفشل | Cloudflare proxy مفعّل، أو زِد `MAX_FILE_MB` |
| VPS: الموقع ما يفتح | تأكد سجل A يأشر على IP الصحيح وإن البورتات 80 و 443 مفتوحة |
