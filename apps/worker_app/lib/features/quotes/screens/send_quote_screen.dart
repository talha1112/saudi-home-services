import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/jobs_scope.dart';
import '../../../app/localization/app_strings.dart';
import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/saudi_time.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/inputs.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tiles.dart';
import '../logic/quote_submitter.dart';
import '../logic/quote_window.dart';
import '../widgets/quote_money_card.dart';

const _validity = [
  (Bi('1 hour', 'ساعة'), 1),
  (Bi('6 hours', '6 ساعات'), 6),
  (Bi('24 hours', '24 ساعة'), 24),
];

/// Sends a quote on an open request (`POST /workers/me/requests/:id/quote`). The worker types only their own price; the server prices VAT,
/// commission and the total, and the card shown afterwards is exactly what it answered.
class SendQuoteScreen extends StatefulWidget {
  const SendQuoteScreen({super.key, required this.request, this.clock});

  final WorkerRequest request;

  /// The current time (tests replace it).
  final DateTime Function()? clock;

  @override
  State<SendQuoteScreen> createState() => _SendQuoteScreenState();
}

class _SendQuoteScreenState extends State<SendQuoteScreen> {
  final _price = TextEditingController();
  final _message = TextEditingController();
  int _validityIndex = 2;
  WorkerQuote? _sent;

  DateTime get _now => (widget.clock ?? DateTime.now)();

  @override
  void dispose() {
    _price.dispose();
    _message.dispose();
    super.dispose();
  }

  int? get _halalas => parsePriceHalalas(_price.text);

  Future<void> _send() async {
    final quotes = JobsScope.of(context).quotes;
    final halalas = _halalas;
    if (halalas == null) {
      setState(() {}); // shows the price hint in the error colour
      return;
    }
    final r = widget.request;
    final w = proposedWindow(
      preferredStart: r.preferredStartAt,
      preferredEnd: r.preferredEndAt,
      now: _now,
    );
    final quote = await quotes.submit(
      r.id,
      SubmitQuoteRequest(
        priceHalalas: halalas,
        proposedStartAt: w.start,
        proposedEndAt: w.end,
        message: _message.text,
        validForHours: _validity[_validityIndex].$2,
      ),
    );
    if (!mounted) return;
    if (quote != null) setState(() => _sent = quote);
  }

  @override
  Widget build(BuildContext context) {
    final ar = context.isAr;
    final r = widget.request;
    final quotes = JobsScope.of(context).quotes;
    final sent = _sent;
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: ListenableBuilder(
          listenable: quotes,
          builder: (context, _) {
            final sending = quotes.isSending(r.id);
            return Column(
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
                              r.service.name(arabic: ar),
                              style: ts(12.5, c: AppColors.slate),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            Text(
                              sent == null
                                  ? context.tr('wjSendQuote')
                                  : context.tr('wjQuoteSent'),
                              style: ts(18, w: 700),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: sent == null
                      ? _form(context, quotes, sending)
                      : _done(context, sent),
                ),
                BottomBar(
                  child: sent == null
                      ? AppButton(
                          key: const Key('quote-send'),
                          label: sending
                              ? context.tr('wjSending')
                              : context.tr('wjSendQuote'),
                          enabled: !sending && _halalas != null,
                          onPressed: _send,
                        )
                      : AppButton(
                          key: const Key('quote-back'),
                          label: context.tr('wjBackToJobs'),
                          onPressed: () => AppRouter.toJobsTab(context, tab: 1),
                        ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _form(BuildContext context, QuoteSubmitter quotes, bool sending) {
    final ar = context.isAr;
    final r = widget.request;
    final failure = quotes.failure;
    final priceBad = _price.text.trim().isNotEmpty && _halalas == null;
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
      children: [
        if (failure != null) _FailureBanner(failure: failure),
        Text(context.tr('wjYourPrice'), style: ts(13, w: 600)),
        const SizedBox(height: 7),
        Container(
          height: 56,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
              color: priceBad ? AppColors.danger : AppColors.line,
              width: 1.5,
            ),
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
                    key: const Key('quote-price'),
                    controller: _price,
                    fontSize: 18,
                    weight: 600,
                    family: kLatinFont,
                    keyboardType: const TextInputType.numberWithOptions(
                      decimal: true,
                    ),
                    inputFormatters: [
                      FilteringTextInputFormatter.allow(RegExp(r'[0-9.٠-٩]')),
                    ],
                    onChanged: (_) {
                      quotes.clearFailure();
                      setState(() {});
                    },
                    textAlign: ar ? TextAlign.end : TextAlign.start,
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 7),
        Text(
          priceBad ? context.tr('weInvalidPrice') : context.tr('wjPriceHint'),
          key: const Key('quote-price-hint'),
          style: ts(
            12,
            c: priceBad ? AppColors.danger : AppColors.slate,
            h: 1.4,
          ),
        ),
        const SizedBox(height: 16),
        Text(context.tr('wjComeAt'), style: ts(13, w: 600)),
        const SizedBox(height: 7),
        AppCard(
          padding: const EdgeInsets.all(14),
          radius: 16,
          child: Row(
            children: [
              const AppIcon('calendar', size: 17, color: AppColors.primary),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  windowLabel(
                    r.preferredStartAt,
                    r.preferredEndAt,
                    arabic: ar,
                    now: _now,
                  ),
                  key: const Key('quote-window'),
                  style: ts(14, w: 600),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 6),
        Text(context.tr('wjComeAtSub'), style: ts(12, c: AppColors.slate)),
        const SizedBox(height: 16),
        Text(context.tr('wjMessage'), style: ts(13, w: 600)),
        const SizedBox(height: 7),
        TextAreaBox(
          key: const Key('quote-message'),
          controller: _message,
          height: 84,
          fontSize: 14.5,
          radius: 16,
          onChanged: (_) => quotes.clearFailure(),
        ),
        const SizedBox(height: 16),
        Text(context.tr('wjValidFor'), style: ts(13, w: 600)),
        const SizedBox(height: 7),
        SegmentedTabs(
          labels: [for (final v in _validity) context.l(v.$1)],
          selected: _validityIndex,
          onChanged: (i) => setState(() => _validityIndex = i),
          radius: 11,
          outerRadius: 14,
          fontSize: 13.5,
        ),
      ],
    );
  }

  Widget _done(BuildContext context, WorkerQuote quote) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
      children: [
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: AppColors.tealTint,
            borderRadius: BorderRadius.circular(18),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const AppIcon(
                'check',
                size: 20,
                color: AppColors.tealDeep,
                strokeWidth: 2.6,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  context.tr('wjQuoteSentSub'),
                  key: const Key('quote-sent'),
                  style: ts(13.5, c: AppColors.tealDeep, h: 1.45),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        QuoteMoneyCard(quote: quote),
      ],
    );
  }
}

class _FailureBanner extends StatelessWidget {
  const _FailureBanner({required this.failure});

  final QuoteFailure failure;

  @override
  Widget build(BuildContext context) {
    final text = switch (failure.problem) {
      QuoteProblem.invalidPrice => context.tr('weInvalidPrice'),
      QuoteProblem.belowMinimum =>
        failure.limitHalalas == null
            ? context.tr('weBelowMinUnknown')
            : context
                  .tr('weBelowMin')
                  .replaceAll(
                    '{min}',
                    context.sar(failure.limitHalalas! / 100),
                  ),
      QuoteProblem.aboveMaximum => context.tr('weAboveMax'),
      QuoteProblem.window => context.tr('weWindow'),
      QuoteProblem.unavailable => context.tr('weGone'),
      QuoteProblem.full => context.tr('weFull'),
      QuoteProblem.notSignedIn => context.tr('weNotSignedIn'),
      QuoteProblem.validation => context.tr('weValidation'),
      QuoteProblem.network => context.tr('weNetwork'),
      QuoteProblem.busy => context.tr('weBusy'),
      QuoteProblem.other => context.tr('weOther'),
    };
    return Container(
      key: const Key('quote-error'),
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.cream,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Text(text, style: ts(13.5, w: 600, c: AppColors.creamText)),
    );
  }
}
