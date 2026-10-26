import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/theme/app_colors.dart';
import '../../core/utils/text_styles.dart';
import '../widgets/app_icon.dart';
import '../widgets/tiles.dart';
import 'inputs.dart';

/// Saudi mobile number input (+966 prefix). Always left-to-right.
class PhoneField extends StatelessWidget {
  const PhoneField({
    super.key,
    required this.controller,
    required this.ok,
    required this.onChanged,
  });

  final TextEditingController controller;
  final bool ok;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Directionality(
      textDirection: TextDirection.ltr,
      child: Container(
        height: 60,
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(
            color: ok ? AppColors.primary : AppColors.line,
            width: 1.5,
          ),
        ),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              decoration: const BoxDecoration(
                border: Border(right: BorderSide(color: AppColors.line)),
              ),
              child: Row(
                children: [
                  const Pill(
                    'SA',
                    fontSize: 11,
                    weight: 700,
                    radius: 5,
                    padding: EdgeInsets.symmetric(horizontal: 5, vertical: 3),
                    family: kLatinFont,
                  ),
                  const SizedBox(width: 8),
                  Text('+966', style: ts(16, w: 600, family: kLatinFont)),
                ],
              ),
            ),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: BareField(
                  controller: controller,
                  hint: '5X XXX XXXX',
                  fontSize: 18,
                  weight: 500,
                  family: kLatinFont,
                  letterSpacing: 0.72,
                  keyboardType: TextInputType.phone,
                  inputFormatters: [
                    FilteringTextInputFormatter.allow(RegExp(r'[0-9 ]')),
                  ],
                  onChanged: onChanged,
                ),
              ),
            ),
            if (ok)
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 14),
                child: AppIcon(
                  'check',
                  size: 20,
                  color: AppColors.primary,
                  strokeWidth: 2.5,
                ),
              ),
          ],
        ),
      ),
    );
  }
}
