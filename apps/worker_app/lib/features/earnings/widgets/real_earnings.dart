import 'package:flutter/material.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/jobs_scope.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/saudi_time.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/inputs.dart';
import '../../../shared/widgets/tiles.dart';
import '../../jobs/logic/worker_jobs_controller.dart';

/// The start of the Saudi day that [at] falls on, as a UTC instant.
DateTime saudiDayStart(DateTime at) {
  final local = at.toUtc().add(kSaudiOffset);
  return DateTime.utc(
    local.year,
    local.month,
    local.day,
  ).subtract(kSaudiOffset);
}

/// Where a period starts: 0 = today, 1 = the last seven days (today included), 2 = this calendar month.
DateTime periodStart(int period, DateTime now) {
  final today = saudiDayStart(now);
  if (period == 0) return today;
  if (period == 1) return today.subtract(const Duration(days: 6));
  final local = now.toUtc().add(kSaudiOffset);
  return DateTime.utc(local.year, local.month, 1).subtract(kSaudiOffset);
}

/// What completed jobs earned: the worker's price, the platform's commission and what the worker keeps, all as the server stored them.
class EarningsSummary {
  const EarningsSummary({
    required this.jobs,
    required this.grossHalalas,
    required this.commissionHalalas,
    required this.netHalalas,
  });

  final int jobs;
  final int grossHalalas;
  final int commissionHalalas;
  final int netHalalas;
}

bool _counts(WorkerJob j) =>
    j.status == 'COMPLETED' && j.money != null && j.completedAt != null;

/// The jobs completed at or after [from] (and before [to] when given).
EarningsSummary summarize(
  Iterable<WorkerJob> jobs,
  DateTime from, {
  DateTime? to,
}) {
  var n = 0, gross = 0, commission = 0, net = 0;
  for (final j in jobs) {
    if (!_counts(j)) continue;
    final at = j.completedAt!;
    if (at.isBefore(from) || (to != null && !at.isBefore(to))) continue;
    n += 1;
    gross += j.money!.serviceHalalas;
    commission += j.money!.commissionHalalas;
    net += j.money!.payoutHalalas;
  }
  return EarningsSummary(
    jobs: n,
    grossHalalas: gross,
    commissionHalalas: commission,
    netHalalas: net,
  );
}

/// What the worker kept on each of the last seven Saudi days, oldest first (today last), in halalas.
List<int> lastSevenDays(Iterable<WorkerJob> jobs, DateTime now) {
  final today = saudiDayStart(now);
  return [
    for (var i = 6; i >= 0; i--)
      summarize(
        jobs,
        today.subtract(Duration(days: i)),
        to: today.subtract(Duration(days: i - 1)),
      ).netHalalas,
  ];
}

/// The earnings screen of a real build: only what the server's list of this worker's jobs adds up to. The platform does not record
/// payouts yet, so there is no balance to withdraw and no payout history; the screen shows what the completed jobs earned and what
/// the jobs still ahead will.
class RealEarnings extends StatefulWidget {
  const RealEarnings({super.key, this.clock});

  /// For tests.
  final DateTime Function()? clock;

  @override
  State<RealEarnings> createState() => _RealEarningsState();
}

class _RealEarningsState extends State<RealEarnings> {
  int _period = 1;
  WorkerJobsController? _jobs;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final next = JobsScope.of(context).jobs;
    if (identical(next, _jobs)) return;
    _jobs = next;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && context.auth.isSignedIn) _jobs!.loadJobs();
    });
  }

  static const _tabs = ['earnToday', 'earnWeek', 'earnMonth'];
  static const _dayEn = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  static const _dayAr = ['ن', 'ث', 'ر', 'خ', 'ج', 'س', 'ح'];

  @override
  Widget build(BuildContext context) {
    final jobs = _jobs!;
    final ar = context.isAr;
    return ListenableBuilder(
      listenable: jobs,
      builder: (context, _) {
        final now = (widget.clock ?? DateTime.now)();
        final all = jobs.jobs;
        final status = jobs.jobsStatus;
        Widget header() => Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text(context.tr('earnings'), style: ts(26, w: 700)),
        );
        if (status == LoadStatus.idle ||
            (status == LoadStatus.loading && all.isEmpty)) {
          return ListView(
            padding: const EdgeInsets.fromLTRB(20, 6, 20, 28),
            children: [
              header(),
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 60),
                child: Center(
                  child: CircularProgressIndicator(strokeWidth: 2.6),
                ),
              ),
            ],
          );
        }
        if (status == LoadStatus.failed && all.isEmpty) {
          return ListView(
            padding: const EdgeInsets.fromLTRB(20, 6, 20, 28),
            children: [
              header(),
              EmptyState(
                key: const Key('earnings-failed'),
                icon: 'card',
                title: context.tr('earnFailed'),
                subtitle: '',
                actionLabel: context.tr('retry'),
                onAction: jobs.loadJobs,
                verticalPadding: 60,
              ),
            ],
          );
        }

        final period = summarize(all, periodStart(_period, now));
        final days = lastSevenDays(all, now);
        final top = days.fold<int>(1, (a, b) => b > a ? b : a);
        final todayWeekday = now.toUtc().add(kSaudiOffset).weekday;
        String labelFor(int i) {
          final weekday = ((todayWeekday - 1 - (6 - i)) % 7 + 7) % 7;
          return ar ? _dayAr[weekday] : _dayEn[weekday];
        }

        final ahead = all
            .where(
              (j) =>
                  (j.status == 'CONFIRMED' || j.status == 'IN_PROGRESS') &&
                  j.money != null,
            )
            .toList();
        final aheadNet = ahead.fold<int>(
          0,
          (a, j) => a + j.money!.payoutHalalas,
        );
        final rateBps = all
            .where((j) => j.money != null && j.money!.commissionRateBps > 0)
            .map((j) => j.money!.commissionRateBps)
            .firstOrNull;
        final recent = all.where(_counts).toList()
          ..sort((a, b) => b.completedAt!.compareTo(a.completedAt!));
        final soft = Colors.white.withValues(alpha: .8);

        Widget statBox(String k, String v) => Expanded(
          child: Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: .1),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(k, style: ts(12, c: soft)),
                const SizedBox(height: 3),
                Text(v, style: ts(16, w: 700, c: Colors.white)),
              ],
            ),
          ),
        );

        return RefreshIndicator(
          onRefresh: jobs.loadJobs,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(20, 6, 20, 28),
            children: [
              header(),
              const SizedBox(height: 16),
              SegmentedTabs(
                labels: [for (final t in _tabs) context.tr(t)],
                selected: _period,
                onChanged: (i) => setState(() => _period = i),
                radius: 11,
                outerRadius: 14,
                fontSize: 13.5,
              ),
              const SizedBox(height: 16),
              ClipRRect(
                borderRadius: BorderRadius.circular(24),
                child: Container(
                  key: const Key('earnings-hero'),
                  color: AppColors.primary,
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        '${context.tr('netEarnings')} · ${context.tr(_tabs[_period])}',
                        style: ts(13, c: Colors.white.withValues(alpha: .85)),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        context.sar(period.netHalalas / 100),
                        key: const Key('earnings-net'),
                        style: ts(36, w: 800, c: Colors.white, ls: -0.36),
                      ),
                      const SizedBox(height: 16),
                      Row(
                        children: [
                          statBox(
                            context.tr('gross'),
                            context.sar(period.grossHalalas / 100),
                          ),
                          const SizedBox(width: 10),
                          statBox(
                            context.tr('platformComm'),
                            context.sarNeg(period.commissionHalalas / 100),
                          ),
                        ],
                      ),
                      const SizedBox(height: 16),
                      Directionality(
                        textDirection: TextDirection.ltr,
                        child: SizedBox(
                          height: 84,
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              for (var i = 0; i < days.length; i++) ...[
                                if (i > 0) const SizedBox(width: 8),
                                Expanded(
                                  child: Column(
                                    mainAxisAlignment: MainAxisAlignment.end,
                                    children: [
                                      Container(
                                        key: Key('earnings-bar-$i'),
                                        height: (days[i] / top * 64)
                                            .clamp(4, 64)
                                            .toDouble(),
                                        decoration: BoxDecoration(
                                          color: i == days.length - 1
                                              ? AppColors.gold
                                              : Colors.white.withValues(
                                                  alpha: .35,
                                                ),
                                          borderRadius: BorderRadius.circular(
                                            6,
                                          ),
                                        ),
                                      ),
                                      const SizedBox(height: 5),
                                      Text(
                                        labelFor(i),
                                        style: ts(10.5, c: soft),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 16),
              IntrinsicHeight(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Expanded(
                      child: AppCard(
                        padding: const EdgeInsets.all(14),
                        radius: 18,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              context.tr('earnDone'),
                              style: ts(12, c: AppColors.slate),
                            ),
                            const SizedBox(height: 6),
                            Text(
                              '${period.jobs}',
                              key: const Key('earnings-jobs'),
                              style: ts(20, w: 700),
                            ),
                            const SizedBox(height: 6),
                            Text(
                              context.tr('earnDoneSub'),
                              style: ts(11.5, c: AppColors.slate, h: 1.4),
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: AppCard(
                        padding: const EdgeInsets.all(14),
                        radius: 18,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              context.tr('pending'),
                              style: ts(12, c: AppColors.slate),
                            ),
                            const SizedBox(height: 6),
                            Text(
                              context.sar(aheadNet / 100),
                              key: const Key('earnings-ahead'),
                              style: ts(20, w: 700),
                            ),
                            const SizedBox(height: 6),
                            Text(
                              context
                                  .tr('earnAheadSub')
                                  .replaceAll('{n}', '${ahead.length}'),
                              style: ts(11.5, c: AppColors.slate, h: 1.4),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              if (rateBps != null) ...[
                const SizedBox(height: 16),
                AppCard(
                  key: const Key('earnings-how'),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(context.tr('howCalc'), style: ts(16, w: 700)),
                      const SizedBox(height: 12),
                      Directionality(
                        textDirection: TextDirection.ltr,
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(6),
                          child: SizedBox(
                            height: 12,
                            child: Row(
                              children: [
                                Expanded(
                                  flex: 10000 - rateBps,
                                  child: Container(color: AppColors.primary),
                                ),
                                Expanded(
                                  flex: rateBps,
                                  child: Container(color: AppColors.gold),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 12),
                      PriceRow(context.tr('bookingAmt'), context.sar(300)),
                      const SizedBox(height: 12),
                      _Legend(
                        color: AppColors.gold,
                        label:
                            '${context.tr('platformFee')} (${rateBps / 100}%)',
                        value: context.sarNeg(300 * rateBps / 10000),
                      ),
                      const SizedBox(height: 12),
                      const HairlineDivider(),
                      const SizedBox(height: 12),
                      _Legend(
                        color: AppColors.primary,
                        label: context.tr('workerEarn'),
                        value: context.sar(300 - 300 * rateBps / 10000),
                        bold: true,
                      ),
                    ],
                  ),
                ),
              ],
              Padding(
                padding: const EdgeInsets.only(top: 20, bottom: 16),
                child: Text(context.tr('earnRecent'), style: ts(16, w: 700)),
              ),
              if (recent.isEmpty)
                EmptyState(
                  key: const Key('earnings-none'),
                  icon: 'card',
                  title: context.tr('wjEarningsNone'),
                  subtitle: context.tr('wjEarningsNoneSub'),
                  tileBg: const Color(0xFFEEF2F4),
                  tileFg: AppColors.slate,
                  verticalPadding: 40,
                )
              else
                Container(
                  clipBehavior: Clip.antiAlias,
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: AppColors.lineSoft),
                  ),
                  child: Column(
                    children: [
                      for (final j in recent.take(15))
                        Container(
                          key: Key('earned-${j.id}'),
                          padding: const EdgeInsets.symmetric(
                            horizontal: 16,
                            vertical: 13,
                          ),
                          decoration: const BoxDecoration(
                            border: Border(
                              bottom: BorderSide(color: AppColors.lineFaint),
                            ),
                          ),
                          child: Row(
                            children: [
                              const IconTile(
                                'check',
                                size: 38,
                                radius: 12,
                                iconSize: 18,
                                bg: AppColors.tealTint,
                                fg: AppColors.primary,
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      j.service.name(arabic: ar),
                                      style: ts(14, w: 600),
                                    ),
                                    const SizedBox(height: 2),
                                    Text(
                                      '${whenLabel(j.completedAt, arabic: ar, now: now)} · ${j.reference}',
                                      style: ts(12, c: AppColors.slate),
                                    ),
                                  ],
                                ),
                              ),
                              Text(
                                context.sar(j.money!.payoutHalalas / 100),
                                style: ts(14, w: 700, c: AppColors.primary),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}

class _Legend extends StatelessWidget {
  const _Legend({
    required this.color,
    required this.label,
    required this.value,
    this.bold = false,
  });

  final Color color;
  final String label;
  final String value;
  final bool bold;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Flexible(
          child: Row(
            children: [
              Container(
                width: 9,
                height: 9,
                decoration: BoxDecoration(
                  color: color,
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  label,
                  style: ts(
                    bold ? 15 : 14,
                    w: bold ? 700 : 400,
                    c: bold ? AppColors.text : AppColors.slate,
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 12),
        Text(
          value,
          style: ts(
            bold ? 15 : 14,
            w: bold ? 800 : 600,
            c: bold ? AppColors.primary : AppColors.text,
          ),
        ),
      ],
    );
  }
}
