# admin-reset-password

إعادة تعيين كلمة مرور مستخدم بواسطة **المسؤول العام (superadmin)** أو **مسؤول الحاسب (it_officer)**.

## الصلاحيات
- `superadmin`: يمكنه إعادة تعيين أي مستخدم في أي مدرسة.
- `it_officer`: يمكنه إعادة تعيين المستخدمين في مدرسته فقط، ولا يمكنه إعادة تعيين `superadmin`.

## النشر
```bash
supabase functions deploy admin-reset-password