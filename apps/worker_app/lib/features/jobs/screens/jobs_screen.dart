import 'package:flutter/material.dart';

import '../../../app/app_state.dart';
import '../../../app/localization/app_strings.dart';
import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/config/demo_data.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/models/worker_data.dart';
import '../widgets/job_card.dart';
import '../widgets/jobs_tab_chip.dart';
import '../widgets/real_jobs_view.dart';

const _tabLabels = [
  Bi('New', 'جديدة'),
  Bi('Quoted', 'مسعّرة'),
  Bi('Upcoming', 'القادمة'),
  Bi('Active', 'النشطة'),
  Bi('Completed', 'المكتملة'),
  Bi('Cancelled', 'الملغاة'),
];

class JobsScreen extends StatelessWidget {
  const JobsScreen({super.key});

  JobEntry _entry(
    BuildContext context, {
    required String icon,
    required Bi service,
    required Bi customer,
    required Bi area,
    required String when,
    required Bi status,
    required JobBadge badge,
    required Bi amountLabel,
    required num amount,
    String? note,
    String? button,
    VoidCallback? onButton,
    bool soft = false,
  }) {
    return JobEntry(
      icon: icon,
      service: context.l(service),
      subtitle: '${context.l(customer)} · ${context.l(area)}',
      when: when,
      status: context.l(status),
      badge: badge,
      amountLabel: context.l(amountLabel),
      amount: context.sar(amount),
      note: note,
      buttonLabel: button,
      onButton: onButton,
      softButton: soft,
    );
  }

  List<List<JobEntry>> _build(BuildContext context, AppState app) {
    final ar = context.isAr;
    final r = kRequests.first;
    final pending = app.quoteState == QuoteState.pending;
    final accepted = app.quoteAccepted;
    final rejected = app.quoteState == QuoteState.rejected;
    const agreed = Bi('Agreed price', 'السعر المتفق');
    const earned = Bi('You earned', 'ربحك');
    const yourQuote = Bi('Your quote', 'عرضك');

    JobEntry forRequest({
      required Bi status,
      required JobBadge badge,
      required Bi label,
      required num amount,
      String? note,
      String? button,
      VoidCallback? onButton,
      bool soft = false,
      String? when,
    }) => _entry(
      context,
      icon: r.icon,
      service: r.service,
      customer: r.customer,
      area: r.area,
      when: when ?? context.l(r.when),
      status: status,
      badge: badge,
      amountLabel: label,
      amount: amount,
      note: note,
      button: button,
      onButton: onButton,
      soft: soft,
    );

    final fresh = [
      for (var i = 0; i < kRequests.length; i++)
        if (i > 0 || app.quoteState == QuoteState.none)
          _entry(
            context,
            icon: kRequests[i].icon,
            service: kRequests[i].service,
            customer: kRequests[i].customer,
            area: kRequests[i].area,
            when: context.l(kRequests[i].when),
            status: const Bi('New', 'جديد'),
            badge: JobBadge.fresh,
            amountLabel: const Bi('Minimum charge', 'الحد الأدنى'),
            amount: kMinCharge,
            note: ar
                ? 'يرد خلال ${kRequests[i].timer} · ${kRequests[i].distanceKm} كم'
                : 'Respond within ${kRequests[i].timer} · ${kRequests[i].distanceKm} km away',
            button: context.tr('reviewQuote'),
            onButton: () => AppRouter.toRequest(context),
          ),
    ];

    final quoted = [
      if (pending)
        forRequest(
          status: const Bi('Awaiting customer', 'بانتظار العميل'),
          badge: JobBadge.fresh,
          label: yourQuote,
          amount: app.gross,
          button: ar ? 'عرض الحالة' : 'View status',
          onButton: () => AppRouter.toQuoteStatus(context),
          soft: true,
        ),
      _entry(
        context,
        icon: 'snowflake',
        service: const Bi('AC Gas Refill', 'تعبئة غاز المكيف'),
        customer: const Bi('Hessa M.', 'حصة م.'),
        area: const Bi('Hittin', 'حطين'),
        when: ar ? 'غداً · 5:00 م' : 'Tomorrow · 5:00 PM',
        status: const Bi('Awaiting customer', 'بانتظار العميل'),
        badge: JobBadge.fresh,
        amountLabel: yourQuote,
        amount: 270,
        note: ar ? 'ينتهي العرض خلال 1:12 ساعة' : 'Quote expires in 1 h 12 min',
      ),
      if (rejected)
        forRequest(
          status: const Bi('Quote rejected', 'رُفض العرض'),
          badge: JobBadge.bad,
          label: yourQuote,
          amount: app.gross,
          note: ar
              ? 'اختار العميل عرضاً آخر.'
              : 'The customer chose another quote.',
        ),
    ];

    final upcoming = [
      if (accepted && app.stage == 0)
        forRequest(
          status: const Bi('Accepted', 'مقبول'),
          badge: JobBadge.active,
          label: agreed,
          amount: app.gross,
          button: context.tr('startJob'),
          onButton: () => AppRouter.toActive(context),
        ),
      _entry(
        context,
        icon: 'zap',
        service: const Bi('Lighting Installation', 'تركيب الإنارة'),
        customer: const Bi('Nouf K.', 'نوف ك.'),
        area: const Bi('Al Yasmin', 'الياسمين'),
        when: ar ? 'السبت 10 أكتوبر · 4:00 م' : 'Sat 10 Oct · 4:00 PM',
        status: const Bi('Confirmed', 'مؤكد'),
        badge: JobBadge.done,
        amountLabel: agreed,
        amount: 200,
      ),
    ];

    final active = [
      if (accepted && app.stage > 0 && app.stage < 4)
        forRequest(
          status: const Bi('In progress', 'قيد التنفيذ'),
          badge: JobBadge.active,
          label: agreed,
          amount: app.gross,
          button: ar ? 'فتح المهمة' : 'Open job',
          onButton: () => AppRouter.toActive(context),
        ),
    ];

    final completed = [
      if (app.jobDone)
        forRequest(
          status: const Bi('Completed', 'مكتمل'),
          badge: JobBadge.done,
          label: earned,
          amount: app.net,
          when: ar ? 'اليوم' : 'Today',
        ),
      _entry(
        context,
        icon: 'snowflake',
        service: const Bi('AC Gas Refill', 'تعبئة غاز المكيف'),
        customer: const Bi('Abdullah M.', 'عبدالله م.'),
        area: const Bi('Al Malqa', 'الملقا'),
        when: ar ? '21 سبتمبر' : '21 Sep',
        status: const Bi('Completed', 'مكتمل'),
        badge: JobBadge.done,
        amountLabel: earned,
        amount: 229.5,
      ),
      _entry(
        context,
        icon: 'zap',
        service: const Bi('Socket & Switch Repair', 'إصلاح الأفياش والمفاتيح'),
        customer: const Bi('Reem S.', 'ريم س.'),
        area: const Bi('Al Olaya', 'العليا'),
        when: ar ? '18 سبتمبر' : '18 Sep',
        status: const Bi('Completed', 'مكتمل'),
        badge: JobBadge.done,
        amountLabel: earned,
        amount: 84.15,
      ),
    ];

    final cancelled = [
      _entry(
        context,
        icon: 'snowflake',
        service: const Bi('AC Deep Cleaning', 'تنظيف عميق للمكيف'),
        customer: const Bi('Turki A.', 'تركي ع.'),
        area: const Bi('Hittin', 'حطين'),
        when: ar ? '14 سبتمبر' : '14 Sep',
        status: const Bi('Cancelled by customer', 'ألغاه العميل'),
        badge: JobBadge.bad,
        amountLabel: const Bi('Cancellation fee to you', 'رسوم الإلغاء لك'),
        amount: 84.15,
        note: ar
            ? 'ألغى العميل بعد تحركك، فاحتُسب لك الحد الأدنى ناقص العمولة.'
            : 'Cancelled after you set off, so you received the minimum charge minus commission.',
      ),
    ];
    return [fresh, quoted, upcoming, active, completed, cancelled];
  }

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    // The prototype lists below are invented jobs; only demo builds show them.
    if (!kDemoData) {
      return RealJobsView(
        selected: app.jobsTab,
        active: app.tab == 1,
        onTab: (i) => app.showTab(app.tab, jobs: i),
      );
    }
    final groups = _build(context, app);
    final selected = app.jobsTab;
    final list = groups[selected];
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
              for (var i = 0; i < _tabLabels.length; i++) ...[
                if (i > 0) const SizedBox(width: 8),
                JobsTabChip(
                  label: context.l(_tabLabels[i]),
                  count: i < 4 ? groups[i].length : 0,
                  selected: i == selected,
                  onTap: () => app.showTab(app.tab, jobs: i),
                ),
              ],
            ],
          ),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 14, 20, 28),
            children: [
              for (final j in list) ...[
                JobCard(job: j, dateTimeLabel: context.tr('dateTime')),
                const SizedBox(height: 12),
              ],
              if (list.isEmpty)
                EmptyState(
                  icon: 'calendar',
                  title: context.tr('noJobs'),
                  subtitle: context.tr('noJobsSub'),
                  tileBg: const Color(0xFFEEF2F4),
                  tileFg: AppColors.slate,
                  verticalPadding: 60,
                ),
            ],
          ),
        ),
      ],
    );
  }
}
