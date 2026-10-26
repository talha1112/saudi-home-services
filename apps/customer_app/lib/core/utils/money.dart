/// Formats a SAR amount for the active language. Whole amounts have no
/// decimals; fractional amounts always show two.
String money(num n, {required bool ar}) {
  final whole = n == n.roundToDouble();
  final text = _group(whole ? n.round().toString() : n.toStringAsFixed(2));
  return ar ? '$text ر.س' : 'SAR $text';
}

String moneyNeg(num n, {required bool ar}) => '− ${money(n, ar: ar)}';

String _group(String s) {
  final parts = s.split('.');
  final digits = parts[0];
  final buf = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) buf.write(',');
    buf.write(digits[i]);
  }
  return parts.length > 1 ? '$buf.${parts[1]}' : buf.toString();
}
