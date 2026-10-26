import 'package:flutter/material.dart';

import '../../app/theme/app_colors.dart';
import '../../core/extensions/context_extensions.dart';
import '../../core/utils/text_styles.dart';
import '../widgets/app_button.dart';
import '../widgets/app_icon.dart';
import '../widgets/tap.dart';

/// English / Arabic picker dialog. Applies the choice to [AppState].
Future<void> showLanguageDialog(BuildContext context) {
  return showDialog<void>(
    context: context,
    barrierColor: const Color(0x800F1E25),
    builder: (_) => const _LanguageDialog(),
  );
}

class _LanguageDialog extends StatefulWidget {
  const _LanguageDialog();

  @override
  State<_LanguageDialog> createState() => _LanguageDialogState();
}

class _LanguageDialogState extends State<_LanguageDialog> {
  late bool _arabic = context.appRead.isArabic;

  @override
  Widget build(BuildContext context) {
    // The dialog previews the pending language: direction and font switch
    // immediately, before "Apply".
    final ar = _arabic;
    final family = ar ? 'Tajawal' : 'Archivo';
    return Directionality(
      textDirection: ar ? TextDirection.rtl : TextDirection.ltr,
      child: DefaultTextStyle.merge(
        style: TextStyle(
          fontFamily: family,
          fontFamilyFallback: [ar ? 'Archivo' : 'Tajawal'],
        ),
        child: Dialog(
          backgroundColor: Colors.white,
          insetPadding: const EdgeInsets.all(20),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(28),
          ),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(18, 20, 18, 18),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 350),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: Padding(
                          padding: const EdgeInsetsDirectional.only(
                            start: 4,
                            top: 4,
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                ar ? 'اللغة' : 'Language',
                                style: ts(ar ? 22 : 20, w: 700, h: 1.25),
                              ),
                              const SizedBox(height: 4),
                              Text(
                                ar
                                    ? 'اختر لغتك المفضلة'
                                    : 'Choose your preferred language',
                                style: ts(
                                  ar ? 15 : 14,
                                  c: AppColors.slate,
                                  h: 1.5,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Tap(
                        onTap: () => Navigator.of(context).pop(),
                        child: Container(
                          width: 40,
                          height: 40,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: AppColors.chip,
                            borderRadius: BorderRadius.circular(13),
                          ),
                          child: const AppIcon(
                            'x',
                            size: 18,
                            color: AppColors.text,
                            strokeWidth: 2.2,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 18),
                  _Option(
                    glyph: 'EN',
                    glyphSize: 14,
                    label: 'English',
                    family: 'Archivo',
                    size: 17,
                    selected: !ar,
                    onTap: () => setState(() => _arabic = false),
                  ),
                  const SizedBox(height: 10),
                  _Option(
                    glyph: 'ع',
                    glyphSize: 22,
                    label: 'العربية',
                    family: 'Tajawal',
                    size: 19,
                    selected: ar,
                    rtl: true,
                    onTap: () => setState(() => _arabic = true),
                  ),
                  const SizedBox(height: 18),
                  AppButton(
                    label: ar ? 'تطبيق' : 'Apply',
                    height: 54,
                    fontSize: ar ? 17 : 16,
                    weight: 700,
                    onPressed: () {
                      context.appRead.setArabic(_arabic);
                      Navigator.of(context).pop();
                    },
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Option extends StatelessWidget {
  const _Option({
    required this.glyph,
    required this.glyphSize,
    required this.label,
    required this.family,
    required this.size,
    required this.selected,
    required this.onTap,
    this.rtl = false,
  });

  final String glyph;
  final double glyphSize;
  final String label;
  final String family;
  final double size;
  final bool selected;
  final bool rtl;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Tap(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        constraints: const BoxConstraints(minHeight: 68),
        padding: const EdgeInsetsDirectional.fromSTEB(12, 12, 16, 12),
        decoration: BoxDecoration(
          color: selected ? const Color(0xFFF3F8F7) : Colors.white,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(
            color: selected ? AppColors.primary : AppColors.line,
            width: 2,
          ),
        ),
        child: Row(
          children: [
            Container(
              width: 44,
              height: 44,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: selected ? AppColors.primary : AppColors.chip,
                borderRadius: BorderRadius.circular(14),
              ),
              child: Text(
                glyph,
                style: ts(
                  glyphSize,
                  w: 800,
                  c: selected ? Colors.white : AppColors.text,
                  family: family,
                  ls: glyph == 'EN' ? 0.56 : 0,
                ),
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Directionality(
                textDirection: rtl ? TextDirection.rtl : TextDirection.ltr,
                child: Text(
                  label,
                  style: ts(size, w: selected ? 700 : 500, family: family),
                ),
              ),
            ),
            Container(
              width: 26,
              height: 26,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: selected ? AppColors.primary : Colors.white,
                border: Border.all(
                  color: selected ? AppColors.primary : AppColors.radioRing,
                  width: 2,
                ),
              ),
              child: selected
                  ? const AppIcon(
                      'check',
                      size: 14,
                      color: Colors.white,
                      strokeWidth: 3.2,
                    )
                  : null,
            ),
          ],
        ),
      ),
    );
  }
}
