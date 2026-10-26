import 'package:flutter/material.dart';

import '../../../app/localization/app_strings.dart';
import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/language_dialog.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../widgets/onboarding_illustration.dart';

class _Page {
  const _Page(this.icon, this.badge, this.title, this.desc);
  final String icon;
  final String badge;
  final Bi title;
  final Bi desc;
}

const _pages = [
  _Page(
    'search',
    'star',
    Bi('Find trusted home services', 'اعثر على خدمات منزلية موثوقة'),
    Bi(
      'Electrical, plumbing and AC experts across Riyadh, Jeddah and Dammam.',
      'خبراء كهرباء وسباكة وتكييف في الرياض وجدة والدمام.',
    ),
  ),
  _Page(
    'verified',
    'shield',
    Bi('Book verified professionals', 'احجز فنيين موثّقين'),
    Bi(
      'Every professional is ID-checked and approved. Compare quotes and know the price before you pay.',
      'كل فني يتم التحقق من هويته واعتماده. قارن العروض واعرف السعر قبل الدفع.',
    ),
  ),
  _Page(
    'locate',
    'lock',
    Bi('Track live, pay securely', 'تابع مباشرة وادفع بأمان'),
    Bi(
      'Follow your professional on the map, chat in the app, and pay with mada, Apple Pay or STC Pay.',
      'تابع الفني على الخريطة، وتواصل عبر المحادثة، وادفع بمدى أو Apple Pay أو STC Pay.',
    ),
  ),
];

class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key, this.showLanguage = false});

  /// Opens the language picker right after the screen appears.
  final bool showLanguage;

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  int _index = 0;

  @override
  void initState() {
    super.initState();
    if (widget.showLanguage) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) showLanguageDialog(context);
      });
    }
  }

  void _next() {
    if (_index == _pages.length - 1) {
      AppRouter.toLogin(context);
    } else {
      setState(() => _index++);
    }
  }

  @override
  Widget build(BuildContext context) {
    final page = _pages[_index];
    final last = _index == _pages.length - 1;
    final ar = context.isAr;
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 4, 24, 20),
          child: Column(
            children: [
              SizedBox(
                height: 44,
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Tap(
                      onTap: () => showLanguageDialog(context),
                      child: Container(
                        height: 38,
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(19),
                          border: Border.all(color: AppColors.line),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const AppIcon('globe', size: 16),
                            const SizedBox(width: 7),
                            Text(
                              ar ? 'العربية' : 'English',
                              style: ts(
                                13.5,
                                w: 700,
                                family: ar ? 'Tajawal' : 'Archivo',
                              ),
                            ),
                            const SizedBox(width: 7),
                            const AppIcon('chevron-down', size: 14),
                          ],
                        ),
                      ),
                    ),
                    Tap(
                      onTap: () => AppRouter.toLogin(context),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                        child: Text(
                          context.tr('skip'),
                          style: ts(15, w: 600, c: AppColors.slate),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: Center(
                  child: OnboardingIllustration(
                    icon: page.icon,
                    badge: page.badge,
                  ),
                ),
              ),
              ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 150),
                child: SizedBox(
                  width: double.infinity,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        context.l(page.title),
                        style: ts(28, w: 700, h: 1.25),
                      ),
                      const SizedBox(height: 12),
                      Text(
                        context.l(page.desc),
                        style: ts(16, c: AppColors.slate, h: 1.55),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 20),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Row(
                    children: [
                      for (var i = 0; i < _pages.length; i++)
                        AnimatedContainer(
                          duration: const Duration(milliseconds: 250),
                          margin: const EdgeInsetsDirectional.only(end: 6),
                          height: 8,
                          width: i == _index ? 24 : 8,
                          decoration: BoxDecoration(
                            color: i == _index
                                ? AppColors.primary
                                : const Color(0xFFCFDCDA),
                            borderRadius: BorderRadius.circular(4),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(width: 16),
                  AppButton(
                    label: context.tr(last ? 'getStarted' : 'next'),
                    expand: false,
                    onPressed: _next,
                    padding: const EdgeInsets.symmetric(horizontal: 28),
                    leading: null,
                    icon: null,
                    trailingIcon: context.forwardIcon,
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
