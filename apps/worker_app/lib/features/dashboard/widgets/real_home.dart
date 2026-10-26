import 'package:flutter/material.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/jobs_scope.dart';
import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/saudi_time.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';
import '../../jobs/logic/worker_jobs_controller.dart';

/// The worker's home tab from real data: new requests to quote on and the jobs that are next. No earnings, ratings, online switch or
/// notification count: the backend has none of those yet, so none is shown.
class RealHome extends StatefulWidget {
  const RealHome({super.key, required this.active});

  /// Whether the Home tab is on screen (the shell keeps all tabs alive; this is how it knows to refresh).
  final bool active;

  @override
  State<RealHome> createState() => _RealHomeState();
}

class _RealHomeState extends State<RealHome> {
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
  void didUpdateWidget(RealHome old) {
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
    final app = context.app;
    final ar = context.isAr;
    final name = context.auth.user?.fullName?.trim() ?? '';
    return ListenableBuilder(
      listenable: jobs,
      builder: (context, _) {
        final fresh = jobs.newRequests;
        final next = jobs.jobsIn({
          'CONFIRMED',
          'IN_PROGRESS',
          'PAYMENT_PENDING',
        });
        final failed =
            jobs.requestsStatus == LoadStatus.failed &&
            jobs.jobsStatus == LoadStatus.failed;
        final loading =
            jobs.requestsStatus == LoadStatus.idle ||
            jobs.requestsStatus == LoadStatus.loading;
        return RefreshIndicator(
          onRefresh: jobs.refresh,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.only(top: 4, bottom: 28),
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 6, 20, 0),
                child: Row(
                  children: [
                    InitialsTile(
                      name.isEmpty
                          ? '•'
                          : String.fromCharCode(name.runes.first).toUpperCase(),
                      size: 48,
                      fontSize: 16,
                      radius: 16,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            context.tr('hello'),
                            style: ts(13.5, c: AppColors.slate),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            name.isEmpty ? context.tr('wjNoName') : name,
                            style: ts(19, w: 700),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              if (failed)
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 20, 20, 0),
                  child: Column(
                    children: [
                      Text(
                        context.tr('wjLoadFailed'),
                        key: const Key('home-failed'),
                        style: ts(14.5, c: AppColors.slate),
                      ),
                      const SizedBox(height: 12),
                      AppButton(
                        key: const Key('home-retry'),
                        label: context.tr('retry'),
                        expand: false,
                        height: 44,
                        padding: const EdgeInsets.symmetric(horizontal: 22),
                        onPressed: jobs.refresh,
                      ),
                    ],
                  ),
                )
              else if (loading)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 32),
                  child: Center(
                    child: CircularProgressIndicator(strokeWidth: 2.6),
                  ),
                )
              else ...[
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 24, 20, 12),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Row(
                        children: [
                          Text(
                            context.tr('newRequests'),
                            style: ts(18, w: 700),
                          ),
                          const SizedBox(width: 8),
                          Container(
                            constraints: const BoxConstraints(minWidth: 22),
                            height: 22,
                            padding: const EdgeInsets.symmetric(horizontal: 6),
                            alignment: Alignment.center,
                            decoration: BoxDecoration(
                              color: AppColors.gold,
                              borderRadius: BorderRadius.circular(11),
                            ),
                            child: Text(
                              '${fresh.length}',
                              key: const Key('home-new-count'),
                              style: ts(12, w: 800, family: kLatinFont),
                            ),
                          ),
                        ],
                      ),
                      Tap(
                        onTap: () => app.showTab(1, jobs: 0),
                        child: Text(
                          context.tr('seeAll'),
                          style: ts(14, w: 600, c: AppColors.primary),
                        ),
                      ),
                    ],
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                  child: fresh.isEmpty
                      ? EmptyState(
                          icon: 'calendar',
                          title: context.tr('wjNewEmpty'),
                          subtitle: context.tr('wjNewEmptySub'),
                          tileBg: const Color(0xFFEEF2F4),
                          tileFg: AppColors.slate,
                          verticalPadding: 24,
                        )
                      : Column(
                          children: [
                            for (final r in fresh.take(3)) ...[
                              _RequestRow(
                                key: Key('home-request-${r.id}'),
                                request: r,
                                onTap: () =>
                                    AppRouter.toRequestDetail(context, r),
                              ),
                              const SizedBox(height: 10),
                            ],
                          ],
                        ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 16, 20, 12),
                  child: Text(context.tr('wjNextJobs'), style: ts(18, w: 700)),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                  child: next.isEmpty
                      ? Text(
                          context.tr('wjNoNext'),
                          style: ts(13.5, c: AppColors.slate, h: 1.5),
                        )
                      : Column(
                          children: [
                            for (final j in next.take(3)) ...[
                              _JobRow(
                                key: Key('home-job-${j.id}'),
                                job: j,
                                ar: ar,
                                onTap: () => AppRouter.toJob(context, j.id),
                              ),
                              const SizedBox(height: 10),
                            ],
                          ],
                        ),
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}

String _area(BookingLocation l, bool ar) {
  final city = ar && l.cityNameAr.isNotEmpty ? l.cityNameAr : l.cityNameEn;
  return [
    if (l.district != null && l.district!.isNotEmpty) l.district!,
    city,
  ].where((p) => p.isNotEmpty).join(' · ');
}

class _RequestRow extends StatelessWidget {
  const _RequestRow({super.key, required this.request, required this.onTap});
  final WorkerRequest request;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ar = context.isAr;
    return AppCard(
      padding: const EdgeInsets.all(14),
      radius: 18,
      onTap: onTap,
      child: Row(
        children: [
          const IconTile('wrench', size: 44, radius: 14, iconSize: 20),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(request.service.name(arabic: ar), style: ts(15, w: 600)),
                const SizedBox(height: 2),
                Text(
                  '${_area(request.location, ar)} · ${windowLabel(request.preferredStartAt, request.preferredEndAt, arabic: ar)}',
                  style: ts(12.5, c: AppColors.slate),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          if (request.isUrgent)
            Pill(
              context.tr('wjUrgent'),
              bg: AppColors.cream,
              fg: AppColors.creamText,
              fontSize: 11.5,
              weight: 700,
            ),
        ],
      ),
    );
  }
}

class _JobRow extends StatelessWidget {
  const _JobRow({
    super.key,
    required this.job,
    required this.ar,
    required this.onTap,
  });
  final WorkerJob job;
  final bool ar;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final key = 'ws${job.status}';
    final status = context.tr(key) == key ? job.status : context.tr(key);
    return AppCard(
      padding: const EdgeInsets.all(14),
      radius: 18,
      onTap: onTap,
      child: Row(
        children: [
          const IconTile('wrench', size: 44, radius: 14, iconSize: 20),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(job.service.name(arabic: ar), style: ts(15, w: 600)),
                const SizedBox(height: 2),
                Text(
                  '${_area(job.location, ar)} · ${windowLabel(job.preferredStartAt, job.preferredEndAt, arabic: ar)}',
                  style: ts(12.5, c: AppColors.slate),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Pill(
            status,
            bg: AppColors.tealTint,
            fg: AppColors.primary,
            fontSize: 11.5,
            weight: 700,
          ),
        ],
      ),
    );
  }
}
