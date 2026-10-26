/// Strips non-digits, a leading 966 country code and a leading 0, and caps the
/// number at 9 digits (Saudi mobile format).
String normalizeSaudiDigits(String input) {
  var v = input.replaceAll(RegExp(r'\D'), '');
  if (v.startsWith('966')) v = v.substring(3);
  if (v.startsWith('0')) v = v.substring(1);
  return v.length > 9 ? v.substring(0, 9) : v;
}

/// "551234567" -> "55 123 4567".
String formatSaudiPhone(String digits) {
  final parts = <String>[
    digits.substring(0, digits.length.clamp(0, 2)),
    if (digits.length > 2) digits.substring(2, digits.length.clamp(2, 5)),
    if (digits.length > 5) digits.substring(5),
  ];
  return parts.where((p) => p.isNotEmpty).join(' ');
}

bool isValidSaudiPhone(String digits) =>
    digits.length == 9 && digits.startsWith('5');
