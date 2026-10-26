import 'package:flutter/material.dart';

import '../../app/theme/app_colors.dart';
import '../../core/utils/text_styles.dart';
import '../widgets/app_button.dart';
import '../widgets/tiles.dart';

/// Centered icon, title, description and two buttons.
class ConfirmSheetBody extends StatelessWidget {
  const ConfirmSheetBody({
    super.key,
    required this.icon,
    required this.title,
    required this.description,
    required this.cancelLabel,
    required this.confirmLabel,
    required this.tileBg,
    required this.tileFg,
    required this.confirmColor,
    required this.onConfirm,
  });

  final String icon;
  final String title;
  final String description;
  final String cancelLabel;
  final String confirmLabel;
  final Color tileBg;
  final Color tileFg;
  final Color confirmColor;
  final VoidCallback onConfirm;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        const SizedBox(height: 8),
        IconTile(
          icon,
          size: 72,
          radius: 24,
          iconSize: 30,
          bg: tileBg,
          fg: tileFg,
        ),
        const SizedBox(height: 12),
        Text(title, textAlign: TextAlign.center, style: ts(21, w: 700)),
        const SizedBox(height: 12),
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 310),
          child: Text(
            description,
            textAlign: TextAlign.center,
            style: ts(14, c: AppColors.slate, h: 1.5),
          ),
        ),
        const SizedBox(height: 20),
        Row(
          children: [
            Expanded(
              child: AppButton(
                label: cancelLabel,
                kind: AppButtonKind.outline,
                height: 52,
                radius: 16,
                fontSize: 15,
                onPressed: () => Navigator.of(context).pop(),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: AppButton(
                label: confirmLabel,
                background: confirmColor,
                height: 52,
                radius: 16,
                fontSize: 15,
                onPressed: () {
                  Navigator.of(context).pop();
                  onConfirm();
                },
              ),
            ),
          ],
        ),
      ],
    );
  }
}
