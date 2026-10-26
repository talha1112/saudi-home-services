import 'package:flutter/widgets.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/localization/app_strings.dart';
import '../../../core/extensions/context_extensions.dart';

/// Text for the application and status screens (English / Arabic). Server-provided reviewer notes are shown as they come.
abstract final class Ob {
  static const stepTitles = [
    Bi('Personal details', 'البيانات الشخصية'),
    Bi('Services & area', 'الخدمات والنطاق'),
    Bi('Availability', 'أوقات العمل'),
    Bi('Verification documents', 'مستندات التحقق'),
  ];

  static const fullName = Bi(
    'Full name (English)',
    'الاسم الكامل (بالإنجليزية)',
  );
  static const fullNameAr = Bi('Full name (Arabic)', 'الاسم الكامل (بالعربية)');
  static const bio = Bi('About you (optional)', 'نبذة عنك (اختياري)');
  static const bioHint = Bi(
    'Skills and experience customers should know about',
    'مهاراتك وخبرتك التي يهم العميل معرفتها',
  );
  static const years = Bi('Years of experience', 'سنوات الخبرة');
  static const yearsHint = Bi('0 to 60', 'من 0 إلى 60');

  static const services = Bi(
    'Which services do you offer?',
    'ما الخدمات التي تقدمها؟',
  );
  static const cities = Bi('Which cities do you work in?', 'في أي المدن تعمل؟');
  static const loadingCatalog = Bi('Loading services…', 'جارٍ تحميل الخدمات…');
  static const retry = Bi('Try again', 'حاول مجدداً');

  static const days = Bi('Working days', 'أيام العمل');
  static const hours = Bi('Working hours', 'ساعات العمل');
  static const from = Bi('From', 'من');
  static const to = Bi('To', 'إلى');

  static const docsIntro = Bi(
    'Upload a clear photo or PDF of your National ID or Iqama. Other documents are optional and can help your review.',
    'ارفع صورة واضحة أو ملف PDF للهوية الوطنية أو الإقامة. المستندات الأخرى اختيارية وقد تسرّع المراجعة.',
  );
  static const docRequiredNote = Bi(
    'One identity document is required',
    'مستند هوية واحد مطلوب',
  );
  static const photoNote = Bi(
    'Required: a clear photo of your face (JPEG or PNG)',
    'مطلوبة: صورة واضحة لوجهك (JPEG أو PNG)',
  );
  static const upload = Bi('Upload', 'رفع');
  static const replace = Bi('Replace', 'استبدال');
  static const remove = Bi('Remove', 'حذف');
  static const uploading = Bi('Uploading…', 'جارٍ الرفع…');
  static const optional = Bi('Optional', 'اختياري');
  static const required = Bi('Required', 'مطلوب');

  static const cont = Bi('Save and continue', 'حفظ ومتابعة');
  static const saving = Bi('Saving…', 'جارٍ الحفظ…');
  static const submit = Bi('Submit for review', 'إرسال للمراجعة');
  static const submitting = Bi('Submitting…', 'جارٍ الإرسال…');
  static const resubmit = Bi('Update and resubmit', 'تحديث وإعادة الإرسال');

  static String docName(DocumentKind kind, bool ar) => switch (kind) {
    DocumentKind.nationalId => ar ? 'الهوية الوطنية' : 'National ID',
    DocumentKind.iqama => ar ? 'الإقامة' : 'Iqama',
    DocumentKind.professionalLicense =>
      ar ? 'الرخصة المهنية' : 'Professional license',
    DocumentKind.certificate => ar ? 'شهادة' : 'Certificate',
    DocumentKind.photo => ar ? 'صورة شخصية' : 'Profile photo',
    DocumentKind.other => ar ? 'مستند آخر' : 'Other document',
  };

  /// What the server reports about a stored document, in plain words. Never says "safe": an unscanned file is only "received".
  static String docState(WorkerDocument d, bool ar) {
    if (d.scanStatus == 'INFECTED') {
      return ar
          ? 'تم رفض الملف. ارفع ملفاً آخر.'
          : 'This file was rejected. Upload a different one.';
    }
    if (d.status == 'REJECTED') {
      return d.reviewNote ?? (ar ? 'تم رفض المستند' : 'Document rejected');
    }
    if (d.status == 'ACCEPTED') return ar ? 'تم قبوله' : 'Accepted';
    if (d.status == 'PENDING_UPLOAD') {
      return ar ? 'لم يكتمل الرفع' : 'Upload not finished';
    }
    return switch (d.scanStatus) {
      'PENDING' => ar ? 'تم الاستلام، جارٍ الفحص' : 'Received, being checked',
      'CLEAN' => ar ? 'تم الاستلام وفُحص' : 'Received and checked',
      'ERROR' =>
        ar
            ? 'تعذّر فحص الملف. جرّب رفعه مجدداً.'
            : 'The check could not finish. Try uploading again.',
      _ => ar ? 'تم الاستلام، بانتظار المراجعة' : 'Received, awaiting review',
    };
  }

  static String missingItem(String code, bool ar) => switch (code) {
    'FULL_NAME' => ar ? 'الاسم الكامل' : 'Full name',
    'YEARS_OF_EXPERIENCE' => ar ? 'سنوات الخبرة' : 'Years of experience',
    'SERVICES' => ar ? 'الخدمات' : 'Services',
    'SERVICE_AREAS' => ar ? 'المدن' : 'Cities',
    'AVAILABILITY' => ar ? 'أوقات العمل' : 'Working hours',
    'IDENTITY_DOCUMENT' => ar ? 'مستند الهوية' : 'Identity document',
    _ => code,
  };

  // ---------------------------------------------------------------- status screen

  static const appStatus = Bi('Application status', 'حالة الطلب');
  static const refresh = Bi('Refresh', 'تحديث');
  static const loadingStatus = Bi(
    'Loading your application…',
    'جارٍ تحميل طلبك…',
  );
  static const reviewerNote = Bi(
    'Message from the review team',
    'رسالة من فريق المراجعة',
  );
  static const history = Bi('History', 'السجل');
  static const goDashboard = Bi('Go to dashboard', 'الذهاب إلى لوحة التحكم');
  static const editApplication = Bi(
    'Review and update my application',
    'مراجعة طلبي وتحديثه',
  );
  static const startApplication = Bi('Complete my application', 'إكمال طلبي');
  static const contactSupport = Bi('Contact support', 'تواصل مع الدعم');
  static const stillMissing = Bi(
    'Still needed before you can submit',
    'مطلوب قبل الإرسال',
  );

  static String stateBadge(VerificationState s, bool ar) => switch (s) {
    VerificationState.notSubmitted => ar ? 'لم يُرسل' : 'Not submitted',
    VerificationState.submitted => ar ? 'تم الإرسال' : 'Submitted',
    VerificationState.underReview => ar ? 'قيد المراجعة' : 'Under review',
    VerificationState.infoRequired =>
      ar ? 'مطلوب معلومات' : 'Information needed',
    VerificationState.approved => ar ? 'معتمد' : 'Approved',
    VerificationState.rejected => ar ? 'مرفوض' : 'Rejected',
    VerificationState.suspended => ar ? 'موقوف' : 'Suspended',
    VerificationState.unknown => ar ? 'غير معروف' : 'Unknown',
  };

  static String stateTitle(VerificationState s, bool ar) => switch (s) {
    VerificationState.notSubmitted =>
      ar ? 'أكمل طلبك' : 'Complete your application',
    VerificationState.submitted =>
      ar ? 'استلمنا طلبك' : 'We received your application',
    VerificationState.underReview =>
      ar ? 'طلبك قيد المراجعة' : 'Your application is being reviewed',
    VerificationState.infoRequired =>
      ar ? 'نحتاج معلومات إضافية' : 'We need a little more information',
    VerificationState.approved => ar ? 'تم اعتماد حسابك' : 'You are approved',
    VerificationState.rejected =>
      ar ? 'لم يتم قبول الطلب' : 'Your application was not accepted',
    VerificationState.suspended =>
      ar ? 'حسابك موقوف' : 'Your account is suspended',
    VerificationState.unknown => ar ? 'حالة غير معروفة' : 'Status unavailable',
  };

  static String stateBody(VerificationState s, bool ar) => switch (s) {
    VerificationState.notSubmitted =>
      ar
          ? 'أرسل طلبك بعد إكمال كل البيانات المطلوبة.'
          : 'Send your application once all the required details are in.',
    VerificationState.submitted =>
      ar
          ? 'سيبدأ فريقنا مراجعته قريباً. سنخبرك بأي تحديث.'
          : 'Our team will start reviewing it soon. We will let you know of any update.',
    VerificationState.underReview =>
      ar
          ? 'عادةً تستغرق المراجعة وقتاً قصيراً. لا يلزمك فعل شيء الآن.'
          : 'Reviews usually take a short while. There is nothing you need to do right now.',
    VerificationState.infoRequired =>
      ar
          ? 'اطلع على رسالة المراجعة أدناه، حدّث طلبك ثم أعد الإرسال.'
          : 'Read the reviewer\'s message below, update your application and send it again.',
    VerificationState.approved =>
      ar
          ? 'يمكنك الآن استقبال طلبات الخدمة وإرسال العروض.'
          : 'You can now receive job requests and send quotes.',
    VerificationState.rejected =>
      ar
          ? 'اطلع على السبب أدناه. يمكنك تعديل طلبك وإعادة إرساله.'
          : 'See the reason below. You can fix your application and send it again.',
    VerificationState.suspended =>
      ar
          ? 'تم إيقاف حسابك مؤقتاً. تواصل مع الدعم لمعرفة التفاصيل.'
          : 'Your account is paused for now. Contact support for details.',
    VerificationState.unknown =>
      ar
          ? 'تعذّر عرض الحالة. حدّث الصفحة بعد قليل.'
          : 'We could not show your status. Refresh in a moment.',
  };
}

/// The localized message for a failed onboarding step. Never contains tokens, addresses or file contents; server field messages are English.
String onboardingMessage(BuildContext context, OnboardingFailure failure) {
  final ar = context.isAr;
  String t(String en, String arText) => ar ? arText : en;
  switch (failure.issue) {
    case OnboardingIssue.network:
      return t(
        'No connection. Check your internet and try again.',
        'لا يوجد اتصال. تحقق من الإنترنت وحاول مجدداً.',
      );
    case OnboardingIssue.sessionExpired:
      return t(
        'Your session has ended. Please sign in again.',
        'انتهت جلستك. سجّل الدخول مجدداً.',
      );
    case OnboardingIssue.storageUnavailable:
      return t(
        'Document upload is not available right now. Nothing was saved. Please try again later.',
        'رفع المستندات غير متاح حالياً. لم يُحفظ شيء. حاول لاحقاً.',
      );
    case OnboardingIssue.validation:
      final details = failure.fieldMessages.isEmpty
          ? ''
          : '\n${failure.fieldMessages.join('\n')}';
      return t(
        'Please check the details you entered.$details',
        'يرجى التحقق من البيانات المدخلة.$details',
      );
    case OnboardingIssue.notAllowed:
      return t(
        'This change is not allowed in the current state of your application.',
        'لا يمكن إجراء هذا التغيير في الحالة الحالية لطلبك.',
      );
    case OnboardingIssue.incomplete:
      final items = failure.missing
          .map((m) => Ob.missingItem(m, ar))
          .join(ar ? '، ' : ', ');
      return t('Still needed: $items.', 'مطلوب: $items.');
    case OnboardingIssue.invalidState:
      return t(
        'Your application cannot be submitted in its current state. We refreshed it.',
        'لا يمكن إرسال طلبك في حالته الحالية. تم تحديث الصفحة.',
      );
    case OnboardingIssue.fileTooLarge:
      return t(
        'The file is too large. The limit is 10 MB.',
        'الملف كبير جداً. الحد الأقصى 10 ميغابايت.',
      );
    case OnboardingIssue.unsupportedFile:
      return t(
        'Only JPG, PNG or PDF files can be uploaded.',
        'يمكن رفع ملفات JPG أو PNG أو PDF فقط.',
      );
    case OnboardingIssue.fileRejected:
      return t(
        'The file was rejected. Upload a clear, unedited JPG, PNG or PDF.',
        'تم رفض الملف. ارفع ملف JPG أو PNG أو PDF واضحاً وغير معدّل.',
      );
    case OnboardingIssue.uploadFailed:
      return t(
        'The upload did not finish. Nothing was saved. Try again.',
        'لم يكتمل الرفع. لم يُحفظ شيء. حاول مجدداً.',
      );
    case OnboardingIssue.documentLimit:
      return t(
        'You have reached the maximum number of documents. Remove one first.',
        'وصلت إلى الحد الأقصى للمستندات. احذف مستنداً أولاً.',
      );
    case OnboardingIssue.tooManyRequests:
      return t(
        'Too many attempts. Please wait a moment and try again.',
        'محاولات كثيرة. انتظر قليلاً وحاول مجدداً.',
      );
    case OnboardingIssue.unavailable:
      return t(
        'The service is temporarily unavailable. Please try again shortly.',
        'الخدمة غير متاحة مؤقتاً. حاول بعد قليل.',
      );
    case OnboardingIssue.generic:
      return t(
        'Something went wrong. Please try again.',
        'حدث خطأ ما. حاول مجدداً.',
      );
  }
}
