import type { Locale } from '../../generated/prisma/client.js';

/**
 * Notification wording lives HERE (backend templates), not in the database. A notification row stores only the
 * template key (`type`) and small safe parameters; the text is rendered in the reader's language when the
 * notification is read or pushed. Changing a template therefore updates old notifications too, and a language
 * can be added without a migration.
 *
 * Parameters are limited to what every recipient of that event may see: the booking reference. Never prices,
 * addresses, phone numbers, names, review notes or payment details.
 */
type Text = { title: string; body: string };
type Template = { ar: Text; en: Text };

export const NOTIFICATION_TEMPLATES = {
  'request.new': {
    en: { title: 'New request', body: 'A new request {ref} matches your services and city.' },
    ar: { title: 'طلب جديد', body: 'وصل طلب جديد {ref} يناسب خدماتك ومدينتك.' },
  },
  // Never the text of the message: it is read in the app, by the person it was written to.
  'chat.message': {
    en: { title: 'New message', body: 'You have a new message about booking {ref}.' },
    ar: { title: 'رسالة جديدة', body: 'لديك رسالة جديدة بخصوص الحجز {ref}.' },
  },
  'quote.received': {
    en: { title: 'New quote received', body: 'You received a quote for booking {ref}.' },
    ar: { title: 'عرض سعر جديد', body: 'وصلك عرض سعر على الحجز {ref}.' },
  },
  'quote.revised': {
    en: { title: 'A quote was updated', body: 'A worker updated their quote for booking {ref}.' },
    ar: { title: 'تم تعديل عرض السعر', body: 'عدّل الفنّي عرض السعر على الحجز {ref}.' },
  },
  'quote.accepted': {
    en: { title: 'Your quote was accepted', body: 'The customer accepted your quote for booking {ref}. Waiting for payment.' },
    ar: { title: 'تم قبول عرضك', body: 'قبل العميل عرضك على الحجز {ref}. بانتظار الدفع.' },
  },
  'quote.rejected': {
    en: { title: 'Your quote was not chosen', body: 'The customer did not choose your quote for booking {ref}.' },
    ar: { title: 'لم يتم اختيار عرضك', body: 'لم يختر العميل عرضك على الحجز {ref}.' },
  },
  'quote.change_requested': {
    en: { title: 'The customer asked for a change', body: 'The customer asked you to change your quote for booking {ref}. Open the request to read it.' },
    ar: { title: 'طلب العميل تعديلاً', body: 'طلب منك العميل تعديل عرضك على الحجز {ref}. افتح الطلب لقراءته.' },
  },
  'payment.confirmed': {
    en: { title: 'Payment confirmed', body: 'Payment for booking {ref} is confirmed.' },
    ar: { title: 'تم تأكيد الدفع', body: 'تم تأكيد الدفع للحجز {ref}.' },
  },
  'work.started': {
    en: { title: 'Work has started', body: 'The worker started work on booking {ref}.' },
    ar: { title: 'بدأ العمل', body: 'بدأ الفنّي العمل على الحجز {ref}.' },
  },
  'work.completed': {
    en: { title: 'Work completed', body: 'The worker finished work on booking {ref}.' },
    ar: { title: 'اكتمل العمل', body: 'أنهى الفنّي العمل على الحجز {ref}.' },
  },
  'booking.cancelled': {
    en: { title: 'Booking cancelled', body: 'Booking {ref} was cancelled.' },
    ar: { title: 'تم إلغاء الحجز', body: 'تم إلغاء الحجز {ref}.' },
  },
  'booking.expired': {
    en: { title: 'Request expired', body: 'Booking {ref} stopped accepting quotes.' },
    ar: { title: 'انتهت صلاحية الطلب', body: 'انتهت مهلة استقبال العروض للحجز {ref}.' },
  },
  // The text of the reply is never in the notification: it is read in the app, after the person is signed in.
  'support.reply': {
    en: { title: 'Support replied', body: 'You have a new reply from support. Open the app to read it.' },
    ar: { title: 'رد من الدعم', body: 'لديك رد جديد من فريق الدعم. افتح التطبيق لقراءته.' },
  },
  // An announcement an administrator wrote: its own text in each language (never personal data), sent to a whole audience.
  'admin.announcement': {
    en: { title: '{titleEn}', body: '{bodyEn}' },
    ar: { title: '{titleAr}', body: '{bodyAr}' },
  },
  'verification.approved': {
    en: { title: 'Your account was approved', body: 'Your verification was approved. You can now receive requests.' },
    ar: { title: 'تمت الموافقة على حسابك', body: 'تمت الموافقة على طلب التحقق الخاص بك. يمكنك الآن استقبال الطلبات.' },
  },
  'verification.rejected': {
    en: { title: 'Verification was not approved', body: 'Your verification request was not approved. Open the app for details.' },
    ar: { title: 'تم رفض طلب التحقق', body: 'لم تتم الموافقة على طلب التحقق. افتح التطبيق لمعرفة التفاصيل.' },
  },
  'verification.info_requested': {
    en: { title: 'More information needed', body: 'The reviewer asked for more information to complete your verification.' },
    ar: { title: 'مطلوب معلومات إضافية', body: 'طلب المراجع معلومات إضافية لإكمال التحقق.' },
  },
  'verification.suspended': {
    en: { title: 'Your account was suspended', body: 'Your worker account was suspended. Open the app for details.' },
    ar: { title: 'تم إيقاف حسابك', body: 'تم إيقاف حسابك كفنّي مؤقتاً. افتح التطبيق لمعرفة التفاصيل.' },
  },
  'verification.reinstated': {
    en: { title: 'Your account was reinstated', body: 'Your worker account is active again.' },
    ar: { title: 'تمت إعادة تفعيل حسابك', body: 'تمت إعادة تفعيل حسابك ويمكنك استقبال الطلبات.' },
  },
} as const satisfies Record<string, Template>;

export type NotificationType = keyof typeof NOTIFICATION_TEMPLATES;

const GENERIC: Template = {
  en: { title: 'Update', body: 'You have a new update.' },
  ar: { title: 'تحديث', body: 'لديك تحديث جديد.' },
};

/** Own keys only: a stored type such as "constructor" or "toString" must not resolve to something inherited. */
export const isNotificationType = (value: string): value is NotificationType => Object.hasOwn(NOTIFICATION_TEMPLATES, value);

/**
 * Renders a stored notification. An unknown `type` (for example one written by a newer deployment) or a missing
 * parameter degrades to a generic message instead of failing; the language is the reader's, defaulting to Arabic
 * like the user preference does.
 */
export function renderNotification(type: string, locale: Locale, params: Record<string, unknown>): Text {
  const template: Template = isNotificationType(type) ? NOTIFICATION_TEMPLATES[type] : GENERIC;
  const text = locale === 'EN' ? template.en : template.ar;
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_m, name: string) => (typeof params[name] === 'string' ? (params[name] as string) : '#'));
  return { title: fill(text.title), body: fill(text.body) };
}
