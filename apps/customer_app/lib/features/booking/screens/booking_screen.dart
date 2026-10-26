import 'package:flutter/material.dart';

import '../../../app/booking_scope.dart';
import '../../../app/localization/app_strings.dart';
import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/config/demo_data.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tiles.dart';
import '../../quotes/widgets/quotes_step.dart';
import '../../quotes/widgets/review_quote_step.dart';
import '../logic/booking_submitter.dart';
import '../widgets/booking_progress.dart';
import '../widgets/details_step.dart';
import '../widgets/location_step.dart';
import '../widgets/schedule_step.dart';

const _stepTitles = [
  Bi('Location', 'الموقع'),
  Bi('Schedule', 'الموعد'),
  Bi('Details', 'التفاصيل'),
  Bi('Quotes', 'العروض'),
  Bi('Review quote', 'مراجعة العرض'),
];

/// The booking flow. Real builds have three steps (location, schedule, details); the last one sends the request to the backend and
/// continues on the "request sent" screen. Quotes and review come later from workers, so they are not steps of this flow. Demo builds
/// ([kDemoData]) keep the prototype's quote, review and payment steps.
class BookingScreen extends StatefulWidget {
  const BookingScreen({super.key, this.initialStep = 1});

  final int initialStep;

  @override
  State<BookingScreen> createState() => _BookingScreenState();
}

class _BookingScreenState extends State<BookingScreen> {
  late int _step = widget.initialStep;
  bool _changeOpen = false;
  bool _changeSent = false;

  int get _total => kDemoData ? 5 : 3;
  static const _lastRealStep = 3;

  void _back() {
    if (_step > 1) {
      setState(() {
        _step--;
        _changeOpen = false;
      });
    } else {
      Navigator.of(context).maybePop();
    }
  }

  /// Sends the request. On success the flow is replaced by the confirmation; on failure the customer stays here with the reason shown.
  Future<void> _submit() async {
    final app = context.appRead;
    final submitter = BookingScope.of(context).submitter;
    final booking = await submitter.submit(app.draft);
    if (!mounted) return;
    if (booking != null) {
      AppRouter.toBookingSent(context, booking);
      return;
    }
    // Something the customer still has to choose: take them to that step.
    final failure = submitter.failure;
    if (failure != null) {
      final missing = failure.missing;
      if (missing.contains('location') || missing.contains('city')) {
        setState(() => _step = 1);
      } else if (missing.contains('schedule') ||
          failure.problem == SubmitProblem.timePassed ||
          failure.problem == SubmitProblem.scheduleRejected) {
        setState(() => _step = 2);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final ar = context.isAr;
    final submitter = BookingScope.of(context).submitter;
    final canContinue = switch (_step) {
      1 => app.cityId != null && app.pickedLocation != null,
      2 => app.asap || app.slotIndex >= 0,
      3 => kDemoData || app.draft.missing().isEmpty,
      4 => !app.rejectedQuotes.contains(app.quoteIndex),
      _ => true,
    };
    final ctaKey = switch (_step) {
      3 => 'requestQuotes',
      4 => 'reviewQuote',
      _ => 'cont',
    };

    return PopScope(
      canPop: _step == 1 && !submitter.busy,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && !submitter.busy) _back();
      },
      child: Scaffold(
        body: SafeArea(
          bottom: false,
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 6, 20, 0),
                child: Row(
                  children: [
                    SquareIconButton.back(context, onTap: _back),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            ar
                                ? 'الخطوة $_step من $_total'
                                : 'Step $_step of $_total',
                            style: ts(12.5, c: AppColors.slate),
                          ),
                          const SizedBox(height: 1),
                          Text(
                            context.l(_stepTitles[_step - 1]),
                            style: ts(18, w: 700),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 14, 20, 0),
                child: BookingProgress(step: _step, total: _total),
              ),
              Container(
                margin: const EdgeInsets.fromLTRB(20, 14, 20, 0),
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                decoration: BoxDecoration(
                  color: AppColors.tealTint,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Row(
                  children: [
                    AppIcon(
                      app.service.icon,
                      size: 17,
                      color: AppColors.primary,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        context.l(app.service.name),
                        style: ts(13.5, w: 600, c: AppColors.primary),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(app.whenLabel(ar), style: ts(12.5, w: 500)),
                  ],
                ),
              ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(20, 18, 20, 24),
                  children: [
                    if (_step == _lastRealStep && !kDemoData)
                      ListenableBuilder(
                        listenable: submitter,
                        builder: (context, _) =>
                            _SubmitProblemBanner(failure: submitter.failure),
                      ),
                    switch (_step) {
                      1 => const LocationStep(),
                      2 => const ScheduleStep(),
                      3 => const DetailsStep(),
                      4 => const QuotesStep(),
                      _ => ReviewQuoteStep(
                        changeOpen: _changeOpen && !_changeSent,
                        changeSent: _changeSent,
                        onSendChange: () => setState(() {
                          _changeSent = true;
                          _changeOpen = false;
                        }),
                      ),
                    },
                  ],
                ),
              ),
              if (_step < 5)
                BottomBar(
                  child: ListenableBuilder(
                    listenable: submitter,
                    builder: (context, _) {
                      final sending =
                          _step == _lastRealStep &&
                          !kDemoData &&
                          submitter.busy;
                      return AppButton(
                        key: const Key('booking-cta'),
                        label: context.tr(sending ? 'sendingRequest' : ctaKey),
                        enabled: canContinue && !sending,
                        onPressed: () {
                          if (_step == _lastRealStep && !kDemoData) {
                            _submit();
                          } else {
                            setState(() => _step++);
                          }
                        },
                      );
                    },
                  ),
                )
              else
                BottomBar(
                  child: Column(
                    children: [
                      AppButton(
                        label: context.tr('accept'),
                        onPressed: () => AppRouter.toPay(context),
                      ),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          Expanded(
                            child: AppButton(
                              label: context.tr('reqChange'),
                              kind: AppButtonKind.soft,
                              height: 48,
                              radius: 15,
                              fontSize: 14,
                              onPressed: () => setState(() {
                                _changeOpen = true;
                                _changeSent = false;
                              }),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: AppButton(
                              label: context.tr('reject'),
                              kind: AppButtonKind.outline,
                              height: 48,
                              radius: 15,
                              fontSize: 14,
                              onPressed: () {
                                app.update(() {
                                  app.rejectedQuotes.add(app.quoteIndex);
                                  final next = [0, 1, 2].where(
                                    (i) => !app.rejectedQuotes.contains(i),
                                  );
                                  if (next.isNotEmpty) {
                                    app.quoteIndex = next.first;
                                  }
                                });
                                setState(() {
                                  _step = 4;
                                  _changeOpen = false;
                                  _changeSent = false;
                                });
                              },
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Why the last attempt to send the request did not go through, in the customer's words. Nothing is shown before a failure.
class _SubmitProblemBanner extends StatelessWidget {
  const _SubmitProblemBanner({required this.failure});

  final SubmitFailure? failure;

  @override
  Widget build(BuildContext context) {
    final f = failure;
    if (f == null) return const SizedBox.shrink();
    final key = switch (f.problem) {
      SubmitProblem.incomplete => switch (f.missing.isEmpty
          ? ''
          : f.missing.first) {
        'service' => 'needService',
        'city' => 'needCity',
        'location' => 'needLocation',
        'schedule' => 'needSchedule',
        _ => 'descMin',
      },
      SubmitProblem.timePassed => 'errTimePassed',
      SubmitProblem.notSignedIn => 'errNotSignedIn',
      SubmitProblem.validation => 'errValidation',
      SubmitProblem.scheduleRejected => 'errSchedule',
      SubmitProblem.serviceUnavailable => 'errService',
      SubmitProblem.cityUnavailable => 'errCity',
      SubmitProblem.limitReached => 'errLimit',
      SubmitProblem.network => 'errNetwork',
      SubmitProblem.unavailable => 'errUnavailable',
      SubmitProblem.other => 'errOther',
    };
    final text = context
        .tr(key)
        .replaceAll('{n}', '${BookingDraft.minDescription}');
    // The backend's own wording for a rejected schedule or field is added after ours, never instead of it.
    final detail = f.problem == SubmitProblem.scheduleRejected
        ? f.message
        : (f.fieldMessages.isEmpty ? null : f.fieldMessages.join('\n'));
    return Container(
      key: const Key('submit-error'),
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.cream,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(text, style: ts(13.5, w: 600, c: AppColors.creamText)),
          if (detail != null && detail.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(detail, style: ts(12.5, c: AppColors.creamText)),
          ],
        ],
      ),
    );
  }
}
