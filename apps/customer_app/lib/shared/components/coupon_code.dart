import 'package:flutter/material.dart';

import '../../app/theme/app_colors.dart';
import '../../core/utils/text_styles.dart';
import 'dashed.dart';

/// Dashed outline pill showing a promo code.
class CouponCode extends StatelessWidget {
  const CouponCode(
    this.code, {
    super.key,
    this.fontSize = 12.5,
    this.padding = const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
    this.radius = 8,
  });

  final String code;
  final double fontSize;
  final EdgeInsetsGeometry padding;
  final double radius;

  @override
  Widget build(BuildContext context) {
    return DashedBox(
      radius: radius,
      color: AppColors.couponBorder,
      padding: padding,
      child: Text(
        code,
        style: ts(fontSize, w: 700, family: kLatinFont, ls: fontSize * 0.06),
      ),
    );
  }
}
