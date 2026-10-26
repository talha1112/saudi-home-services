import 'package:flutter/material.dart';

import '../../../app/localization/app_strings.dart';
import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/inputs.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';

const _tags = [
  Bi('On time', 'في الموعد'),
  Bi('Professional', 'محترف'),
  Bi('Clean work', 'عمل نظيف'),
  Bi('Fair price', 'سعر عادل'),
  Bi('Friendly', 'ودود'),
];

const _words = [
  null,
  Bi('Poor', 'سيئ'),
  Bi('Fair', 'مقبول'),
  Bi('Good', 'جيد'),
  Bi('Very good', 'جيد جداً'),
  Bi('Excellent', 'ممتاز'),
];

class RateScreen extends StatefulWidget {
  const RateScreen({super.key});

  @override
  State<RateScreen> createState() => _RateScreenState();
}

class _RateScreenState extends State<RateScreen> {
  int _rating = 0;
  final Set<int> _selected = {};
  bool _submitted = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(child: _submitted ? _thanks(context) : _form(context)),
    );
  }

  Widget _form(BuildContext context) {
    final app = context.app;
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 6, 20, 0),
          child: Align(
            alignment: AlignmentDirectional.centerEnd,
            child: SquareIconButton(
              icon: 'x',
              iconSize: 20,
              onTap: () => AppRouter.toHomeTab(context),
            ),
          ),
        ),
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(24, 4, 24, 24),
            child: Column(
              children: [
                InitialsTile(
                  context.l(app.worker.initials),
                  size: 76,
                  fontSize: 26,
                  radius: 24,
                ),
                const SizedBox(height: 18),
                Text(
                  context.tr('rateTitle'),
                  textAlign: TextAlign.center,
                  style: ts(24, w: 700),
                ),
                const SizedBox(height: 14),
                Text(
                  '${context.l(app.service.name)} · ${context.l(app.worker.name)}',
                  textAlign: TextAlign.center,
                  style: ts(14.5, c: AppColors.slate, h: 1.5),
                ),
                const SizedBox(height: 22),
                Directionality(
                  textDirection: TextDirection.ltr,
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      for (var i = 1; i <= 5; i++) ...[
                        if (i > 1) const SizedBox(width: 8),
                        Tap(
                          onTap: () => setState(() => _rating = i),
                          child: SizedBox(
                            width: 52,
                            height: 52,
                            child: Center(
                              child: AppIcon(
                                'star',
                                size: 42,
                                color: i <= _rating
                                    ? AppColors.gold
                                    : const Color(0xFFCBD5DC),
                                filled: i <= _rating,
                                strokeWidth: 1.5,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                SizedBox(
                  height: 20,
                  child: Text(
                    _rating == 0 ? '' : context.l(_words[_rating]!),
                    style: ts(15, w: 600, c: AppColors.primary),
                  ),
                ),
                const SizedBox(height: 18),
                Wrap(
                  alignment: WrapAlignment.center,
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (var i = 0; i < _tags.length; i++)
                      SelectChip(
                        label: context.l(_tags[i]),
                        selected: _selected.contains(i),
                        height: 38,
                        radius: 19,
                        fontSize: 13.5,
                        horizontal: 14,
                        selectedBg: AppColors.tealTint,
                        selectedFg: AppColors.primary,
                        selectedBorder: AppColors.tealBorder,
                        onTap: () => setState(
                          () => _selected.contains(i)
                              ? _selected.remove(i)
                              : _selected.add(i),
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: 22),
                TextAreaBox(
                  hint: context.tr('comment'),
                  height: 100,
                  fontSize: 14.5,
                ),
              ],
            ),
          ),
        ),
        BottomBar(
          child: AppButton(
            label: context.tr('submit'),
            enabled: _rating > 0,
            onPressed: () => setState(() => _submitted = true),
          ),
        ),
      ],
    );
  }

  Widget _thanks(BuildContext context) {
    return Column(
      children: [
        Expanded(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 96,
                    height: 96,
                    alignment: Alignment.center,
                    decoration: const BoxDecoration(
                      color: AppColors.cream,
                      shape: BoxShape.circle,
                    ),
                    child: const AppIcon(
                      'star',
                      size: 46,
                      color: AppColors.gold,
                      filled: true,
                      strokeWidth: 0,
                    ),
                  ),
                  const SizedBox(height: 14),
                  Text(
                    context.tr('thanks'),
                    textAlign: TextAlign.center,
                    style: ts(24, w: 700),
                  ),
                  const SizedBox(height: 14),
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 290),
                    child: Text(
                      context.tr('thanksSub'),
                      textAlign: TextAlign.center,
                      style: ts(15, c: AppColors.slate, h: 1.5),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 14, 20, 20),
          child: AppButton(
            label: context.tr('backHome'),
            onPressed: () => AppRouter.toHomeTab(context),
          ),
        ),
      ],
    );
  }
}
