import 'package:flutter/material.dart';

import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/config/demo_data.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/inputs.dart';
import '../../../shared/components/language_dialog.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';
import '../widgets/real_profile.dart';

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context) {
    // A real build shows the worker's own application and account; the invented profile below is prototype content (demo builds only).
    if (!kDemoData) return const RealProfile();
    final app = context.app;
    final ar = context.isAr;
    final rows = [
      (
        'tag',
        context.tr('subscription'),
        ar ? 'احترافية' : 'Pro',
        () => AppRouter.toSubscription(context),
      ),
      (
        'file',
        ar ? 'المستندات' : 'Documents',
        ar ? 'موثّقة' : 'Verified',
        () => AppRouter.toStatus(context),
      ),
      ('card', ar ? 'حساب التحويل' : 'Payout account', '•••• 0932', null),
      (
        'bell',
        context.tr('notifications'),
        '',
        () => AppRouter.toNotifications(context),
      ),
      ('help', ar ? 'المساعدة والدعم' : 'Help & support', '', null),
      (
        'logout',
        ar ? 'تسجيل الخروج' : 'Log out',
        '',
        () async {
          // Ends the server session and push registration first, then returns to the welcome screen.
          await context.authRead.signOut();
          if (context.mounted) AppRouter.toWelcomeReset(context);
        },
      ),
    ];
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
                        ar ? 'ف' : 'FH',
                        size: 68,
                        fontSize: 22,
                        radius: 22,
                      ),
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
                          kDemoData
                              ? (ar ? 'فيصل الحربي' : 'Faisal Al-Harbi')
                              : (context.auth.user?.fullName
                                        ?.trim()
                                        .isNotEmpty ??
                                    false)
                              ? context.auth.user!.fullName!.trim()
                              : context.tr('wjNoName'),
                          style: ts(18, w: 700),
                        ),
                        const SizedBox(height: 4),
                        Wrap(
                          spacing: 6,
                          runSpacing: 4,
                          children: [
                            Pill(
                              context.tr('verifiedPro'),
                              icon: 'shield',
                              fontSize: 11.5,
                              weight: 700,
                              radius: 7,
                              padding: const EdgeInsets.symmetric(
                                horizontal: 8,
                                vertical: 3,
                              ),
                            ),
                            if (kDemoData)
                              const Pill(
                                'PRO',
                                bg: AppColors.text,
                                fg: AppColors.gold,
                                fontSize: 11,
                                weight: 800,
                                radius: 7,
                                padding: EdgeInsets.symmetric(
                                  horizontal: 8,
                                  vertical: 3,
                                ),
                                letterSpacing: 0.66,
                              ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              if (kDemoData) ...[
                const SizedBox(height: 16),
                Container(
                  padding: const EdgeInsets.only(top: 14),
                  decoration: const BoxDecoration(
                    border: Border(top: BorderSide(color: AppColors.lineFaint)),
                  ),
                  child: Row(
                    children: [
                      for (final s in [
                        ('4.9', ar ? 'التقييم' : 'Rating'),
                        ('412', ar ? 'مهمة مكتملة' : 'Jobs done'),
                        (
                          ar ? '8 سنوات' : '8 yrs',
                          ar ? 'الخبرة' : 'Experience',
                        ),
                      ])
                        Expanded(
                          child: Column(
                            children: [
                              Text(s.$1, style: ts(19, w: 700)),
                              const SizedBox(height: 3),
                              Text(s.$2, style: ts(11.5, c: AppColors.slate)),
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
        // Invented services, areas, hours, rating and reviews: demo builds only (the real profile is the application data).
        if (kDemoData) ...[
          const SizedBox(height: 16),
          block(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                small(context.tr('services')),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final c in [
                      ('snowflake', ar ? 'تكييف' : 'AC'),
                      ('zap', ar ? 'كهرباء' : 'Electrical'),
                    ])
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
                            AppIcon(c.$1, size: 14, color: AppColors.primary),
                            const SizedBox(width: 5),
                            Text(
                              c.$2,
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
                  ar
                      ? 'الرياض · العليا، الملقا، حطين'
                      : 'Riyadh · Al Olaya, Al Malqa, Hittin',
                  style: ts(14, w: 500, h: 1.5),
                ),
                const SizedBox(height: 14),
                small(context.tr('availability')),
                const SizedBox(height: 8),
                Text(
                  ar
                      ? 'السبت–الخميس · 8:00 ص – 10:00 م'
                      : 'Sat–Thu · 8:00 AM – 10:00 PM',
                  style: ts(14, w: 500),
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
              const RatingInline(
                rating: '4.9',
                trailing: ' · 318',
                size: 13,
                fontSize: 13,
                boldRating: false,
                ratingColor: AppColors.slate,
              ),
            ],
          ),
          const SizedBox(height: 16),
          for (final r in [
            (
              ar ? 'نورة ع.' : 'Noura A.',
              5,
              ar
                  ? 'شرح كل شيء قبل البدء، والوحدتان تبردان جيداً الآن.'
                  : 'Explained everything before starting, and both units cool properly now.',
            ),
            (
              ar ? 'عبدالله م.' : 'Abdullah M.',
              5,
              ar ? 'في الموعد، مرتب، وسعر عادل.' : 'On time, tidy, fair price.',
            ),
          ]) ...[
            AppCard(
              padding: const EdgeInsets.all(14),
              radius: 18,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(r.$1, style: ts(14, w: 600)),
                      Row(
                        children: [
                          for (var i = 1; i <= 5; i++)
                            Padding(
                              padding: const EdgeInsetsDirectional.only(
                                start: 2,
                              ),
                              child: AppIcon(
                                'star',
                                size: 12,
                                color: AppColors.gold,
                                filled: i <= r.$2,
                                strokeWidth: 1.6,
                              ),
                            ),
                        ],
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Text(r.$3, style: ts(13.5, c: AppColors.slate, h: 1.5)),
                ],
              ),
            ),
            const SizedBox(height: 16),
          ],
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
