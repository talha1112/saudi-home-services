import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/inputs.dart';
import '../logic/booking_submitter.dart';

/// What the customer needs fixed. Photos are not part of `POST /bookings`, so there is no photo control here.
class DetailsStep extends StatefulWidget {
  const DetailsStep({super.key});

  @override
  State<DetailsStep> createState() => _DetailsStepState();
}

class _DetailsStepState extends State<DetailsStep> {
  late final TextEditingController _description = TextEditingController(
    text: context.appRead.description,
  );

  @override
  void dispose() {
    _description.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final length = app.description.trim().length;
    final tooShort = length < BookingDraft.minDescription;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(context.tr('describe'), style: ts(21, w: 700)),
        const SizedBox(height: 16),
        TextAreaBox(
          controller: _description,
          hint: context.tr('descPh'),
          onChanged: (v) => app.update(() => app.description = v),
        ),
        const SizedBox(height: 8),
        Text(
          tooShort
              ? context
                    .tr('descMin')
                    .replaceAll('{n}', '${BookingDraft.minDescription}')
              : '$length / ${BookingDraft.maxDescription}',
          key: const Key('description-hint'),
          style: ts(12.5, c: tooShort ? AppColors.slate : AppColors.primary),
        ),
        const SizedBox(height: 16),
        InfoNote(context.tr('quoteExplain')),
      ],
    );
  }
}
