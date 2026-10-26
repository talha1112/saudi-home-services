import '../../app/localization/app_strings.dart';
import 'service.dart';

// Local mock data used only to render the UI.

const int kMinCharge = 99;

const List<ServiceCategory> kCategories = [
  ServiceCategory('elec', Bi('Electrical', 'كهرباء'), 'zap'),
  ServiceCategory('plumb', Bi('Plumbing', 'سباكة'), 'droplet'),
  ServiceCategory('ac', Bi('AC', 'تكييف'), 'snowflake'),
];

const List<Service> kServices = [
  Service(
    id: 'acdeep',
    category: 'ac',
    name: Bi('AC Deep Cleaning', 'تنظيف عميق للمكيف'),
    description: Bi(
      'Split units: filters, coils, drain line and gas pressure check.',
      'وحدات سبليت: الفلاتر والملفات وخط التصريف وفحص ضغط الغاز.',
    ),
    price: 119,
    was: 149,
    rating: 4.9,
    reviews: 1284,
    duration: Bi('60–90 min', '60–90 دقيقة'),
    ribbon: Bi('20% OFF', 'خصم 20%'),
    ribbonGold: true,
    icon: 'snowflake',
  ),
  Service(
    id: 'socket',
    category: 'elec',
    name: Bi('Socket & Switch Repair', 'إصلاح الأفياش والمفاتيح'),
    description: Bi(
      'Replace or repair faulty sockets, switches and breakers.',
      'استبدال أو إصلاح الأفياش والمفاتيح والقواطع التالفة.',
    ),
    price: 99,
    rating: 4.8,
    reviews: 931,
    duration: Bi('30–60 min', '30–60 دقيقة'),
    ribbon: Bi('POPULAR', 'الأكثر طلباً'),
    icon: 'zap',
  ),
  Service(
    id: 'leak',
    category: 'plumb',
    name: Bi('Leak Detection & Repair', 'كشف وإصلاح التسربات'),
    description: Bi(
      'Find and fix leaks under sinks, in walls and around fixtures.',
      'كشف وإصلاح التسربات تحت المغاسل وفي الجدران وحول التمديدات.',
    ),
    price: 129,
    rating: 4.7,
    reviews: 512,
    duration: Bi('1–2 hrs', '1–2 ساعة'),
    ribbon: Bi('NEW', 'جديد'),
    ribbonGold: true,
    icon: 'droplet',
  ),
  Service(
    id: 'acgas',
    category: 'ac',
    name: Bi('AC Gas Refill', 'تعبئة غاز المكيف'),
    description: Bi(
      'Leak test and R410A refill for split and window units.',
      'فحص التسريب وتعبئة غاز R410A لمكيفات السبليت والشباك.',
    ),
    price: 199,
    rating: 4.8,
    reviews: 642,
    duration: Bi('45 min', '45 دقيقة'),
    icon: 'snowflake',
  ),
  Service(
    id: 'light',
    category: 'elec',
    name: Bi('Lighting Installation', 'تركيب الإنارة'),
    description: Bi(
      'Ceiling lights, chandeliers, spotlights and outdoor fittings.',
      'إنارة السقف والثريات والسبوت لايت والإنارة الخارجية.',
    ),
    price: 129,
    rating: 4.7,
    reviews: 388,
    duration: Bi('1–2 hrs', '1–2 ساعة'),
    icon: 'zap',
  ),
  Service(
    id: 'heater',
    category: 'plumb',
    name: Bi('Water Heater Repair', 'إصلاح السخان'),
    description: Bi(
      'Diagnose and repair electric water heaters, thermostats and elements.',
      'فحص وإصلاح السخانات الكهربائية والثرموستات والمقاومات.',
    ),
    price: 159,
    rating: 4.8,
    reviews: 276,
    duration: Bi('1 hr', 'ساعة'),
    icon: 'droplet',
  ),
];

Service serviceById(String id) => kServices.firstWhere((s) => s.id == id);

const Map<String, List<Bi>> kIncluded = {
  'ac': [
    Bi('Filter and coil cleaning', 'تنظيف الفلاتر والملفات'),
    Bi('Drain line flush', 'تنظيف خط التصريف'),
    Bi('Gas pressure check', 'فحص ضغط الغاز'),
    Bi('Before and after photos', 'صور قبل وبعد'),
  ],
  'elec': [
    Bi('Fault diagnosis', 'تشخيص العطل'),
    Bi('Repair or replacement labour', 'أجور الإصلاح أو الاستبدال'),
    Bi('Safety test after the job', 'اختبار السلامة بعد العمل'),
    Bi('30-day workmanship warranty', 'ضمان 30 يوماً على العمل'),
  ],
  'plumb': [
    Bi('Leak and pressure inspection', 'فحص التسرب والضغط'),
    Bi('Repair labour', 'أجور الإصلاح'),
    Bi('Clean-up after the job', 'التنظيف بعد العمل'),
    Bi('30-day workmanship warranty', 'ضمان 30 يوماً على العمل'),
  ],
};

const List<Worker> kWorkers = [
  Worker(
    name: Bi('Faisal Al-Harbi', 'فيصل الحربي'),
    initials: Bi('FH', 'ف'),
    rating: 4.9,
    jobs: 412,
    distanceKm: 2.1,
    etaMinutes: 12,
    quote: 250,
    availability: Bi('Can arrive in 12 min', 'يصل خلال 12 دقيقة'),
    note: Bi(
      'Includes drain flush for both units',
      'يشمل تنظيف التصريف للوحدتين',
    ),
  ),
  Worker(
    name: Bi('Omar Siddiq', 'عمر صديق'),
    initials: Bi('OS', 'ع'),
    rating: 4.8,
    jobs: 286,
    distanceKm: 3.4,
    etaMinutes: 18,
    quote: 270,
    availability: Bi('Can arrive in 18 min', 'يصل خلال 18 دقيقة'),
    note: Bi('Includes gas top-up if needed', 'يشمل تعبئة الغاز عند الحاجة'),
  ),
  Worker(
    name: Bi('Khalid Nasser', 'خالد ناصر'),
    initials: Bi('KN', 'خ'),
    rating: 4.7,
    jobs: 198,
    distanceKm: 5.0,
    etaMinutes: 40,
    quote: 230,
    availability: Bi('Available from 8:00 PM', 'متاح من 8:00 م'),
    note: Bi('Standard clean, 2 units', 'تنظيف قياسي لوحدتين'),
  ),
];

const List<BookingDay> kDays = [
  BookingDay(Bi('Today', 'اليوم'), 7),
  BookingDay(Bi('Thu', 'خميس'), 8),
  BookingDay(Bi('Fri', 'جمعة'), 9, full: true),
  BookingDay(Bi('Sat', 'سبت'), 10),
  BookingDay(Bi('Sun', 'أحد'), 11),
  BookingDay(Bi('Mon', 'اثنين'), 12),
];

const List<Bi> kSlots = [
  Bi('9:00 AM', '9:00 ص'),
  Bi('11:00 AM', '11:00 ص'),
  Bi('1:00 PM', '1:00 م'),
  Bi('4:00 PM', '4:00 م'),
  Bi('6:00 PM', '6:00 م'),
  Bi('8:00 PM', '8:00 م'),
];

class MockAddress {
  const MockAddress(this.icon, this.label, this.line);
  final String icon;
  final Bi label;
  final Bi line;
}

const List<MockAddress> kAddresses = [
  MockAddress(
    'home',
    Bi('Home', 'المنزل'),
    Bi(
      'King Fahd Rd, Al Olaya · Bldg 12, Apt 4',
      'طريق الملك فهد، العليا · مبنى 12، شقة 4',
    ),
  ),
  MockAddress(
    'file',
    Bi('Office', 'المكتب'),
    Bi('Anas Ibn Malik Rd, Al Malqa', 'طريق أنس بن مالك، الملقا'),
  ),
];

class MockReview {
  const MockReview(this.name, this.stars, this.text, this.date);
  final Bi name;
  final int stars;
  final Bi text;
  final Bi date;
}

const List<MockReview> kReviews = [
  MockReview(
    Bi('Noura A.', 'نورة ع.'),
    5,
    Bi(
      'Arrived on time and explained everything before starting. Both units are cooling properly again.',
      'وصل في الموعد وشرح كل شيء قبل البدء. الوحدتان تبردان بشكل ممتاز الآن.',
    ),
    Bi('2 days ago', 'قبل يومين'),
  ),
  MockReview(
    Bi('Abdullah M.', 'عبدالله م.'),
    4,
    Bi(
      'Clean work and a fair price. Would book again.',
      'عمل نظيف وسعر مناسب. سأحجز مرة أخرى.',
    ),
    Bi('1 week ago', 'قبل أسبوع'),
  ),
];

class BookingStage {
  const BookingStage(this.label, this.time);
  final Bi label;
  final Bi time;
}

const List<BookingStage> kStages = [
  BookingStage(
    Bi('Booking requested', 'تم طلب الحجز'),
    Bi('5:30 PM', '5:30 م'),
  ),
  BookingStage(
    Bi('Professional assigned', 'تم تعيين الفني'),
    Bi('5:31 PM', '5:31 م'),
  ),
  BookingStage(
    Bi('Professional accepted', 'قبل الفني الطلب'),
    Bi('5:33 PM', '5:33 م'),
  ),
  BookingStage(Bi('On the way', 'في الطريق'), Bi('5:47 PM', '5:47 م')),
  BookingStage(Bi('Arrived', 'وصل الفني'), Bi('6:01 PM', '6:01 م')),
  BookingStage(
    Bi('Service in progress', 'الخدمة قيد التنفيذ'),
    Bi('6:04 PM', '6:04 م'),
  ),
  BookingStage(
    Bi('Service completed', 'اكتملت الخدمة'),
    Bi('7:12 PM', '7:12 م'),
  ),
];
