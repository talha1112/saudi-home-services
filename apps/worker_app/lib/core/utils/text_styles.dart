import 'package:flutter/painting.dart';

import '../../app/theme/app_colors.dart';

/// Compact [TextStyle] builder: `ts(15, w: 600, c: AppColors.slate)`.
TextStyle ts(
  double size, {
  int w = 400,
  Color c = AppColors.text,
  double? h,
  double? ls,
  TextDecoration? deco,
  String? family,
}) {
  return TextStyle(
    fontSize: size,
    fontWeight: FontWeight.values[(w ~/ 100 - 1).clamp(0, 8)],
    color: c,
    height: h,
    letterSpacing: ls,
    decoration: deco,
    fontFamily: family,
  );
}

/// Archivo is used for numerals, codes and Latin tokens in both languages.
const String kLatinFont = 'Archivo';
