import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../app/localization/app_strings.dart';
import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/inputs.dart';
import '../../../shared/models/worker_data.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tiles.dart';
import '../widgets/earnings_summary.dart';

const _validity = [
  Bi('30 min', '30 دقيقة'),
  Bi('2 hours', 'ساعتان'),
  Bi('24 hours', '24 ساعة'),
];

/// Build or edit the quote for the open request.
class QuoteScreen extends StatefulWidget {
  const QuoteScreen({super.key});

  @override
  State<QuoteScreen> createState() => _QuoteScreenState();
}

class _QuoteScreenState extends State<QuoteScreen> {
  late final TextEditingController _labour = TextEditingController(
    text: context.appRead.labour,
  );
  late final TextEditingController _parts = TextEditingController(
    text: context.appRead.parts,
  );
  late final TextEditingController _note = TextEditingController(
    text: context.appRead.quoteNote,
  );

  @override
  void dispose() {
    _labour.dispose();
    _parts.dispose();
    _note.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final ar = context.isAr;
    final r = app.request;
    final editing = app.quoteState == QuoteState.pending;
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 6, 20, 12),
              child: Row(
                children: [
                  SquareIconButton.back(context),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '${context.l(r.service)} · ${context.l(r.customer)}',
                          style: ts(12.5, c: AppColors.slate),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 1),
                        Text(
                          editing
                              ? (ar ? 'تعديل العرض' : 'Edit quote')
                              : (ar ? 'إرسال عرض سعر' : 'Submit quote'),
                          style: ts(18, w: 700),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
                children: [
                  Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: AppColors.chip,
                      borderRadius: BorderRadius.circular(16),
                    ),
                    child: Row(
                      children: [
                        const AppIcon('lock', size: 17, color: AppColors.slate),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                context.tr('minCharge'),
                                style: ts(14, w: 600),
                              ),
                              const SizedBox(height: 2),
                              Text(
                                context.tr('minFixed'),
                                style: ts(12, c: AppColors.slate),
                              ),
                            ],
                          ),
                        ),
                        Text(context.sar(kMinCharge), style: ts(16, w: 700)),
                      ],
                    ),
                  ),
                  const SizedBox(height: 14),
                  _AmountField(
                    label: ar ? 'أجور العمل' : 'Labour',
                    hint: ar
                        ? 'لوحدتين، شامل تنظيف التصريف'
                        : 'For 2 units, incl. drain flush',
                    controller: _labour,
                    onChanged: (v) => app.update(() => app.labour = v),
                  ),
                  const SizedBox(height: 14),
                  _AmountField(
                    label: ar ? 'قطع الغيار والمواد' : 'Parts & materials',
                    hint: ar
                        ? 'اذكر القطع في الملاحظة'
                        : 'List parts in the note below',
                    controller: _parts,
                    onChanged: (v) => app.update(() => app.parts = v),
                  ),
                  const SizedBox(height: 14),
                  Text(context.tr('notesCust'), style: ts(13, w: 600)),
                  const SizedBox(height: 7),
                  TextAreaBox(
                    controller: _note,
                    height: 84,
                    fontSize: 14.5,
                    radius: 16,
                    onChanged: (v) => app.quoteNote = v,
                  ),
                  const SizedBox(height: 14),
                  Text(context.tr('validity'), style: ts(13, w: 600)),
                  const SizedBox(height: 7),
                  SegmentedTabs(
                    labels: [for (final v in _validity) context.l(v)],
                    selected: app.validity,
                    onChanged: (i) => app.update(() => app.validity = i),
                    radius: 11,
                    outerRadius: 14,
                    fontSize: 13.5,
                  ),
                  const SizedBox(height: 14),
                  const EarningsSummary(),
                ],
              ),
            ),
            BottomBar(
              child: AppButton(
                label: editing
                    ? (ar ? 'تحديث العرض' : 'Update quote')
                    : (ar
                          ? 'إرسال العرض · ${context.sar(app.gross)}'
                          : 'Send quote · ${context.sar(app.gross)}'),
                onPressed: () {
                  app.update(() => app.quoteState = QuoteState.pending);
                  if (editing) {
                    Navigator.of(context).pop();
                  } else {
                    AppRouter.toQuoteStatus(context, replace: true);
                  }
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _AmountField extends StatelessWidget {
  const _AmountField({
    required this.label,
    required this.hint,
    required this.controller,
    required this.onChanged,
  });

  final String label;
  final String hint;
  final TextEditingController controller;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(label, style: ts(13, w: 600)),
        const SizedBox(height: 7),
        Container(
          height: 56,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.line, width: 1.5),
          ),
          child: Row(
            children: [
              Text(
                context.tr('sar'),
                style: ts(13, w: 600, c: AppColors.slate),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Directionality(
                  textDirection: TextDirection.ltr,
                  child: BareField(
                    controller: controller,
                    fontSize: 18,
                    weight: 600,
                    family: kLatinFont,
                    keyboardType: const TextInputType.numberWithOptions(
                      decimal: true,
                    ),
                    inputFormatters: [
                      FilteringTextInputFormatter.allow(RegExp(r'[0-9.]')),
                    ],
                    onChanged: onChanged,
                    textAlign: context.isAr ? TextAlign.end : TextAlign.start,
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 7),
        Text(hint, style: ts(12, c: AppColors.slate)),
      ],
    );
  }
}
