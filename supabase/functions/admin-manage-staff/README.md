# admin-manage-staff

إدارة طاقم المدرسة من داخل النظام (STEP 54).

## النشر
```bash
supabase functions deploy admin-manage-staff
```

## الإجراءات (POST JSON)

| action | من | الوصف |
|--------|-----|--------|
| `create` | superadmin | إنشاء Auth + profile + دور + كلمة مرور |
| `reset_password` | superadmin / it_officer | كلمة مرور جديدة + must_change_password |
| `deactivate` | superadmin | إيقاف ناعم (السجلات تبقى) |
| `reactivate` | superadmin | إعادة تفعيل |

## مثال create
```json
{
  "action": "create",
  "full_name": "أحمد محمد",
  "email": "ahmed@school.com",
  "role_type": "counselor",
  "password": "Temp1234!x",
  "stage_ids": [],
  "classes": []
}
```
