import 'dart:async';

import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart' show LatLng;
import 'package:hs_client/hs_client.dart';

import '../../../app/booking_scope.dart';
import '../../../app/router/app_router.dart';
import '../../messages/widgets/chat_target.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/tiles.dart';
import '../../booking/logic/booking_schedule.dart';
import '../logic/booking_detail_controller.dart';
import '../widgets/live_worker_map.dart';
import '../widgets/review_card.dart';

/// One of the customer's bookings, from the backend: while it is open the quotes workers sent (choose one), then paying the agreed total,
/// then the confirmed booking. Every amount, state and contact on this screen is what the server returned.
class BookingDetailScreen extends StatefulWidget {
  const BookingDetailScreen({
    super.key,
    required this.bookingId,
    this.mapBuilder = googleLiveMap,
    this.mapsEnabled,
    this.pollInterval = const Duration(seconds: 6),
  });

  final String bookingId;

  /// Draws the professional on the map (tests replace it: a platform view cannot run there).
  final LiveMapBuilder mapBuilder;
  final bool? mapsEnabled;

  /// How often the booking is asked for again while the screen is open, so a quote, a payment or a status change shows up by itself.
  final Duration pollInterval;

  @override
  State<BookingDetailScreen> createState() => _BookingDetailScreenState();
}

class _BookingDetailScreenState extends State<BookingDetailScreen> {
  BookingDetailController? _c;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_c == null) {
      _c = BookingScope.of(context).detailFor(widget.bookingId)..load();
      _poll = Timer.periodic(widget.pollInterval, (_) => _c?.load());
    }
  }

  Timer? _poll;

  @override
  void dispose() {
    _poll?.cancel();
    _c?.dispose();
    super.dispose();
  }

  void _listChanged() => BookingScope.of(context).bookings.load();

  Future<void> _choose(CustomerQuote quote) async {
    final c = _c!;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        key: const Key('confirm-dialog'),
        title: Text(ctx.tr('bdConfirmTitle')),
        content: Text(
          ctx
              .tr('bdConfirmBody')
              .replaceAll('{total}', ctx.sar(quote.money.total)),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text(ctx.tr('bdNotNow')),
          ),
          TextButton(
            key: const Key('confirm-accept'),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(ctx.tr('bdConfirm')),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    if (await c.accept(quote)) _listChanged();
  }

  Future<void> _payCash() async {
    final c = _c!;
    final d = c.detail;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        key: const Key('cash-dialog'),
        title: Text(ctx.tr('bdCashConfirmTitle')),
        content: Text(
          ctx
              .tr('bdCashConfirmBody')
              .replaceAll(
                '{total}',
                d?.money == null ? '' : ctx.sar(d!.money!.total),
              ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text(ctx.tr('bdNotNow')),
          ),
          TextButton(
            key: const Key('confirm-cash'),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(ctx.tr('bdCashConfirm')),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    if (await c.payCash()) _listChanged();
  }

  @override
  Widget build(BuildContext context) {
    final c = _c!;
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: ListenableBuilder(
          listenable: c,
          builder: (context, _) {
            final d = c.detail;
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
                              context.tr('bdTitle'),
                              style: ts(12.5, c: AppColors.slate),
                            ),
                            Text(
                              d?.serviceName(arabic: context.isAr) ?? '',
                              style: ts(19, w: 700),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ],
                        ),
                      ),
                      if (d != null)
                        Pill(
                          _statusText(context, d.status),
                          bg: AppColors.tealTint,
                          fg: AppColors.primary,
                          fontSize: 11.5,
                          weight: 700,
                          key: const Key('detail-status'),
                        ),
                    ],
                  ),
                ),
                Expanded(
                  child: d == null
                      ? _placeholder(context, c)
                      : _body(context, c, d),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _placeholder(BuildContext context, BookingDetailController c) {
    switch (c.status) {
      case DetailStatus.gone:
        return Center(
          child: Text(
            context.tr('bdGone'),
            key: const Key('detail-gone'),
            style: ts(15, c: AppColors.slate),
          ),
        );
      case DetailStatus.failed:
        return Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                context.tr('bdLoadFailed'),
                key: const Key('detail-failed'),
                style: ts(15, c: AppColors.slate),
              ),
              const SizedBox(height: 14),
              AppButton(
                key: const Key('detail-retry'),
                label: context.tr('retry'),
                expand: false,
                height: 44,
                padding: const EdgeInsets.symmetric(horizontal: 22),
                onPressed: c.load,
              ),
            ],
          ),
        );
      case DetailStatus.loading:
      case DetailStatus.ready:
        return const Center(child: CircularProgressIndicator(strokeWidth: 2.6));
    }
  }

  Widget _body(
    BuildContext context,
    BookingDetailController c,
    BookingDetail d,
  ) {
    final ar = context.isAr;
    return RefreshIndicator(
      onRefresh: c.load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 28),
        children: [
          if (c.failure != null) _FailureBanner(failure: c.failure!),
          AppCard(
            padding: const EdgeInsets.all(14),
            radius: 18,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  d.reference,
                  style: ts(12.5, c: AppColors.slate, family: kLatinFont),
                ),
                const SizedBox(height: 6),
                Text(
                  _window(d.preferredStartAt, d.preferredEndAt, ar),
                  style: ts(14.5, w: 600),
                ),
                const SizedBox(height: 4),
                Text(
                  [
                    d.location.addressLine,
                    d.location.district,
                    ar && d.location.cityNameAr.isNotEmpty
                        ? d.location.cityNameAr
                        : d.location.cityNameEn,
                  ].where((p) => p != null && p.isNotEmpty).join(' · '),
                  style: ts(13, c: AppColors.slate),
                ),
                const SizedBox(height: 8),
                Text(d.problemDescription, style: ts(13.5, h: 1.5)),
              ],
            ),
          ),
          const SizedBox(height: 16),
          if (d.status == 'OPEN') ..._quotesSection(context, c),
          if (d.status == 'PAYMENT_PENDING') ..._paymentSection(context, c, d),
          if (d.status == 'CONFIRMED' || d.status == 'IN_PROGRESS') ...[
            LiveWorkerMap(
              bookingId: d.id,
              destination: d.location.hasExactPoint
                  ? LatLng(d.location.latitude!, d.location.longitude!)
                  : null,
              mapBuilder: widget.mapBuilder,
              mapsEnabled: widget.mapsEnabled,
            ),
            const SizedBox(height: 16),
          ],
          if (c.isPaid) ..._paidSection(context, d),
          if (d.status == 'COMPLETED') ReviewCard(controller: c),
        ],
      ),
    );
  }

  List<Widget> _quotesSection(BuildContext context, BookingDetailController c) {
    final ar = context.isAr;
    return [
      Text(context.tr('bdQuotes'), style: ts(17, w: 700)),
      const SizedBox(height: 10),
      if (c.quotes.isEmpty)
        Text(
          context.tr('bdNoQuotes'),
          key: const Key('no-quotes'),
          style: ts(13.5, c: AppColors.slate, h: 1.5),
        ),
      for (final q in c.quotes) ...[
        AppCard(
          key: Key('quote-${q.id}'),
          padding: const EdgeInsets.all(14),
          radius: 18,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(q.worker.name(arabic: ar), style: ts(15.5, w: 700)),
              if (q.worker.serviceYearsOfExperience != null ||
                  q.worker.yearsOfExperience != null)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(
                    context
                        .tr('bdYears')
                        .replaceAll(
                          '{n}',
                          '${q.worker.serviceYearsOfExperience ?? q.worker.yearsOfExperience}',
                        ),
                    style: ts(12.5, c: AppColors.slate),
                  ),
                ),
              const SizedBox(height: 10),
              _row(context.tr('bdPrice'), context.sar(q.money.service)),
              _row(context.tr('bdVat'), context.sar(q.money.vat)),
              _row(
                context.tr('bdTotal'),
                context.sar(q.money.total),
                bold: true,
              ),
              if (q.proposedStartAt != null)
                _row(
                  context.tr('bdComes'),
                  _window(q.proposedStartAt, q.proposedEndAt, ar),
                ),
              if (q.message != null && q.message!.isNotEmpty) ...[
                const SizedBox(height: 6),
                Text(q.message!, style: ts(13, c: AppColors.slate, h: 1.45)),
              ],
              const SizedBox(height: 12),
              AppButton(
                key: Key('accept-${q.id}'),
                label: context.tr('bdChoose'),
                height: 46,
                radius: 14,
                fontSize: 14.5,
                enabled: !c.accepting,
                onPressed: () => _choose(q),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
      ],
    ];
  }

  List<Widget> _paymentSection(
    BuildContext context,
    BookingDetailController c,
    BookingDetail d,
  ) {
    final ar = context.isAr;
    return [
      AppCard(
        key: const Key('agreed'),
        padding: const EdgeInsets.all(14),
        radius: 18,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (d.worker != null)
              _row(context.tr('bdWorker'), d.worker!.name(arabic: ar)),
            if (d.money != null) ...[
              _row(context.tr('bdPrice'), context.sar(d.money!.service)),
              _row(context.tr('bdVat'), context.sar(d.money!.vat)),
              _row(
                context.tr('bdTotal'),
                context.sar(d.money!.total),
                bold: true,
              ),
            ],
            if (d.paymentDueAt != null)
              _row(context.tr('bdPayBy'), _stamp(d.paymentDueAt!, ar)),
          ],
        ),
      ),
      const SizedBox(height: 12),
      Text(context.tr('bdHowPay'), style: ts(15, w: 700)),
      const SizedBox(height: 10),
      _MethodTile(
        key: const Key('method-cash'),
        icon: 'card',
        title: context.tr('bdCash'),
        subtitle: context.tr('bdCashSub'),
        selected: true,
      ),
      for (final m in const [
        ('card', 'bdCard', 'bdCardSub'),
        ('phone', 'bdApplePay', 'bdOnlineSub'),
        ('phone', 'bdStcPay', 'bdOnlineSub'),
      ]) ...[
        const SizedBox(height: 8),
        _MethodTile(
          key: Key('method-${m.$2}'),
          icon: m.$1,
          title: context.tr(m.$2),
          subtitle: context.tr(m.$3),
          comingSoon: true,
        ),
      ],
      const SizedBox(height: 16),
      AppButton(
        key: const Key('pay-cash'),
        label: c.cashing ? context.tr('bdPaying') : context.tr('bdCashPay'),
        enabled: !c.cashing,
        onPressed: _payCash,
      ),
    ];
  }

  List<Widget> _paidSection(BuildContext context, BookingDetail d) {
    final ar = context.isAr;
    return [
      Container(
        key: const Key('paid'),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.tealTint,
          borderRadius: BorderRadius.circular(18),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              context.tr('bdPaidTitle'),
              style: ts(15, w: 700, c: AppColors.primary),
            ),
            const SizedBox(height: 4),
            Text(
              context.tr('bdPaidSub'),
              style: ts(13, c: AppColors.primary, h: 1.45),
            ),
            if (d.isCash && d.money != null) ...[
              const SizedBox(height: 10),
              Text(
                context
                    .tr('bdCashDue')
                    .replaceAll('{total}', context.sar(d.money!.total)),
                key: const Key('cash-due'),
                style: ts(13.5, w: 700),
              ),
            ],
            if (d.worker != null) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          d.worker!.name(arabic: ar),
                          style: ts(14.5, w: 600),
                        ),
                        if (d.worker!.phone != null &&
                            d.worker!.phone!.isNotEmpty)
                          Directionality(
                            textDirection: TextDirection.ltr,
                            child: Text(
                              d.worker!.phone!,
                              key: const Key('worker-phone'),
                              style: ts(
                                13.5,
                                c: AppColors.slate,
                                family: kLatinFont,
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  SquareIconButton(
                    key: const Key('chat-button'),
                    icon: 'message',
                    iconSize: 19,
                    bg: AppColors.primary,
                    fg: Colors.white,
                    bordered: false,
                    onTap: () => AppRouter.toChat(
                      context,
                      target: ChatTarget(
                        bookingId: d.id,
                        peerName: d.worker!.name(arabic: ar),
                        subtitle: d.serviceName(arabic: ar),
                        peerPhone: d.worker!.phone,
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    ];
  }

  Widget _row(String label, String value, {bool bold = false}) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 3),
    child: Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: ts(
            13.5,
            c: bold ? AppColors.text : AppColors.slate,
            w: bold ? 700 : 400,
          ),
        ),
        const SizedBox(width: 12),
        Flexible(
          child: Text(
            value,
            textAlign: TextAlign.end,
            style: ts(13.5, w: bold ? 700 : 600),
          ),
        ),
      ],
    ),
  );

  String _statusText(BuildContext context, String status) {
    final key = 'status$status';
    return context.tr(key) == key ? status : context.tr(key);
  }
}

String _stamp(DateTime at, bool ar) {
  final t = saudiNow(at);
  final h12 = t.hour % 12 == 0 ? 12 : t.hour % 12;
  final mm = t.minute.toString().padLeft(2, '0');
  final suffix = t.hour < 12 ? (ar ? 'ص' : 'AM') : (ar ? 'م' : 'PM');
  return '${t.day}/${t.month} · $h12:$mm $suffix';
}

String _window(DateTime? start, DateTime? end, bool ar) {
  if (start == null) return '';
  final from = _stamp(start, ar);
  if (end == null) return from;
  final t = saudiNow(end);
  final h12 = t.hour % 12 == 0 ? 12 : t.hour % 12;
  final suffix = t.hour < 12 ? (ar ? 'ص' : 'AM') : (ar ? 'م' : 'PM');
  return '$from – $h12:${t.minute.toString().padLeft(2, '0')} $suffix';
}

class _FailureBanner extends StatelessWidget {
  const _FailureBanner({required this.failure});
  final ActionFailure failure;

  @override
  Widget build(BuildContext context) {
    final key = switch (failure.problem) {
      ActionProblem.quoteChanged => 'bdeQuoteChanged',
      ActionProblem.notAvailable => 'bdeNotAvailable',
      ActionProblem.paymentsNotConfigured => 'bdePayNotConfigured',
      ActionProblem.alreadyPaid => 'bdeAlreadyPaid',
      ActionProblem.notPayable => 'bdeNotPayable',
      ActionProblem.deadlinePassed => 'bdeDeadline',
      ActionProblem.workerUnavailable => 'bdeWorkerGone',
      ActionProblem.paymentInProgress => 'bdePayInProgress',
      ActionProblem.notSignedIn => 'errNotSignedIn',
      ActionProblem.network => 'errNetwork',
      ActionProblem.busy => 'errUnavailable',
      ActionProblem.other => 'errOther',
    };
    return Container(
      key: const Key('detail-error'),
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.cream,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Text(
        context.tr(key),
        style: ts(13.5, w: 600, c: AppColors.creamText),
      ),
    );
  }
}

/// One way to pay. A method that is not available yet is shown greyed out with "Coming soon" and cannot be chosen.
class _MethodTile extends StatelessWidget {
  const _MethodTile({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
    this.selected = false,
    this.comingSoon = false,
  });

  final String icon;
  final String title;
  final String subtitle;
  final bool selected;
  final bool comingSoon;

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: comingSoon ? .55 : 1,
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: selected ? AppColors.primary : AppColors.lineSoft,
            width: 1.5,
          ),
        ),
        child: Row(
          children: [
            IconTile(
              icon,
              size: 40,
              radius: 13,
              iconSize: 19,
              bg: comingSoon ? AppColors.chip : AppColors.tealTint,
              fg: comingSoon ? AppColors.slate : AppColors.primary,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: ts(14.5, w: 600)),
                  const SizedBox(height: 2),
                  Text(subtitle, style: ts(12.5, c: AppColors.slate, h: 1.4)),
                ],
              ),
            ),
            const SizedBox(width: 8),
            if (comingSoon)
              Pill(
                context.tr('bdSoon'),
                key: const Key('coming-soon'),
                bg: AppColors.chip,
                fg: AppColors.slate,
                fontSize: 11.5,
                weight: 700,
              )
            else
              RadioDot(selected: selected),
          ],
        ),
      ),
    );
  }
}
