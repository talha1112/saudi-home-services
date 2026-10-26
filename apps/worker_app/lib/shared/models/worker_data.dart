import '../../app/localization/app_strings.dart';

// Local mock data used only to render the UI.

const int kMinCharge = 99;

class SubscriptionPlan {
  const SubscriptionPlan(this.id, this.name, this.price, this.rate, this.perks);
  final String id;
  final Bi name;
  final int price;

  /// Platform commission percentage.
  final int rate;
  final List<Bi> perks;
}

const List<SubscriptionPlan> kPlans = [
  SubscriptionPlan('basic', Bi('Basic', 'أساسية'), 0, 18, [
    Bi('18% commission', 'عمولة 18%'),
    Bi('Up to 5 quotes a day', 'حتى 5 عروض يومياً'),
    Bi('Standard support', 'دعم عادي'),
  ]),
  SubscriptionPlan('pro', Bi('Pro', 'احترافية'), 149, 15, [
    Bi('15% commission', 'عمولة 15%'),
    Bi('Unlimited quotes', 'عروض غير محدودة'),
    Bi('Shown higher in quote lists', 'ظهور أعلى في قائمة العروض'),
  ]),
  SubscriptionPlan('elite', Bi('Elite', 'النخبة'), 299, 12, [
    Bi('12% commission', 'عمولة 12%'),
    Bi('Featured badge on your profile', 'شارة مميزة في ملفك'),
    Bi('Priority support line', 'خط دعم بأولوية'),
  ]),
];

class JobRequest {
  const JobRequest({
    required this.id,
    required this.icon,
    required this.service,
    required this.customer,
    required this.initial,
    required this.area,
    required this.distanceKm,
    required this.when,
    required this.timer,
    required this.photos,
    this.address,
    this.description,
  });

  final String id;
  final String icon;
  final Bi service;
  final Bi customer;
  final Bi initial;
  final Bi area;
  final double distanceKm;
  final Bi when;
  final String timer;
  final int photos;
  final Bi? address;
  final Bi? description;
}

const List<JobRequest> kRequests = [
  JobRequest(
    id: 'r1',
    icon: 'snowflake',
    service: Bi('AC Deep Cleaning', 'تنظيف عميق للمكيف'),
    customer: Bi('Sara Q.', 'سارة ق.'),
    initial: Bi('S', 'س'),
    area: Bi('Al Olaya', 'العليا'),
    distanceKm: 2.1,
    when: Bi('Today · 6:00 PM', 'اليوم · 6:00 م'),
    timer: '08:42',
    photos: 2,
    address: Bi(
      'King Fahd Rd · Bldg 12, Apt 4',
      'طريق الملك فهد · مبنى 12، شقة 4',
    ),
    description: Bi(
      'Two split units in the bedrooms. Weak cooling and water dripping from the indoor unit in the master bedroom.',
      'وحدتا سبليت في غرف النوم. تبريد ضعيف وتسريب ماء من الوحدة الداخلية في غرفة النوم الرئيسية.',
    ),
  ),
  JobRequest(
    id: 'r2',
    icon: 'zap',
    service: Bi('Socket & Switch Repair', 'إصلاح الأفياش والمفاتيح'),
    customer: Bi('Mohammed A.', 'محمد أ.'),
    initial: Bi('M', 'م'),
    area: Bi('Al Malqa', 'الملقا'),
    distanceKm: 4.3,
    when: Bi('Tomorrow · 10:00 AM', 'غداً · 10:00 ص'),
    timer: '21:10',
    photos: 1,
  ),
];

const List<Bi> kWeekdays = [
  Bi('Sat', 'سبت'),
  Bi('Sun', 'أحد'),
  Bi('Mon', 'اثنين'),
  Bi('Tue', 'ثلاثاء'),
  Bi('Wed', 'أربعاء'),
  Bi('Thu', 'خميس'),
  Bi('Fri', 'جمعة'),
];

/// Where the customer is with the worker's quote.
enum QuoteState { none, pending, accepted, rejected, withdrawn }

const List<Bi> kStages = [
  Bi('Ready to go', 'جاهز للانطلاق'),
  Bi('On the way', 'في الطريق'),
  Bi('Arrived', 'وصلت'),
  Bi('Service in progress', 'الخدمة قيد التنفيذ'),
  Bi('Completed', 'مكتملة'),
];

const List<Bi> kStageButtons = [
  Bi('Start trip', 'بدء الرحلة'),
  Bi('I’ve arrived', 'وصلت'),
  Bi('Start work', 'بدء العمل'),
  Bi('Complete job', 'إنهاء المهمة'),
  Bi('Back to dashboard', 'العودة للرئيسية'),
];
