import 'package:flutter/material.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/jobs_scope.dart';
import '../../../app/localization/app_strings.dart';
import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/saudi_time.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/widgets/app_button.dart';
import '../logic/worker_jobs_controller.dart';
import 'job_card.dart';
import 'jobs_tab_chip.dart';

const kJobTabLabels = [
  Bi('New', 'جديدة'),
  Bi('Quoted', 'مسعّرة'),
  Bi('Upcoming', 'القادمة'),
  Bi('Active', 'النشطة'),
  Bi('Completed', 'المكتملة'),
  Bi('Cancelled', 'الملغاة'),
];

/// The backend states shown on each assigned-job tab (tabs 0 and 1 are open requests).
const Map<int, Set<String>> kJobTabStatuses = {
  2: {'PAYMENT_PENDING', 'CONFIRMED'},
  3: {'IN_PROGRESS'},
  4: {'COMPLETED'},
  5: {'CANCELLED', 'EXPIRED'},
};

/// The worker's real requests and jobs. Every list has its own loading, empty, failed (with retry) and "refresh failed" state.
class RealJobsView extends StatefulWidget {
  const RealJobsView({
    super.key,
    required this.selected,
    required this.onTab,
    required this.active,
  });

  final int selected;
  final ValueChanged<int> onTab;

  /// Whether the Jobs tab is the one on screen. The tab shell keeps every tab alive, so this is how the lists know to refresh.
  final bool active;

  @override
  State<RealJobsView> createState() => _RealJobsViewState();
}

class _RealJobsViewState extends State<RealJobsView> {
  WorkerJobsController? _jobs;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final jobs = JobsScope.of(context).jobs;
    if (!identical(jobs, _jobs)) {
      _jobs = jobs;
      if (widget.active) _refresh();
    }
  }

  @override
  void didUpdateWidget(RealJobsView old) {
    super.didUpdateWidget(old);
    if (widget.active && !old.active) _refresh();
  }

  void _refresh() {
    final jobs = _jobs;
    if (jobs == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) jobs.refresh();
    });
  }

  @override
  Widget build(BuildContext context) {
    final jobs = _jobs!;
    return ListenableBuilder(
      listenable: jobs,
      builder: (context, _) {
        final tab = widget.selected;
        final counts = [
          jobs.newRequests.length,
          jobs.quotedRequests.length,
          jobs.jobsIn(kJobTabStatuses[2]!).length,
          jobs.jobsIn(kJobTabStatuses[3]!).length,
          0,
          0,
        ];
        final requestsTab = tab < 2;
        final status = requestsTab ? jobs.requestsStatus : jobs.jobsStatus;
        final error = requestsTab ? jobs.requestsError : jobs.jobsError;
        final entries = requestsTab
            ? _requestEntries(context, jobs, tab)
            : _jobEntries(context, jobs, tab);
        final loadingFirst =
            status == LoadStatus.idle ||
            (status == LoadStatus.loading && entries.isEmpty);
        return Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 14),
              child: Align(
                alignment: AlignmentDirectional.centerStart,
                child: Text(context.tr('jobs'), style: ts(26, w: 700)),
              ),
            ),
            SizedBox(
              height: 42,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 20),
                children: [
                  for (var i = 0; i < kJobTabLabels.length; i++) ...[
                    if (i > 0) const SizedBox(width: 8),
                    JobsTabChip(
                      key: Key('jobs-tab-$i'),
                      label: context.l(kJobTabLabels[i]),
                      count: counts[i],
                      selected: i == tab,
                      onTap: () => widget.onTab(i),
                    ),
                  ],
                ],
              ),
            ),
            if (error != null && !loadingFirst && status == LoadStatus.ready)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 10, 20, 0),
                child: Text(
                  context.tr('wjRefreshFailed'),
                  key: const Key('jobs-refresh-failed'),
                  style: ts(12.5, c: AppColors.slate),
                ),
              ),
            Expanded(
              child: loadingFirst
                  ? const Center(
                      child: CircularProgressIndicator(strokeWidth: 2.6),
                    )
                  : status == LoadStatus.failed
                  ? _Failed(onRetry: jobs.refresh)
                  : RefreshIndicator(
                      onRefresh: jobs.refresh,
                      child: ListView(
                        physics: const AlwaysScrollableScrollPhysics(),
                        padding: const EdgeInsets.fromLTRB(20, 14, 20, 28),
                        children: [
                          for (final e in entries) ...[
                            JobCard(
                              job: e,
                              dateTimeLabel: context.tr('dateTime'),
                            ),
                            const SizedBox(height: 12),
                          ],
                          if (entries.isEmpty)
                            EmptyState(
                              key: Key('jobs-empty-$tab'),
                              icon: 'calendar',
                              title: tab == 0
                                  ? context.tr('wjNewEmpty')
                                  : context.tr('noJobs'),
                              subtitle: tab == 0
                                  ? context.tr('wjNewEmptySub')
                                  : context.tr('noJobsSub'),
                              tileBg: const Color(0xFFEEF2F4),
                              tileFg: AppColors.slate,
                              verticalPadding: 60,
                            ),
                        ],
                      ),
                    ),
            ),
          ],
        );
      },
    );
  }

  List<JobEntry> _requestEntries(
    BuildContext context,
    WorkerJobsController jobs,
    int tab,
  ) {
    final ar = context.isAr;
    final list = tab == 0 ? jobs.newRequests : jobs.quotedRequests;
    return [
      for (final r in list)
        JobEntry(
          icon: 'wrench',
          service: r.service.name(arabic: ar),
          subtitle: _area(r.location, ar),
          when: windowLabel(r.preferredStartAt, r.preferredEndAt, arabic: ar),
          status: tab == 0
              ? (r.isUrgent ? context.tr('wjUrgent') : context.tr('wsNew'))
              : _quoteStatus(context, r.myQuote!),
          badge: tab == 0
              ? JobBadge.fresh
              : (r.myQuote!.isLive ? JobBadge.fresh : JobBadge.done),
          amountLabel: tab == 0
              ? context.tr('wjExpires')
              : context.tr('wjYourQuote'),
          amount: tab == 0
              ? whenLabel(r.expiresAt, arabic: ar)
              : context.sar(r.myQuote!.money.service),
          buttonLabel: tab == 0 ? context.tr('wjReview') : context.tr('wjOpen'),
          softButton: tab != 0,
          onButton: () => AppRouter.toRequestDetail(context, r),
        ),
    ];
  }

  List<JobEntry> _jobEntries(
    BuildContext context,
    WorkerJobsController jobs,
    int tab,
  ) {
    final ar = context.isAr;
    return [
      for (final j in jobs.jobsIn(kJobTabStatuses[tab]!))
        JobEntry(
          icon: 'wrench',
          service: j.service.name(arabic: ar),
          // the customer's name is only released after payment
          subtitle: [
            if (j.customerName != null && j.customerName!.isNotEmpty)
              j.customerName!,
            _area(j.location, ar),
          ].join(' · '),
          when: windowLabel(j.preferredStartAt, j.preferredEndAt, arabic: ar),
          status: _jobStatus(context, j.status),
          badge: switch (j.status) {
            'CONFIRMED' || 'IN_PROGRESS' => JobBadge.active,
            'CANCELLED' || 'EXPIRED' => JobBadge.bad,
            'PAYMENT_PENDING' => JobBadge.fresh,
            _ => JobBadge.done,
          },
          amountLabel: j.status == 'COMPLETED'
              ? context.tr('wjYouReceive')
              : context.tr('wjYourQuote'),
          amount: j.money == null
              ? '—'
              : context.sar(
                  j.status == 'COMPLETED' ? j.money!.payout : j.money!.service,
                ),
          note: j.status == 'PAYMENT_PENDING'
              ? context.tr('wjWaitingPay')
              : (j.isCash &&
                        j.money != null &&
                        j.cashCollectedAt == null &&
                        j.status != 'CANCELLED'
                    ? context
                          .tr('wjCashDue')
                          .replaceAll('{total}', context.sar(j.money!.total))
                    : null),
          buttonLabel: tab == 2 || tab == 3 ? context.tr('wjOpen') : null,
          onButton: () => AppRouter.toJob(context, j.id),
        ),
    ];
  }
}

String _area(BookingLocation l, bool ar) {
  final city = ar && l.cityNameAr.isNotEmpty ? l.cityNameAr : l.cityNameEn;
  return [
    if (l.district != null && l.district!.isNotEmpty) l.district!,
    city,
  ].where((p) => p.isNotEmpty).join(' · ');
}

String _quoteStatus(BuildContext context, WorkerQuote q) {
  final status = q.isExpired && q.status == 'SUBMITTED' ? 'EXPIRED' : q.status;
  final key = 'wq$status';
  return context.tr(key) == key ? status : context.tr(key);
}

String _jobStatus(BuildContext context, String status) {
  final key = 'ws$status';
  return context.tr(key) == key ? status : context.tr(key);
}

class _Failed extends StatelessWidget {
  const _Failed({required this.onRetry});
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              context.tr('wjLoadFailed'),
              key: const Key('jobs-failed'),
              textAlign: TextAlign.center,
              style: ts(15, c: AppColors.slate),
            ),
            const SizedBox(height: 14),
            AppButton(
              key: const Key('jobs-retry'),
              label: context.tr('retry'),
              expand: false,
              height: 44,
              padding: const EdgeInsets.symmetric(horizontal: 22),
              onPressed: onRetry,
            ),
          ],
        ),
      ),
    );
  }
}
