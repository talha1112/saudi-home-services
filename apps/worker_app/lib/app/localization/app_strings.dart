/// A bilingual string. English first, Arabic second.
class Bi {
  const Bi(this.en, this.ar);
  final String en;
  final String ar;

  String of(bool arabic) => arabic ? ar : en;
}

/// UI copy keyed by name. Look up with `context.tr('key')`.
const Map<String, Bi> kStrings = {
  'brandW': Bi('Home Services Pro', 'خدمات المنزل للفنيين'),
  'wWelcome': Bi(
    'Grow your work with verified jobs near you',
    'نمِّ عملك بطلبات موثوقة بالقرب منك',
  ),
  'mobile': Bi('Mobile number', 'رقم الجوال'),
  'wPhoneHint': Bi(
    'Use the number registered to your ID or Iqama',
    'استخدم الرقم المسجل باسمك في الهوية أو الإقامة',
  ),
  'sendCode': Bi('Send code', 'إرسال الرمز'),
  'wTerms': Bi(
    'By continuing you agree to the Provider Terms and Privacy Policy',
    'بالمتابعة توافق على شروط مقدمي الخدمة وسياسة الخصوصية',
  ),
  'otpSending': Bi('Sending…', 'جارٍ الإرسال…'),
  'otpVerifying': Bi('Verifying…', 'جارٍ التحقق…'),
  'resendCode': Bi('Resend code', 'إعادة إرسال الرمز'),
  'authInvalidPhone': Bi(
    'Enter a valid mobile number.',
    'أدخل رقم جوال صحيحاً.',
  ),
  'authInvalidCode': Bi(
    'That code is not correct. Check the SMS and try again.',
    'الرمز غير صحيح. تحقق من الرسالة وحاول مجدداً.',
  ),
  'authCodeExpired': Bi(
    'This code has expired. Request a new one.',
    'انتهت صلاحية الرمز. اطلب رمزاً جديداً.',
  ),
  'authTooMany': Bi(
    'Too many attempts. Please wait a while and try again.',
    'محاولات كثيرة. انتظر قليلاً ثم حاول مجدداً.',
  ),
  'authNetwork': Bi(
    'No connection. Check your internet and try again.',
    'لا يوجد اتصال. تحقق من الإنترنت وحاول مجدداً.',
  ),
  'authUnavailable': Bi(
    'Sign-in is temporarily unavailable. Please try again shortly.',
    'تسجيل الدخول غير متاح مؤقتاً. حاول بعد قليل.',
  ),
  'authSuspended': Bi(
    'This account has been suspended. Contact support.',
    'تم إيقاف هذا الحساب. تواصل مع الدعم.',
  ),
  'authDeactivated': Bi(
    'This account has been deactivated. Contact support.',
    'تم إلغاء تفعيل هذا الحساب. تواصل مع الدعم.',
  ),
  'authReview': Bi(
    'This number is linked to an account that needs a manual check. Contact support.',
    'هذا الرقم مرتبط بحساب يحتاج إلى مراجعة. تواصل مع الدعم.',
  ),
  'authNotEligible': Bi(
    'This number cannot be used to sign in here.',
    'لا يمكن استخدام هذا الرقم لتسجيل الدخول هنا.',
  ),
  'authVerifyFailed': Bi(
    'We could not verify your number. Please start again.',
    'تعذر التحقق من رقمك. ابدأ من جديد.',
  ),
  'authAppNotAuthorized': Bi(
    'This version of the app is not set up for phone sign-in yet.',
    'هذا الإصدار من التطبيق غير مهيأ لتسجيل الدخول بالجوال بعد.',
  ),
  'authGeneric': Bi(
    'Something went wrong. Please try again.',
    'حدث خطأ ما. حاول مجدداً.',
  ),
  'otpTitle': Bi('Enter the code', 'أدخل رمز التحقق'),
  'otpSub': Bi(
    'We sent a 6-digit code by SMS to',
    'أرسلنا رمزاً من 6 أرقام برسالة نصية إلى',
  ),
  'otpHint': Bi(
    'Enter the code from the SMS. It can take a minute to arrive.',
    'أدخل الرمز من الرسالة النصية. قد يستغرق وصوله دقيقة.',
  ),
  'photo': Bi('Profile photo', 'الصورة الشخصية'),
  'photoSub': Bi(
    'Clear, front-facing, no sunglasses. Customers see this.',
    'واضحة ومن الأمام وبدون نظارات شمسية. يراها العملاء.',
  ),
  'servicesQ': Bi('Which services do you offer?', 'ما الخدمات التي تقدمها؟'),
  'city': Bi('City', 'المدينة'),
  'districts': Bi('Districts you cover', 'الأحياء التي تغطيها'),
  'experience': Bi('Years of experience', 'سنوات الخبرة'),
  'workDays': Bi('Working days', 'أيام العمل'),
  'hours': Bi('Working hours', 'ساعات العمل'),
  'from': Bi('From', 'من'),
  'to': Bi('To', 'إلى'),
  'urgentJobs': Bi('Accept urgent jobs', 'قبول الطلبات العاجلة'),
  'urgentJobsSub': Bi(
    'Get “As soon as possible” requests while you’re online',
    'استقبل طلبات “في أقرب وقت” أثناء اتصالك',
  ),
  'docsSub': Bi(
    'We check every document before you can receive jobs. Review usually takes 1–2 business days.',
    'نراجع كل المستندات قبل أن تستقبل الطلبات. تستغرق المراجعة عادة 1–2 يوم عمل.',
  ),
  'docsPrivacy': Bi(
    'Documents are encrypted and only seen by the verification team.',
    'المستندات مشفرة ولا يطلع عليها إلا فريق التحقق.',
  ),
  'appStatus': Bi('Application status', 'حالة الطلب'),
  'infoNeededT': Bi('What we need from you', 'المطلوب منك'),
  'infoNeededD': Bi(
    'Your professional certificate photo is blurry. Upload a clear photo of the full page.',
    'صورة الشهادة المهنية غير واضحة. ارفع صورة واضحة للصفحة كاملة.',
  ),
  'uploadAgain': Bi('Upload certificate again', 'إعادة رفع الشهادة'),
  'goDashboard': Bi('Go to dashboard', 'الانتقال للوحة التحكم'),
  'contactSupport': Bi('Contact support', 'تواصل مع الدعم'),
  'demoStates': Bi('Demo: verification states', 'تجربة: حالات التحقق'),
  'hello': Bi('Good evening', 'مساء الخير'),
  'newRequests': Bi('New requests', 'طلبات جديدة'),
  'seeAll': Bi('See all', 'عرض الكل'),
  'reviewQuote': Bi('Review & quote', 'مراجعة وتسعير'),
  'decline': Bi('Decline', 'رفض'),
  'todaySchedule': Bi('Today’s schedule', 'جدول اليوم'),
  'jobs': Bi('Jobs', 'المهام'),
  'dateTime': Bi('Date & time', 'الموعد'),
  'noJobs': Bi('Nothing here yet', 'لا يوجد شيء هنا بعد'),
  'noJobsSub': Bi(
    'Jobs in this state will show up here.',
    'ستظهر هنا المهام بهذه الحالة.',
  ),
  'newRequest': Bi('New request', 'طلب جديد'),
  'schedule': Bi('Schedule', 'الموعد'),
  'location': Bi('Location', 'الموقع'),
  'custSince': Bi(
    'Customer since 2025 · 12 bookings',
    'عميلة منذ 2025 · 12 حجزاً',
  ),
  'issue': Bi('Customer’s description', 'وصف العميل'),
  'minCharge': Bi('Minimum service charge', 'الحد الأدنى لرسوم الخدمة'),
  'minChargeW': Bi(
    'Paid by the customer to confirm. It’s part of your quote and yours even if they decline the work after your visit.',
    'يدفعه العميل للتأكيد، وهو جزء من عرضك ويُحتسب لك حتى لو رفض العميل العمل بعد زيارتك.',
  ),
  'submitQuote': Bi('Submit quote', 'إرسال العرض'),
  'minFixed': Bi(
    'Set by the platform, included in your quote',
    'تحدده المنصة ومشمول في عرضك',
  ),
  'sar': Bi('SAR', 'ر.س'),
  'notesCust': Bi('Note to customer', 'ملاحظة للعميل'),
  'validity': Bi('Quote valid for', 'صلاحية العرض'),
  'custPays': Bi('Customer pays (before VAT)', 'يدفع العميل (قبل الضريبة)'),
  'youEarn': Bi('You earn', 'صافي ربحك'),
  'vatNote': Bi(
    '15% VAT is added to the customer’s bill and handled by the platform.',
    'تُضاف ضريبة 15% إلى فاتورة العميل وتتولاها المنصة.',
  ),
  'quoteStatus': Bi('Quote status', 'حالة العرض'),
  'editQuote': Bi('Edit quote', 'تعديل العرض'),
  'withdraw': Bi('Withdraw', 'سحب العرض'),
  'demoCustomer': Bi('Demo: customer’s response', 'تجربة: رد العميل'),
  'custAccepts': Bi('Customer accepts', 'العميل يقبل'),
  'custRejects': Bi('Customer rejects', 'العميل يرفض'),
  'startJob': Bi('Go to job', 'الذهاب للمهمة'),
  'navigate': Bi('Navigate', 'الملاحة'),
  'navFailed': Bi(
    'Could not open Maps. Check that a maps app or browser is available.',
    'تعذّر فتح الخرائط. تأكد من توفر تطبيق خرائط أو متصفح.',
  ),
  'navNoLocation': Bi(
    'The exact location is not available for this job yet.',
    'الموقع الدقيق غير متاح لهذه المهمة بعد.',
  ),
  'eta': Bi('ETA', 'الوصول'),
  'agreedPrice': Bi('Agreed price', 'السعر المتفق'),
  'jobDoneT': Bi('Job completed', 'اكتملت المهمة'),
  'typeMsg': Bi('Type a message', 'اكتب رسالة'),
  'earnings': Bi('Earnings', 'الأرباح'),
  'netEarnings': Bi('Net earnings', 'صافي الأرباح'),
  'gross': Bi('Gross earnings', 'إجمالي الأرباح'),
  'platformComm': Bi('Platform commission', 'عمولة المنصة'),
  'available': Bi('Available balance', 'الرصيد المتاح'),
  'withdraw2': Bi('Withdraw', 'سحب'),
  'pending': Bi('Pending', 'قيد التعليق'),
  'pendingSub': Bi(
    'Released 48 h after job completion',
    'يُتاح بعد 48 ساعة من إكمال المهمة',
  ),
  'howCalc': Bi('How earnings are calculated', 'كيف تُحتسب الأرباح'),
  'bookingAmt': Bi('Booking amount', 'مبلغ الحجز'),
  'platformFee15': Bi('Platform fee (15%)', 'رسوم المنصة (15%)'),
  'workerEarn': Bi('Your earnings', 'أرباحك'),
  'payouts': Bi('Payout history', 'سجل التحويلات'),
  'statements': Bi('Earning statements', 'كشوف الأرباح'),
  'subscription': Bi('Subscription', 'الاشتراك'),
  'currentPlan': Bi('Current plan', 'الباقة الحالية'),
  'perMonth': Bi('/ month', '/ شهرياً'),
  'plans': Bi('All plans', 'كل الباقات'),
  'payHistory': Bi('Payment history', 'سجل المدفوعات'),
  'cancelSub': Bi('Cancel subscription', 'إلغاء الاشتراك'),
  'profile': Bi('Profile', 'حسابي'),
  'verifiedPro': Bi('Verified professional', 'فني موثّق'),
  'services': Bi('Services', 'الخدمات'),
  'serviceArea': Bi('Service area', 'نطاق الخدمة'),
  'availability': Bi('Availability', 'أوقات العمل'),
  'reviewsT': Bi('Reviews', 'التقييمات'),
  'language': Bi('Language', 'اللغة'),
  'notifications': Bi('Notifications', 'الإشعارات'),
  'markRead': Bi('Mark all read', 'تعليم الكل كمقروء'),
  // Navigation and shared labels
  'navHome': Bi('Home', 'الرئيسية'),
  'navJobs': Bi('Jobs', 'المهام'),
  'navEarnings': Bi('Earnings', 'الأرباح'),
  'navProfile': Bi('Profile', 'حسابي'),
  'cont': Bi('Continue', 'متابعة'),
  'submitApp': Bi('Submit application', 'إرسال الطلب'),
  'cancel': Bi('Cancel', 'إلغاء'),

  // Real requests, quotes and jobs
  'retry': Bi('Try again', 'حاول مجدداً'),
  'wjLoadFailed': Bi('Could not load your jobs.', 'تعذّر تحميل مهامك.'),
  'wjRefreshFailed': Bi(
    'Could not refresh. Showing what we had.',
    'تعذّر التحديث. نعرض ما لدينا.',
  ),
  'wjNewEmpty': Bi('No new requests', 'لا توجد طلبات جديدة'),
  'wjNewEmptySub': Bi(
    'Requests for your services and cities appear here.',
    'تظهر هنا الطلبات الخاصة بخدماتك ومدنك.',
  ),
  'wsNew': Bi('New', 'جديد'),
  'wsQuoted': Bi('Awaiting customer', 'بانتظار العميل'),
  'wsPAYMENT_PENDING': Bi('Waiting for payment', 'بانتظار الدفع'),
  'wsCONFIRMED': Bi('Confirmed', 'مؤكد'),
  'wsIN_PROGRESS': Bi('In progress', 'قيد التنفيذ'),
  'wsCOMPLETED': Bi('Completed', 'مكتمل'),
  'wsCANCELLED': Bi('Cancelled', 'ملغى'),
  'wsEXPIRED': Bi('Expired', 'منتهي'),
  'wjUrgent': Bi('Urgent', 'عاجل'),
  'wjReference': Bi('Reference', 'الرقم المرجعي'),
  'wjExpires': Bi('Closes', 'ينتهي'),
  'wjAreaOnly': Bi(
    'Only the area is shown. The street address and the customer’s phone appear once the customer has paid.',
    'تظهر المنطقة فقط. يظهر عنوان الشارع ورقم العميل بعد أن يدفع العميل.',
  ),
  'wjPhotos': Bi('{n} photo(s) attached', 'صور مرفقة: {n}'),
  'wjRequestGone': Bi(
    'This request is no longer available.',
    'هذا الطلب لم يعد متاحاً.',
  ),
  'wjYourQuote': Bi('Your quote', 'عرضك'),
  'wjYouReceive': Bi('You receive', 'ستستلم'),
  'wjCustomerPays': Bi(
    'Customer pays (incl. VAT)',
    'يدفع العميل (شامل الضريبة)',
  ),
  'wjCommission': Bi('Platform commission', 'عمولة المنصة'),
  'wjVat': Bi('VAT', 'ضريبة القيمة المضافة'),
  'wjYourPrice': Bi('Your price (before VAT)', 'سعرك (قبل الضريبة)'),
  'wjPriceHint': Bi(
    'Only your own price. VAT and the platform commission are worked out by the server and shown after you send.',
    'سعرك أنت فقط. يحسب الخادم الضريبة وعمولة المنصة ويعرضها بعد الإرسال.',
  ),
  'wjMessage': Bi(
    'Note to the customer (optional)',
    'ملاحظة للعميل (اختيارية)',
  ),
  'wjValidFor': Bi('Offer valid for', 'مدة صلاحية العرض'),
  'wjComeAt': Bi('You will come', 'موعد حضورك'),
  'wjComeAtSub': Bi(
    'The customer’s requested time.',
    'الوقت الذي طلبه العميل.',
  ),
  'wjSendQuote': Bi('Send quote', 'إرسال العرض'),
  'wjSending': Bi('Sending…', 'جارٍ الإرسال…'),
  'wjQuoteSent': Bi('Quote sent', 'تم إرسال العرض'),
  'wjQuoteSentSub': Bi(
    'The customer will review it. If they choose yours, the job appears under Upcoming once they pay.',
    'سيراجعه العميل. إذا اختار عرضك تظهر المهمة ضمن القادمة بعد أن يدفع.',
  ),
  'wjQuoteStatus': Bi('Quote status', 'حالة العرض'),
  'wjBackToJobs': Bi('Back to jobs', 'العودة للمهام'),
  'wqSUBMITTED': Bi('Awaiting customer', 'بانتظار العميل'),
  'wqACCEPTED': Bi('Accepted', 'مقبول'),
  'wqREJECTED': Bi('Not chosen', 'لم يُختر'),
  'wqWITHDRAWN': Bi('Withdrawn', 'مسحوب'),
  'wqEXPIRED': Bi('Expired', 'منتهي'),
  'weInvalidPrice': Bi('Enter a price above zero.', 'أدخل سعراً أكبر من صفر.'),
  'weBelowMin': Bi(
    'The price is below the minimum service charge ({min}).',
    'السعر أقل من الحد الأدنى لرسوم الخدمة ({min}).',
  ),
  'weBelowMinUnknown': Bi(
    'The price is below the minimum service charge.',
    'السعر أقل من الحد الأدنى لرسوم الخدمة.',
  ),
  'weAboveMax': Bi(
    'The price is above the allowed maximum.',
    'السعر أعلى من الحد الأقصى المسموح.',
  ),
  'weWindow': Bi(
    'That time cannot be offered. Reopen the request and try again.',
    'لا يمكن عرض هذا الوقت. افتح الطلب وحاول مجدداً.',
  ),
  'weGone': Bi(
    'This request is no longer taking quotes.',
    'هذا الطلب لم يعد يستقبل عروضاً.',
  ),
  'weFull': Bi(
    'This request already has the maximum number of quotes.',
    'وصل هذا الطلب إلى الحد الأقصى من العروض.',
  ),
  'weNotSignedIn': Bi(
    'Your session has ended. Please sign in again.',
    'انتهت جلستك. يرجى تسجيل الدخول مجدداً.',
  ),
  'weValidation': Bi(
    'Please check the quote and try again.',
    'يرجى مراجعة العرض والمحاولة مجدداً.',
  ),
  'weNetwork': Bi(
    'No connection. Check your internet and try again. Nothing is sent twice.',
    'لا يوجد اتصال. تحقق من الإنترنت وحاول مجدداً. لن يُرسل شيء مرتين.',
  ),
  'weBusy': Bi(
    'The service is busy. Please try again in a moment.',
    'الخدمة مشغولة. حاول مجدداً بعد قليل.',
  ),
  'weOther': Bi(
    'Something went wrong. Please try again.',
    'حدث خطأ ما. حاول مجدداً.',
  ),
  'wjStartJob': Bi('Start job', 'بدء المهمة'),
  'wjCompleteJob': Bi('Complete job', 'إنهاء المهمة'),
  'wjWaitingPay': Bi('Waiting for the customer to pay', 'بانتظار دفع العميل'),
  'wjWaitingPaySub': Bi(
    'The street address, the exact location and the customer’s phone appear here once they have paid.',
    'يظهر هنا عنوان الشارع والموقع الدقيق ورقم العميل بعد أن يدفع.',
  ),
  'wjNoPoint': Bi(
    'No exact location was provided for this job. Use the address.',
    'لم يُحدَّد موقع دقيق لهذه المهمة. استخدم العنوان.',
  ),
  'wjCustomer': Bi('Customer', 'العميل'),
  'wjFinished': Bi('Job completed', 'اكتملت المهمة'),
  'wjFinishedSub': Bi('The customer has been notified.', 'تم إشعار العميل.'),
  'wjActNetwork': Bi(
    'No connection. Try again.',
    'لا يوجد اتصال. حاول مجدداً.',
  ),
  'wjActWrongState': Bi(
    'This job has changed. Showing the latest.',
    'تغيّرت هذه المهمة. نعرض الأحدث.',
  ),
  'wjActNotFound': Bi('This job is not available.', 'هذه المهمة غير متاحة.'),
  'wjActFailed': Bi(
    'Could not do that. Please try again.',
    'تعذّر تنفيذ ذلك. حاول مجدداً.',
  ),
  'wjJobGone': Bi('This job is not available.', 'هذه المهمة غير متاحة.'),
  'wjNoName': Bi('Welcome', 'أهلاً بك'),
  'wjNoActive': Bi('Nothing to do right now', 'لا يوجد شيء الآن'),
  'wjNextJobs': Bi('Your next jobs', 'مهامك القادمة'),
  'wjNoNext': Bi(
    'Jobs appear here once a customer accepts your quote and pays.',
    'تظهر المهام هنا بعد أن يقبل العميل عرضك ويدفع.',
  ),
  'wjOpen': Bi('Open', 'فتح'),
  'wjEarningsNone': Bi('No earnings to show yet', 'لا توجد أرباح لعرضها بعد'),
  'wjEarningsNoneSub': Bi(
    'Your earnings will be shown here once they are available.',
    'ستظهر أرباحك هنا عند توفرها.',
  ),
  'wjReview': Bi('Review and quote', 'مراجعة وتسعير'),

  // Cash
  'wjCashDue': Bi(
    'Collect {total} in cash from the customer',
    'استلم {total} نقداً من العميل',
  ),
  'wjCashHint': Bi(
    'The customer chose to pay you in person. Confirm below once you have received it.',
    'اختار العميل الدفع لك مباشرة. أكّد أدناه بعد استلام المبلغ.',
  ),
  'wjCashDone': Bi(
    'Cash received. Thank you.',
    'تم استلام المبلغ نقداً. شكراً.',
  ),
  'wjCashCollect': Bi('I received the cash', 'استلمت المبلغ نقداً'),

  // Chat
  'chatFailed': Bi('Not sent. Tap to retry', 'لم تُرسل. اضغط لإعادة المحاولة'),
  'chatSending': Bi('Sending…', 'جارٍ الإرسال…'),
  'chatClosed': Bi(
    'Chat is closed for this booking',
    'المحادثة مغلقة لهذا الحجز',
  ),
  'chatEmptyReal': Bi(
    'No messages yet. Say hello.',
    'لا توجد رسائل بعد. ابدأ بالتحية.',
  ),
  'chatLoadFailed': Bi(
    'Could not load the conversation.',
    'تعذّر تحميل المحادثة.',
  ),
  'chatNetwork': Bi(
    'No connection. Your message was not sent.',
    'لا يوجد اتصال. لم تُرسل رسالتك.',
  ),
  'chatTooLong': Bi('That message is too long.', 'الرسالة طويلة جداً.'),
  'chatRate': Bi(
    'You are sending too fast. Wait a moment.',
    'ترسل بسرعة كبيرة. انتظر قليلاً.',
  ),
  'chatGone': Bi(
    'This conversation is not available.',
    'هذه المحادثة غير متاحة.',
  ),
  'chatSignIn': Bi(
    'Your session has ended. Please sign in again.',
    'انتهت جلستك. يرجى تسجيل الدخول مجدداً.',
  ),
  'chatOther': Bi(
    'Something went wrong. Please try again.',
    'حدث خطأ ما. حاول مجدداً.',
  ),

  // Support
  'supTitle': Bi('Support', 'الدعم'),
  'supSub': Bi('Home Services team', 'فريق خدمات المنزل'),
  'chatEmptySupport': Bi(
    'Tell us how we can help. Our team replies here.',
    'أخبرنا كيف يمكننا مساعدتك. يرد فريقنا هنا.',
  ),

  // Sharing the position
  'wjShare': Bi(
    'Sharing your live location with the customer',
    'تشارك موقعك المباشر مع العميل',
  ),
  'wjShareOff': Bi(
    'Location is off: the customer cannot see you on the map',
    'الموقع متوقف: لا يستطيع العميل رؤيتك على الخريطة',
  ),
  'wjShareTurnOn': Bi('Turn on', 'تفعيل'),
  'wjShareTrying': Bi('Getting your location…', 'جارٍ تحديد موقعك…'),

  // Notifications, earnings and profile
  'ntNone': Bi('No notifications yet', 'لا توجد إشعارات بعد'),
  'ntNoneSub': Bi(
    'New requests, quote decisions, messages and updates on your application appear here.',
    'تظهر هنا الطلبات الجديدة وقرارات العروض والرسائل وتحديثات طلبك.',
  ),
  'ntFailed': Bi('Could not load notifications.', 'تعذّر تحميل الإشعارات.'),
  'ntToday': Bi('Today', 'اليوم'),
  'ntEarlier': Bi('Earlier', 'سابقاً'),
  'earnToday': Bi('Today', 'اليوم'),
  'earnWeek': Bi('Week', 'الأسبوع'),
  'earnMonth': Bi('Month', 'الشهر'),
  'earnFailed': Bi('Could not load your earnings.', 'تعذّر تحميل أرباحك.'),
  'earnDone': Bi('Jobs completed', 'مهام مكتملة'),
  'earnDoneSub': Bi('In the chosen period', 'في الفترة المختارة'),
  'earnAheadSub': Bi(
    'On {n} paid jobs still to do. Counted when completed.',
    'عن {n} مهام مدفوعة قيد التنفيذ. تُحتسب عند الإكمال.',
  ),
  'earnRecent': Bi('Completed jobs', 'المهام المكتملة'),
  'platformFee': Bi('Platform fee', 'رسوم المنصة'),
  'profNew': Bi('{n} new', '{n} جديد'),
  'profJobsDone': Bi('Jobs done', 'مهمة مكتملة'),
  'profRating': Bi('Rating', 'التقييم'),
  'profExperience': Bi('Experience', 'الخبرة'),
  'profYears': Bi('{n} yrs', '{n} سنة'),
  'profNoReviews': Bi('No reviews yet', 'لا توجد تقييمات بعد'),
  'profNoServices': Bi('Not set yet', 'لم تُحدَّد بعد'),
  'profDocuments': Bi('Documents', 'المستندات'),
  'profHelp': Bi('Help & support', 'المساعدة والدعم'),
  'profLogout': Bi('Log out', 'تسجيل الخروج'),
};
