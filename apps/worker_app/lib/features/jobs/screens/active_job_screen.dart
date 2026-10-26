import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart' show LatLng;
import 'package:hs_client/hs_client.dart';
import 'package:url_launcher/url_launcher.dart';

import 'dart:async';

import '../../../app/jobs_scope.dart';
import '../../../app/router/app_router.dart';
import '../../messages/widgets/chat_target.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/saudi_time.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/sheets.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tiles.dart';
import '../../../shared/widgets/tap.dart';
import '../logic/position_sharer.dart';
import '../logic/worker_jobs_controller.dart';
import '../services/directions.dart';
import '../widgets/job_location_map.dart';

/// Opens a link such as `tel:` (replaced in tests).
typedef LinkOpener = Future<bool> Function(Uri uri);

Future<bool> _openLink(Uri uri) async {
  try {
    return await launchUrl(uri);
  } catch (_) {
    return false;
  }
}

/// A job assigned to this worker, as the backend returns it (`GET /workers/me/bookings/:id`).
///
/// What is on screen is what the backend released:
///  * before the customer has paid (PAYMENT_PENDING) only the city and district, no street, no exact point, no customer name or phone;
///  * once paid (CONFIRMED) also the address, the exact point (a real map pin and directions) and the customer's name and phone.
/// No coordinate is ever made up: without a released point the map is the illustration and Navigate says there is no location.
class ActiveJobScreen extends StatefulWidget {
  const ActiveJobScreen({
    super.key,
    required this.jobId,
    this.directions = const UrlDirectionsLauncher(),
    this.mapBuilder,
    this.mapsEnabled,
    this.openLink = _openLink,
  });

  final String jobId;

  /// Opens turn-by-turn directions (replaced in tests).
  final DirectionsLauncher directions;

  /// Replaces the Google map widget in tests (a platform view cannot run there).
  final Widget Function(LatLng target)? mapBuilder;

  /// Overrides "a Maps key was supplied" (tests).
  final bool? mapsEnabled;

  final LinkOpener openLink;

  @override
  State<ActiveJobScreen> createState() => _ActiveJobScreenState();
}

enum _Load { loading, ready, failed, gone }

class _ActiveJobScreenState extends State<ActiveJobScreen> {
  _Load _load = _Load.loading;
  bool _started = false;
  Timer? _poll;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_started) {
      _started = true;
      final cached = JobsScope.of(context).jobs.jobById(widget.jobId);
      if (cached != null) {
        _load = _Load.ready; // show it at once; the refresh below replaces it
      }
      _refresh();
      // The customer cancels, an administrator acts, payment arrives: the job on screen follows without a tap.
      _poll = Timer.periodic(const Duration(seconds: 8), (_) {
        if (mounted) {
          JobsScope.of(
            context,
          ).jobs.reloadJob(widget.jobId).then((_) {}, onError: (_) {});
        }
      });
    }
  }

  Future<void> _refresh() async {
    final hadJob = JobsScope.of(context).jobs.jobById(widget.jobId) != null;
    if (!hadJob) setState(() => _load = _Load.loading);
    try {
      await JobsScope.of(context).jobs.reloadJob(widget.jobId);
      if (mounted) setState(() => _load = _Load.ready);
    } on ApiException catch (e) {
      if (!mounted) return;
      // a failed refresh keeps a job we already have; a job that is not this worker's is gone
      setState(
        () => _load = e.status == 404
            ? _Load.gone
            : (hadJob ? _Load.ready : _Load.failed),
      );
    }
  }

  Future<void> _navigate(BuildContext context, BookingLocation place) async {
    final messenger = ScaffoldMessenger.of(context);
    final lat = place.latitude;
    final lng = place.longitude;
    final String? problem;
    if (!validCoordinates(lat, lng)) {
      problem = context.tr('navNoLocation');
    } else if (!await widget.directions.open(lat!, lng!)) {
      problem = context.mounted ? context.tr('navFailed') : null;
    } else {
      problem = null;
    }
    if (problem != null) {
      messenger.showSnackBar(SnackBar(content: Text(problem)));
    }
  }

  Future<void> _act(WorkerJob job) async {
    final jobs = JobsScope.of(context).jobs;
    final messenger = ScaffoldMessenger.of(context);
    // decide from the job as it is NOW (the button on screen may be a moment old)
    final current = jobs.jobById(job.id) ?? job;
    if (!current.canStart && !current.canComplete) return;
    final outcome = current.canStart
        ? await jobs.startJob(current.id)
        : await jobs.completeJob(current.id);
    if (!mounted) return;
    final key = switch (outcome) {
      JobActionOutcome.done => null,
      JobActionOutcome.network => 'wjActNetwork',
      JobActionOutcome.wrongState => 'wjActWrongState',
      JobActionOutcome.notFound => 'wjActNotFound',
      JobActionOutcome.notSignedIn => 'weNotSignedIn',
      JobActionOutcome.unavailable => 'weBusy',
      JobActionOutcome.failed => 'wjActFailed',
    };
    if (key != null) {
      messenger.showSnackBar(SnackBar(content: Text(context.tr(key))));
    }
    if (outcome == JobActionOutcome.notFound) {
      setState(() => _load = _Load.gone);
    }
  }

  Future<void> _collect(WorkerJob job) async {
    final jobs = JobsScope.of(context).jobs;
    final messenger = ScaffoldMessenger.of(context);
    // decide from the job as it is NOW (the button on screen may be a moment old)
    final current = jobs.jobById(job.id) ?? job;
    if (!current.canConfirmCash) return;
    final outcome = await jobs.confirmCash(current.id);
    if (!mounted) return;
    final key = switch (outcome) {
      JobActionOutcome.done => null,
      JobActionOutcome.network => 'wjActNetwork',
      JobActionOutcome.wrongState => 'wjActWrongState',
      JobActionOutcome.notFound => 'wjActNotFound',
      JobActionOutcome.notSignedIn => 'weNotSignedIn',
      JobActionOutcome.unavailable => 'weBusy',
      JobActionOutcome.failed => 'wjActFailed',
    };
    if (key != null) {
      messenger.showSnackBar(SnackBar(content: Text(context.tr(key))));
    }
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final jobs = JobsScope.of(context).jobs;
    final top = MediaQuery.paddingOf(context).top;
    return ListenableBuilder(
      listenable: jobs,
      builder: (context, _) {
        final job = jobs.jobById(widget.jobId);
        if (job == null) return _Placeholder(load: _load, onRetry: _refresh);
        return _body(context, job, jobs, top);
      },
    );
  }

  Widget _body(
    BuildContext context,
    WorkerJob job,
    WorkerJobsController jobs,
    double top,
  ) {
    final ar = context.isAr;
    final place = job.location;
    final paid = job.status != 'PAYMENT_PENDING';
    final acting = jobs.isActing(job.id);
    final actionLabel = job.canStart
        ? context.tr('wjStartJob')
        : (job.canComplete ? context.tr('wjCompleteJob') : null);
    final contact = job.customerName ?? '';
    final address = [
      place.addressLine,
      place.building,
    ].where((p) => p != null && p.isNotEmpty).join(' · ');
    final area = [
      if (place.district != null && place.district!.isNotEmpty) place.district!,
      ar && place.cityNameAr.isNotEmpty ? place.cityNameAr : place.cityNameEn,
    ].where((p) => p.isNotEmpty).join(' · ');
    return Scaffold(
      backgroundColor: Colors.white,
      body: Stack(
        children: [
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            height: 330 + top,
            child: JobLocationMap(
              latitude: place.latitude,
              longitude: place.longitude,
              mapsEnabled: widget.mapsEnabled,
              mapBuilder: widget.mapBuilder ?? JobLocationMap.googleMap,
            ),
          ),
          PositionedDirectional(
            top: top + 6,
            start: 20,
            child: SquareIconButton.back(
              context,
              bordered: false,
              shadow: true,
            ),
          ),
          PositionedDirectional(
            top: top + 6,
            end: 20,
            child: Semantics(
              label: context.tr('navigate'),
              button: true,
              child: SquareIconButton(
                key: const Key('navigate-button'),
                icon: 'locate',
                bg: AppColors.text,
                fg: Colors.white,
                bordered: false,
                shadow: true,
                onTap: () => _navigate(context, place),
              ),
            ),
          ),
          Positioned(
            top: 280 + top,
            left: 0,
            right: 0,
            bottom: 0,
            child: Container(
              decoration: const BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
                boxShadow: [
                  BoxShadow(
                    color: Color(0x1A172B35),
                    blurRadius: 30,
                    offset: Offset(0, -8),
                  ),
                ],
              ),
              child: ClipRRect(
                borderRadius: const BorderRadius.vertical(
                  top: Radius.circular(28),
                ),
                child: Column(
                  children: [
                    Expanded(
                      child: ListView(
                        padding: const EdgeInsets.fromLTRB(20, 10, 20, 16),
                        children: [
                          const SheetHandle(),
                          const SizedBox(height: 14),
                          Text.rich(
                            TextSpan(
                              style: ts(12.5, c: AppColors.slate),
                              children: [
                                TextSpan(
                                  text: '${job.service.name(arabic: ar)} · ',
                                ),
                                TextSpan(
                                  text: job.reference,
                                  style: ts(
                                    12.5,
                                    c: AppColors.slate,
                                    family: kLatinFont,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            _statusText(context, job.status),
                            key: const Key('job-status'),
                            style: ts(22, w: 700),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            windowLabel(
                              job.preferredStartAt,
                              job.preferredEndAt,
                              arabic: ar,
                            ),
                            style: ts(13.5, c: AppColors.slate),
                          ),
                          _SharingLine(job: job),
                          const SizedBox(height: 14),
                          if (!paid) ...[
                            Container(
                              key: const Key('waiting-payment'),
                              padding: const EdgeInsets.all(14),
                              decoration: BoxDecoration(
                                color: AppColors.cream,
                                borderRadius: BorderRadius.circular(16),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    context.tr('wjWaitingPay'),
                                    style: ts(
                                      14.5,
                                      w: 700,
                                      c: AppColors.creamText,
                                    ),
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    context.tr('wjWaitingPaySub'),
                                    style: ts(
                                      13,
                                      c: AppColors.creamText,
                                      h: 1.45,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(height: 14),
                          ],
                          AppCard(
                            padding: const EdgeInsets.all(12),
                            radius: 18,
                            child: Row(
                              children: [
                                InitialsTile(
                                  contact.isEmpty
                                      ? '•'
                                      : String.fromCharCode(
                                          contact.runes.first,
                                        ).toUpperCase(),
                                  size: 46,
                                  fontSize: 16,
                                  radius: 15,
                                  bg: AppColors.chip,
                                  fg: AppColors.text,
                                ),
                                const SizedBox(width: 12),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        contact.isEmpty
                                            ? context.tr('wjCustomer')
                                            : contact,
                                        key: const Key('job-customer'),
                                        style: ts(15, w: 600),
                                      ),
                                      const SizedBox(height: 2),
                                      Text(
                                        address.isNotEmpty ? address : area,
                                        key: const Key('job-address'),
                                        style: ts(12.5, c: AppColors.slate),
                                        maxLines: 2,
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                      if (job.customerPhone != null &&
                                          job.customerPhone!.isNotEmpty) ...[
                                        const SizedBox(height: 2),
                                        Directionality(
                                          textDirection: TextDirection.ltr,
                                          child: Text(
                                            job.customerPhone!,
                                            key: const Key('job-phone'),
                                            style: ts(
                                              12.5,
                                              c: AppColors.slate,
                                              family: kLatinFont,
                                            ),
                                          ),
                                        ),
                                      ],
                                    ],
                                  ),
                                ),
                                if (job.customerPhone != null &&
                                    job.customerPhone!.isNotEmpty) ...[
                                  const SizedBox(width: 8),
                                  SquareIconButton(
                                    key: const Key('call-button'),
                                    icon: 'phone',
                                    iconSize: 19,
                                    bg: AppColors.tealTint,
                                    fg: AppColors.primary,
                                    bordered: false,
                                    onTap: () => widget.openLink(
                                      Uri(
                                        scheme: 'tel',
                                        path: job.customerPhone,
                                      ),
                                    ),
                                  ),
                                ],
                                if (paid) ...[
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
                                        bookingId: job.id,
                                        peerName: contact.isEmpty
                                            ? context.tr('wjCustomer')
                                            : contact,
                                        subtitle: job.service.name(arabic: ar),
                                        peerPhone: job.customerPhone,
                                      ),
                                    ),
                                  ),
                                ],
                              ],
                            ),
                          ),
                          if (paid &&
                              place.locationNotes != null &&
                              place.locationNotes!.isNotEmpty) ...[
                            const SizedBox(height: 10),
                            Text(
                              place.locationNotes!,
                              key: const Key('job-notes'),
                              style: ts(13, c: AppColors.slate, h: 1.45),
                            ),
                          ],
                          if (paid && !place.hasExactPoint) ...[
                            const SizedBox(height: 10),
                            Text(
                              context.tr('wjNoPoint'),
                              key: const Key('job-no-point'),
                              style: ts(12.5, c: AppColors.slate, h: 1.45),
                            ),
                          ],
                          if (job.isCash && paid && job.money != null) ...[
                            const SizedBox(height: 14),
                            Container(
                              key: const Key('cash-card'),
                              padding: const EdgeInsets.all(14),
                              decoration: BoxDecoration(
                                color: AppColors.cream,
                                borderRadius: BorderRadius.circular(16),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    context
                                        .tr('wjCashDue')
                                        .replaceAll(
                                          '{total}',
                                          context.sar(job.money!.total),
                                        ),
                                    key: const Key('cash-due'),
                                    style: ts(
                                      14.5,
                                      w: 700,
                                      c: AppColors.creamText,
                                    ),
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    job.cashCollectedAt != null
                                        ? context.tr('wjCashDone')
                                        : context.tr('wjCashHint'),
                                    key: const Key('cash-state'),
                                    style: ts(
                                      13,
                                      c: AppColors.creamText,
                                      h: 1.45,
                                    ),
                                  ),
                                  if (job.canConfirmCash) ...[
                                    const SizedBox(height: 10),
                                    AppButton(
                                      key: const Key('cash-collected'),
                                      label: context.tr('wjCashCollect'),
                                      height: 44,
                                      radius: 14,
                                      fontSize: 14.5,
                                      enabled: !acting,
                                      onPressed: () => _collect(job),
                                    ),
                                  ],
                                ],
                              ),
                            ),
                          ],
                          if (job.problemDescription != null &&
                              job.problemDescription!.isNotEmpty) ...[
                            const SizedBox(height: 14),
                            Text(context.tr('issue'), style: ts(15, w: 700)),
                            const SizedBox(height: 8),
                            Text(
                              job.problemDescription!,
                              style: ts(14, h: 1.5),
                            ),
                          ],
                          if (job.money != null) ...[
                            const SizedBox(height: 14),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 14,
                                vertical: 12,
                              ),
                              decoration: BoxDecoration(
                                color: AppColors.background,
                                borderRadius: BorderRadius.circular(14),
                              ),
                              child: Row(
                                mainAxisAlignment:
                                    MainAxisAlignment.spaceBetween,
                                children: [
                                  Text(
                                    context.tr('agreedPrice'),
                                    style: ts(13.5, c: AppColors.slate),
                                  ),
                                  Flexible(
                                    child: Text.rich(
                                      TextSpan(
                                        style: ts(13.5, w: 700),
                                        children: [
                                          TextSpan(
                                            text:
                                                '${context.sar(job.money!.service)} · ',
                                          ),
                                          TextSpan(
                                            text:
                                                '${context.tr('youEarn')} ${context.sar(job.money!.payout)}',
                                            style: ts(
                                              13.5,
                                              w: 700,
                                              c: AppColors.primary,
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                          if (job.status == 'COMPLETED') ...[
                            const SizedBox(height: 14),
                            Container(
                              key: const Key('job-finished'),
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
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          context.tr('wjFinished'),
                                          style: ts(
                                            15,
                                            w: 700,
                                            c: AppColors.tealDeep,
                                          ),
                                        ),
                                        const SizedBox(height: 3),
                                        Text(
                                          context.tr('wjFinishedSub'),
                                          style: ts(
                                            13,
                                            c: AppColors.tealDeep,
                                            h: 1.45,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    if (actionLabel != null)
                      Container(
                        padding: EdgeInsets.fromLTRB(
                          20,
                          12,
                          20,
                          (context.bottomInset > 0 ? context.bottomInset : 12) +
                              12,
                        ),
                        decoration: const BoxDecoration(
                          border: Border(
                            top: BorderSide(color: AppColors.lineSoft),
                          ),
                        ),
                        child: AppButton(
                          key: const Key('job-action'),
                          label: actionLabel,
                          enabled: !acting,
                          background: job.canComplete
                              ? AppColors.text
                              : AppColors.primary,
                          onPressed: () => _act(job),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _statusText(BuildContext context, String status) {
    final key = 'ws$status';
    return context.tr(key) == key ? status : context.tr(key);
  }
}

class _Placeholder extends StatelessWidget {
  const _Placeholder({required this.load, required this.onRetry});

  final _Load load;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 6, 20, 0),
              child: Align(
                alignment: AlignmentDirectional.centerStart,
                child: SquareIconButton.back(context),
              ),
            ),
            Expanded(
              child: Center(
                child: switch (load) {
                  _Load.loading || _Load.ready =>
                    const CircularProgressIndicator(strokeWidth: 2.6),
                  _Load.gone => Text(
                    context.tr('wjJobGone'),
                    key: const Key('job-gone'),
                    style: ts(15, c: AppColors.slate),
                  ),
                  _Load.failed => Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        context.tr('wjLoadFailed'),
                        key: const Key('job-failed'),
                        style: ts(15, c: AppColors.slate),
                      ),
                      const SizedBox(height: 14),
                      AppButton(
                        key: const Key('job-retry'),
                        label: context.tr('retry'),
                        expand: false,
                        height: 44,
                        padding: const EdgeInsets.symmetric(horizontal: 22),
                        onPressed: onRetry,
                      ),
                    ],
                  ),
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Whether the customer can see the worker on their map right now, and a way to fix it when location is off.
class _SharingLine extends StatelessWidget {
  const _SharingLine({required this.job});

  final WorkerJob job;

  @override
  Widget build(BuildContext context) {
    final sharer = JobsScope.of(context).sharer;
    return ListenableBuilder(
      listenable: sharer,
      builder: (context, _) {
        if (!sharer.wantsPosition(job)) return const SizedBox.shrink();
        final (text, action) = switch (sharer.state) {
          SharingState.sharing => (context.tr('wjShare'), false),
          SharingState.needsPermission => (context.tr('wjShareOff'), true),
          SharingState.trying => (context.tr('wjShareTrying'), false),
          SharingState.idle => ('', false),
        };
        if (text.isEmpty) return const SizedBox.shrink();
        return Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Row(
            children: [
              AppIcon(
                'locate',
                size: 15,
                color: action ? AppColors.danger : AppColors.primary,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  text,
                  key: const Key('sharing-status'),
                  style: ts(
                    12.5,
                    c: action ? AppColors.danger : AppColors.primary,
                  ),
                ),
              ),
              if (action)
                Tap(
                  key: const Key('sharing-fix'),
                  onTap: sharer.fixPermission,
                  child: Text(
                    context.tr('wjShareTurnOn'),
                    style: ts(12.5, w: 700, c: AppColors.primary),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}
