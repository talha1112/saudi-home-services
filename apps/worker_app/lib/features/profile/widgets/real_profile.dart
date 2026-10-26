import 'package:flutter/material.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/app_scope.dart';
import '../../../app/jobs_scope.dart';
import '../../../app/onboarding_scope.dart';
import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/inputs.dart';
import '../../../shared/components/language_dialog.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';
import '../../verification/utils/onboarding_text.dart';

String _initials(String name) {
  final parts = name
      .trim()
      .split(RegExp(r'\s+'))
      .where((p) => p.isNotEmpty)
      .toList();
  if (parts.isEmpty) return '•';
  final first = String.fromCharCode(parts.first.runes.first).toUpperCase();
  return parts.length == 1
      ? first
      : first + String.fromCharCode(parts.last.runes.first).toUpperCase();
}

const _daysEn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const _daysAr = [
  'الأحد',
  'الإثنين',
  'الثلاثاء',
  'الأربعاء',
  'الخميس',
  'الجمعة',
  'السبت',
];

/// "08:00" as "8:00 AM".
String _hour(String hhmm, bool ar) {
  final p = hhmm.split(':');
  final h = int.tryParse(p.first) ?? 0;
  final m = p.length > 1 ? p[1] : '00';
  final h12 = h % 12 == 0 ? 12 : h % 12;
  return '$h12:$m ${h < 12 ? (ar ? 'ص' : 'AM') : (ar ? 'م' : 'PM')}';
}

/// "Sun, Mon, Tue · 8:00 AM – 5:00 PM": the days that share the same hours are grouped.
List<String> describeSchedule(List<AvailabilityWindow> windows, bool ar) {
  final byHours = <String, List<int>>{};
  for (final w in windows) {
    byHours
        .putIfAbsent('${w.startTime}-${w.endTime}', () => [])
        .add(w.dayOfWeek);
  }
  return [
    for (final e in byHours.entries)
      '${(e.value..sort()).map((d) => (ar ? _daysAr : _daysEn)[d % 7]).join(ar ? '، ' : ', ')} · ${_hour(e.key.split('-')[0], ar)} – ${_hour(e.key.split('-')[1], ar)}',
  ];
}

/// The worker's profile in a real build: everything on it is the application and the account as the server has them. Nothing here is
/// invented: no payout account, no plan, no ratings that were never given.
class RealProfile extends StatefulWidget {
  const RealProfile({super.key});

  @override
  State<RealProfile> createState() => _RealProfileState();
}

class _RealProfileState extends State<RealProfile> {
  JobsServices? _services;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final next = JobsScope.of(context);
    if (identical(next, _services)) return;
    _services = next;
    final onboarding = OnboardingScope.read(context);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !context.auth.isSignedIn) return;
      onboarding.refresh();
      onboarding.loadCatalog();
      next.reviews.load();
      next.jobs.loadJobs();
      next.notifications.refreshUnread();
    });
  }

  @override
  Widget build(BuildContext context) {
    final services = _services!;
    final onboarding = OnboardingScope.of(context);
    return ListenableBuilder(
      listenable: Listenable.merge([
        services.reviews,
        services.jobs,
        services.notifications,
      ]),
      builder: (context, _) => _content(context, services, onboarding),
    );
  }

  Widget _content(
    BuildContext context,
    JobsServices services,
    WorkerOnboardingController onboarding,
  ) {
    final app = AppScope.of(context);
    final ar = context.isAr;
    final data = onboarding.onboarding;
    final profile = data?.profile;
    final accountName = context.auth.user?.fullName?.trim() ?? '';
    final name =
        (ar ? (profile?.fullNameAr ?? profile?.fullName) : profile?.fullName)
                ?.trim()
                .isNotEmpty ==
            true
        ? (ar ? (profile?.fullNameAr ?? profile?.fullName) : profile?.fullName)!
              .trim()
        : accountName;
    final state =
        onboarding.verification?.state ??
        VerificationState.parse(context.auth.user?.workerVerificationStatus);
    final approved = state == VerificationState.approved;
    final catalog = onboarding.catalog;
    final reviews = services.reviews.reviews;
    final done = services.jobs.jobs
        .where((j) => j.status == 'COMPLETED')
        .length;
    final unread = services.notifications.unread;
    final years = profile?.yearsOfExperience;

    final serviceNames = <(String, String)>[
      for (final c in catalog?.categories ?? const <CatalogCategory>[])
        for (final s in c.services)
          if (data?.serviceIds.contains(s.id) ?? false)
            (
              c.iconKey ?? '',
              ar ? (s.nameAr.isEmpty ? s.nameEn : s.nameAr) : s.nameEn,
            ),
    ];
    final cityNames = [
      for (final c in catalog?.cities ?? const <City>[])
        if (data?.cityIds.contains(c.id) ?? false)
          (ar ? (c.nameAr.isEmpty ? c.nameEn : c.nameAr) : c.nameEn),
    ];
    final schedule = describeSchedule(data?.availability ?? const [], ar);
    final docs = data?.documents ?? const <WorkerDocument>[];

    Widget block({
      required Widget child,
      EdgeInsetsGeometry padding = const EdgeInsets.all(16),
      double radius = 20,
    }) => Container(
      clipBehavior: Clip.antiAlias,
      padding: padding,
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: AppColors.lineSoft),
      ),
      child: child,
    );
    Widget small(String text) =>
        Text(text, style: ts(12.5, w: 600, c: AppColors.slate));
    Widget stat(String v, String k) => Expanded(
      child: Column(
        children: [
          Text(v, style: ts(19, w: 700)),
          const SizedBox(height: 3),
          Text(k, style: ts(11.5, c: AppColors.slate)),
        ],
      ),
    );
    String icon(String key) => switch (key) {
      'bolt' || 'zap' => 'zap',
      'droplet' => 'droplet',
      'snowflake' => 'snowflake',
      _ => 'wrench',
    };

    final rows = <(String, String, String, VoidCallback?)>[
      (
        'file',
        context.tr('profDocuments'),
        docs.isEmpty ? '' : Ob.stateBadge(state, ar),
        () => AppRouter.toStatus(context),
      ),
      (
        'bell',
        context.tr('notifications'),
        unread > 0 ? context.tr('profNew').replaceAll('{n}', '$unread') : '',
        () => AppRouter.toNotifications(context),
      ),
      ('help', context.tr('profHelp'), '', () => AppRouter.toSupport(context)),
      (
        'logout',
        context.tr('profLogout'),
        '',
        () async {
          // Ends the server session and push registration first, then returns to the welcome screen.
          await context.authRead.signOut();
          if (context.mounted) AppRouter.toWelcomeReset(context);
        },
      ),
    ];

    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 6, 20, 28),
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text(context.tr('profile'), style: ts(26, w: 700)),
        ),
        const SizedBox(height: 16),
        block(
          radius: 24,
          padding: const EdgeInsets.all(18),
          child: Column(
            children: [
              Row(
                children: [
                  Stack(
                    clipBehavior: Clip.none,
                    children: [
                      InitialsTile(
                        _initials(name),
                        size: 68,
                        fontSize: 22,
                        radius: 22,
                      ),
                      if (approved)
                        PositionedDirectional(
                          bottom: -4,
                          end: -4,
                          child: Container(
                            width: 26,
                            height: 26,
                            alignment: Alignment.center,
                            decoration: const BoxDecoration(
                              color: Colors.white,
                              shape: BoxShape.circle,
                            ),
                            child: const AppIcon(
                              'verified',
                              size: 20,
                              color: AppColors.primary,
                            ),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          name.isEmpty ? context.tr('wjNoName') : name,
                          key: const Key('profile-name'),
                          style: ts(18, w: 700),
                        ),
                        const SizedBox(height: 4),
                        Pill(
                          approved
                              ? context.tr('verifiedPro')
                              : Ob.stateBadge(state, ar),
                          key: const Key('profile-status'),
                          icon: approved ? 'shield' : 'clock',
                          bg: approved ? AppColors.tealTint : AppColors.cream,
                          fg: approved
                              ? AppColors.primary
                              : const Color(0xFFB07A10),
                          fontSize: 11.5,
                          weight: 700,
                          radius: 7,
                          padding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 3,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              Container(
                padding: const EdgeInsets.only(top: 14),
                decoration: const BoxDecoration(
                  border: Border(top: BorderSide(color: AppColors.lineFaint)),
                ),
                child: Row(
                  children: [
                    stat(
                      reviews?.average != null ? '${reviews!.average}' : '—',
                      context.tr('profRating'),
                    ),
                    stat('$done', context.tr('profJobsDone')),
                    stat(
                      years == null
                          ? '—'
                          : context.tr('profYears').replaceAll('{n}', '$years'),
                      context.tr('profExperience'),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        block(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              small(context.tr('services')),
              const SizedBox(height: 8),
              if (serviceNames.isEmpty)
                Text(
                  context.tr('profNoServices'),
                  key: const Key('profile-no-services'),
                  style: ts(14, c: AppColors.slate),
                )
              else
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final s in serviceNames)
                      Container(
                        height: 32,
                        padding: const EdgeInsets.symmetric(horizontal: 11),
                        decoration: BoxDecoration(
                          color: AppColors.tealTint,
                          borderRadius: BorderRadius.circular(16),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            AppIcon(
                              icon(s.$1),
                              size: 14,
                              color: AppColors.primary,
                            ),
                            const SizedBox(width: 5),
                            Text(
                              s.$2,
                              style: ts(13, w: 600, c: AppColors.primary),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
              const SizedBox(height: 14),
              small(context.tr('serviceArea')),
              const SizedBox(height: 8),
              Text(
                cityNames.isEmpty
                    ? context.tr('profNoServices')
                    : cityNames.join(ar ? '، ' : ', '),
                key: const Key('profile-areas'),
                style: ts(14, w: 500, h: 1.5),
              ),
              const SizedBox(height: 14),
              small(context.tr('availability')),
              const SizedBox(height: 8),
              if (schedule.isEmpty)
                Text(
                  context.tr('profNoServices'),
                  style: ts(14, c: AppColors.slate),
                )
              else
                for (final line in schedule)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 4),
                    child: Text(
                      line,
                      key: const Key('profile-schedule'),
                      style: ts(14, w: 500),
                    ),
                  ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(context.tr('reviewsT'), style: ts(16, w: 700)),
            if (reviews != null && reviews.count > 0)
              RatingInline(
                rating: '${reviews.average}',
                trailing: ' · ${reviews.count}',
                size: 13,
                fontSize: 13,
                boldRating: false,
                ratingColor: AppColors.slate,
              ),
          ],
        ),
        const SizedBox(height: 16),
        if (reviews == null || reviews.items.isEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: Text(
              context.tr('profNoReviews'),
              key: const Key('profile-no-reviews'),
              style: ts(13.5, c: AppColors.slate),
            ),
          )
        else
          for (final r in reviews.items) ...[
            AppCard(
              key: Key('review-${r.id}'),
              padding: const EdgeInsets.all(14),
              radius: 18,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      for (var i = 1; i <= 5; i++)
                        Padding(
                          padding: const EdgeInsetsDirectional.only(end: 2),
                          child: AppIcon(
                            'star',
                            size: 12,
                            color: AppColors.gold,
                            filled: i <= r.rating,
                            strokeWidth: 1.6,
                          ),
                        ),
                    ],
                  ),
                  if ((r.comment ?? '').isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Text(
                      r.comment!,
                      style: ts(13.5, c: AppColors.slate, h: 1.5),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 16),
          ],
        block(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          child: Column(
            children: [
              Row(
                children: [
                  const IconTile(
                    'globe',
                    size: 38,
                    radius: 12,
                    iconSize: 19,
                    bg: AppColors.chip,
                    fg: AppColors.text,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(context.tr('language'), style: ts(15, w: 600)),
                  ),
                  Tap(
                    onTap: () => showLanguageDialog(context),
                    child: Text(
                      ar ? 'العربية' : 'English',
                      style: ts(13.5, w: 600, c: AppColors.primary),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              SegmentedTabs(
                labels: const ['English', 'العربية'],
                labelFamilies: const ['Archivo', 'Tajawal'],
                selected: ar ? 1 : 0,
                height: 42,
                radius: 11,
                outerRadius: 14,
                fontSize: 14,
                onChanged: (i) => app.setArabic(i == 1),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        block(
          padding: EdgeInsets.zero,
          child: Column(
            children: [
              for (var i = 0; i < rows.length; i++)
                Tap(
                  key: Key('profile-row-${rows[i].$1}'),
                  onTap: rows[i].$4,
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 12,
                    ),
                    decoration: BoxDecoration(
                      border: i == rows.length - 1
                          ? null
                          : const Border(
                              bottom: BorderSide(color: AppColors.lineFaint),
                            ),
                    ),
                    child: Row(
                      children: [
                        IconTile(
                          rows[i].$1,
                          size: 38,
                          radius: 12,
                          iconSize: 18,
                          bg: AppColors.chip,
                          fg: AppColors.text,
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Text(rows[i].$2, style: ts(15, w: 500)),
                        ),
                        if (rows[i].$3.isNotEmpty) ...[
                          Text(rows[i].$3, style: ts(13, c: AppColors.slate)),
                          const SizedBox(width: 12),
                        ],
                        AppIcon(
                          context.forwardIcon,
                          size: 18,
                          color: AppColors.muted,
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}
