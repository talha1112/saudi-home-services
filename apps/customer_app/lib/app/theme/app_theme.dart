import 'package:flutter/material.dart';

import 'app_colors.dart';

abstract final class AppTheme {
  static const _archivo = 'Archivo';
  static const _tajawal = 'Tajawal';

  /// Archivo for English, Tajawal for Arabic. Each falls back to the other so
  /// mixed content (numbers, brand names) still renders.
  static ThemeData of({required bool arabic}) {
    final family = arabic ? _tajawal : _archivo;
    final fallback = [arabic ? _archivo : _tajawal];
    final base = ThemeData(
      useMaterial3: true,
      fontFamily: family,
      fontFamilyFallback: fallback,
      colorScheme: ColorScheme.fromSeed(
        seedColor: AppColors.primary,
        primary: AppColors.primary,
        secondary: AppColors.gold,
        surface: AppColors.card,
      ),
      scaffoldBackgroundColor: AppColors.background,
      splashFactory: NoSplash.splashFactory,
      highlightColor: Colors.transparent,
    );
    return base.copyWith(
      textTheme: base.textTheme.apply(
        bodyColor: AppColors.text,
        displayColor: AppColors.text,
        fontFamily: family,
        fontFamilyFallback: fallback,
      ),
    );
  }
}
