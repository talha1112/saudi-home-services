import '../../../app/localization/app_strings.dart';

/// A payment option shown on the payment screen (UI only; nothing is charged).
class PaymentMethod {
  const PaymentMethod({
    required this.id,
    required this.logo,
    required this.name,
    this.sub,
    this.subBuilder,
    this.unavailable = false,
  });

  final String id;
  final String logo;

  /// Either a [Bi] or a plain brand [String].
  final Object name;

  /// Either a [Bi] or built from the total (instalment methods).
  final Object? sub;
  final String Function(int total, bool ar)? subBuilder;
  final bool unavailable;
}

const List<PaymentMethod> kPaymentMethods = [
  PaymentMethod(
    id: 'mada',
    logo: 'mada',
    name: 'mada',
    sub: Bi('Debit card •••• 4821', 'بطاقة مدى •••• 4821'),
  ),
  PaymentMethod(
    id: 'apple',
    logo: 'Pay',
    name: 'Apple Pay',
    sub: Bi('Face ID', 'بصمة الوجه'),
  ),
  PaymentMethod(
    id: 'card',
    logo: 'VISA',
    name: Bi('Visa / Mastercard', 'فيزا / ماستركارد'),
    sub: Bi('Credit or debit card', 'بطاقة ائتمانية أو مدينة'),
  ),
  PaymentMethod(
    id: 'stc',
    logo: 'stc',
    name: 'STC Pay',
    sub: Bi('Wallet', 'محفظة'),
  ),
  PaymentMethod(
    id: 'tabby',
    logo: 'tabby',
    name: Bi('Tabby · pay in 4', 'تابي · 4 دفعات'),
    subBuilder: _tabbySub,
  ),
  PaymentMethod(
    id: 'tamara',
    logo: 'tamara',
    name: 'Tamara',
    sub: Bi('Not available for this booking', 'غير متاح لهذا الحجز'),
    unavailable: true,
  ),
];

String _tabbySub(int total, bool ar) {
  final part = (total / 4).toStringAsFixed(2);
  return ar ? '4 × $part ر.س بدون فوائد' : '4 × SAR $part, no interest';
}
