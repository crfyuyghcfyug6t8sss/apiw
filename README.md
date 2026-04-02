# WhatsApp SaaS Gateway v2.0

بوابة واتساب متعددة المستأجرين — كل شركة بإمكانها ربط أرقام متعددة مع توزيع تلقائي (round-robin) وتحويل تلقائي عند الانقطاع (failover).

---

## الإعداد السريع

```bash
npm install
ADMIN_TOKEN=your_secret_here node server.js
```

---

## المتغيرات البيئية

| المتغير | الوصف | مثال |
|---|---|---|
| `PORT` | منفذ السيرفر | `5000` |
| `ADMIN_TOKEN` | كلمة سر الأدمن | `super_secret_123` |

---

## هيكل قاعدة البيانات (SQLite)

```
clients     — الشركات العملاء (name, email, api_key, plan, monthly_limit)
numbers     — أرقام واتساب لكل شركة (many-to-one → clients)
usage_log   — سجل كل رسالة مرسلة
```

---

## API للشركات العملاء

كل طلب يحتاج: `X-Api-Key: wsa_...`

### فحص الحالة وأرقامي

```http
GET /api/status
```

**Response:**
```json
{
  "success": true,
  "client": "شركة الأمل",
  "numbers": [
    { "id": "abc123", "label": "خط 1", "status": "connected", "hasQR": false },
    { "id": "def456", "label": "خط 2", "status": "waiting_qr", "hasQR": true }
  ]
}
```

---

### جلب QR لرقم معين

```http
GET /api/qr/:numberId
```

**Response (عندو QR):**
```json
{ "qr": "data:image/png;base64,..." }
```

---

### إرسال رسالة (round-robin تلقائي)

```http
POST /api/send
Content-Type: application/json

{
  "phone": "970599123456",
  "message": "مرحبا!"
}
```

بيختار تلقائياً أفضل رقم متصل ويطبق round-robin.

**أو — تحديد رقم بعينه:**
```json
{
  "phone": "970599123456",
  "message": "مرحبا!",
  "numberId": "abc123"
}
```

**Response:**
```json
{
  "success": true,
  "usedNumber": "abc123",
  "label": "خط 1",
  "remainingMessages": 487
}
```

**لو صار failover:**
```json
{
  "success": true,
  "usedNumber": "def456",
  "label": "خط 2",
  "failover": true,
  "remainingMessages": 486
}
```

---

### إرسال جماعي (bulk)

```http
POST /api/send/bulk
Content-Type: application/json

{
  "message": "رسالة موحدة",
  "targets": [
    { "phone": "970599111111" },
    { "phone": "970599222222", "message": "رسالة مخصصة" },
    { "phone": "970599333333" }
  ]
}
```

الحد: 100 رسالة في الطلب الواحد. تأخير 1 ثانية بين كل رسالة.

---

### إضافة رقم جديد

```http
POST /api/numbers
Content-Type: application/json

{ "label": "خط المبيعات" }
```

بيرجع `numberId`، بعدين اجلب QR من `/api/qr/:numberId`.

---

### حذف رقم

```http
DELETE /api/numbers/:numberId
```

---

### إعادة ربط رقم (QR جديد)

```http
POST /api/numbers/:numberId/reconnect
```

---

### إحصائيات الاستخدام

```http
GET /api/usage
```

```json
{
  "plan": "pro",
  "monthlyLimit": 5000,
  "thisMonth": { "total": 340, "sent": 335, "failed": 5 },
  "perNumber": [...]
}
```

---

## Webhook Events

لما تضيف `webhook_url` للعميل، السيرفر بيرسل POST لهاد العنوان عند كل حدث:

| الحدث | الوصف |
|---|---|
| `number_connected` | رقم اتصل بنجاح |
| `number_disconnected` | رقم انقطع |
| `number_failed` | رقم فشل بعد كل المحاولات |
| `failover_used` | تم استخدام رقم بديل |

**مثال payload:**
```json
{
  "event": "failover_used",
  "clientId": "abc123",
  "primaryNumber": "num1",
  "fallbackNumber": "num2",
  "reason": "Error: ...",
  "timestamp": "2025-01-01T12:00:00Z"
}
```

---

## Admin API

كل طلب يحتاج: `X-Admin-Token: your_secret`

### إنشاء عميل جديد

```http
POST /admin/clients
Content-Type: application/json

{
  "name": "شركة الأمل",
  "email": "info@alamal.com",
  "plan": "pro",
  "monthlyLimit": 5000,
  "webhookUrl": "https://alamal.com/webhooks/whatsapp"
}
```

**Plans:** `starter` (500/شهر) · `pro` (5000/شهر) · `enterprise` (غير محدود)

**Response:**
```json
{
  "success": true,
  "clientId": "a1b2c3d4",
  "apiKey": "wsa_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "plan": "pro",
  "monthlyLimit": 5000
}
```

---

### جميع العملاء

```http
GET /admin/clients
```

---

### تحديث عميل

```http
PUT /admin/clients/:id
Content-Type: application/json

{ "plan": "enterprise", "monthlyLimit": 999999, "isActive": 1 }
```

---

### حذف عميل (مع قطع كل جلساته)

```http
DELETE /admin/clients/:id
```

---

### إضافة رقم لعميل من الأدمن

```http
POST /admin/clients/:clientId/numbers
Content-Type: application/json

{ "label": "خط الدعم" }
```

---

## منطق Round-Robin + Failover

```
طلب إرسال للشركة X
        ↓
جيب كل أرقام X المتصلة (status = connected)
        ↓
اختار الأقل rr_index (الأقل استخداماً هالدورة)
        ↓
حاول الإرسال
    ├── نجح → رفع rr_index + تسجيل success
    └── فشل → جرب الرقم الثاني (failover)
                 ├── نجح → رفع rr_index + تسجيل success_failover + webhook إشعار
                 └── فشل → error للشركة
```

---

## دالة PHP للاستخدام

```php
function sendWhatsApp(string $phone, string $message, string $apiKey, string $baseUrl, ?string $numberId = null): array {
    $body = ['phone' => $phone, 'message' => $message];
    if ($numberId) $body['numberId'] = $numberId;

    $ch = curl_init($baseUrl . '/api/send');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode($body),
        CURLOPT_HTTPHEADER     => [
            'Content-Type: application/json',
            'X-Api-Key: ' . $apiKey,
        ],
        CURLOPT_TIMEOUT => 15,
    ]);
    $result = json_decode(curl_exec($ch), true);
    curl_close($ch);
    return $result ?? ['success' => false, 'error' => 'Connection failed'];
}

// الاستخدام
$res = sendWhatsApp('970599123456', 'مرحبا!', 'wsa_xxx...', 'https://your-server.com');
if ($res['success']) {
    echo "أُرسلت من: " . $res['label'];
    if ($res['failover'] ?? false) echo " (تم استخدام رقم بديل)";
}
```
