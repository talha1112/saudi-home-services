import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/sheets.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';
import '../logic/booking_detail_controller.dart';

/// The reasons a customer can give, as the backend names them, with the text key of each.
const cancelReasons = [
  ('CHANGED_MIND', 'bdCr1'),
  ('FOUND_ALTERNATIVE', 'bdCr2'),
  ('PRICE_TOO_HIGH', 'bdCr3'),
  ('SCHEDULE_CONFLICT', 'bdCr4'),
  ('PROBLEM_RESOLVED', 'bdCr5'),
];

/// Asks why, then cancels the booking through the server. Completes with true when the booking was cancelled.
Future<bool> showCancelBookingSheet(
  BuildContext context,
  BookingDetailController controller,
) async {
  final done = await showAppSheet<bool>(
    context,
    builder: (_) => _CancelBookingSheet(controller: controller),
  );
  return done == true;
}

class _CancelBookingSheet extends StatefulWidget {
  const _CancelBookingSheet({required this.controller});
  final BookingDetailController controller;

  @override
  State<_CancelBookingSheet> createState() => _CancelBookingSheetState();
}

class _CancelBookingSheetState extends State<_CancelBookingSheet> {
  int _reason = 0;
  bool _failed = false;

  Future<void> _confirm() async {
    setState(() => _failed = false);
    final ok = await widget.controller.cancel(cancelReasons[_reason].$1);
    if (!mounted) return;
    if (ok) {
      Navigator.of(context).pop(true);
    } else {
      setState(() => _failed = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final busy = widget.controller.acting;
        return Column(
          key: const Key('cancel-sheet'),
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(context.tr('cancelTitle'), style: ts(21, w: 700)),
            const SizedBox(height: 14),
            Text(
              context.tr('reason'),
              style: ts(13, w: 600, c: AppColors.slate),
            ),
            const SizedBox(height: 12),
            for (var i = 0; i < cancelReasons.length; i++) ...[
              Tap(
                key: Key('cancel-reason-${cancelReasons[i].$1}'),
                onTap: busy ? null : () => setState(() => _reason = i),
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 11,
                  ),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(13),
                    border: Border.all(
                      color: _reason == i
                          ? AppColors.primary
                          : AppColors.lineSoft,
                      width: 1.5,
                    ),
                  ),
                  child: Row(
                    children: [
                      RadioDot(selected: _reason == i, size: 20),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          context.tr(cancelReasons[i].$2),
                          style: ts(14),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 6),
            ],
            const SizedBox(height: 6),
            Text(
              context.tr('bdCancelNote'),
              style: ts(12.5, c: AppColors.slate, h: 1.45),
            ),
            if (_failed) ...[
              const SizedBox(height: 10),
              Text(
                context.tr('bdCancelFailed'),
                key: const Key('cancel-error'),
                style: ts(13, w: 600, c: AppColors.danger),
              ),
            ],
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: AppButton(
                    key: const Key('cancel-keep'),
                    label: context.tr('keepBooking'),
                    kind: AppButtonKind.soft,
                    height: 52,
                    radius: 16,
                    fontSize: 15,
                    enabled: !busy,
                    onPressed: () => Navigator.of(context).pop(false),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: AppButton(
                    key: const Key('cancel-confirm'),
                    label: context.tr('confirmCancel'),
                    kind: AppButtonKind.dark,
                    height: 52,
                    radius: 16,
                    fontSize: 15,
                    enabled: !busy,
                    onPressed: _confirm,
                  ),
                ),
              ],
            ),
          ],
        );
      },
    );
  }
}
