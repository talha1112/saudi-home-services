import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/localization/app_strings.dart';
import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/language_dialog.dart';
import '../../../shared/components/phone_field.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../authentication/utils/auth_messages.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';
import '../../authentication/utils/phone_format.dart';

const _perks = [
  (
    'verified',
    Bi(
      'Verified customers and upfront minimum charge',
      'عملاء موثّقون وحد أدنى مدفوع مسبقاً',
    ),
  ),
  ('card', Bi('Weekly payouts to your bank', 'تحويلات أسبوعية لحسابك البنكي')),
  ('tag', Bi('You set the price for each job', 'أنت تحدد سعر كل مهمة')),
];

class WelcomeScreen extends StatefulWidget {
  const WelcomeScreen({super.key, this.showLanguage = false});

  /// Opens the language picker right after the screen appears.
  final bool showLanguage;

  @override
  State<WelcomeScreen> createState() => _WelcomeScreenState();
}

class _WelcomeScreenState extends State<WelcomeScreen> {
  late final TextEditingController _controller = TextEditingController(
    text: formatSaudiPhone(context.appRead.phone),
  );

  @override
  void initState() {
    super.initState();
    if (widget.showLanguage) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) showLanguageDialog(context);
      });
    }
  }

  bool _busy = false;
  AuthController? _auth;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final auth = context.authRead;
    if (!identical(auth, _auth)) {
      _auth?.removeListener(_resume);
      _auth = auth..addListener(_resume);
      _resume();
    }
  }

  /// A saved session that is restored in the background continues straight to where this worker belongs.
  void _resume() {
    final user = _auth?.user;
    if (!mounted || _busy || user == null || _auth?.isSignedIn != true) {
      return;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // The code screen handles its own sign-in, so only act while this screen is the visible one.
      if (mounted && ModalRoute.of(context)?.isCurrent == true) {
        AppRouter.afterSignIn(context, user);
      }
    });
  }

  /// Asks Firebase to SMS the code, then opens the code screen. Errors are shown here and keep the person on this screen.
  Future<void> _send() async {
    if (_busy) return;
    final auth = context.authRead;
    final arabic = context.isAr;
    setState(() => _busy = true);
    final ok = await auth.sendCode(
      '+966${context.appRead.phone}',
      languageCode: arabic ? 'ar' : 'en',
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (!ok) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(authMessage(context, auth.issue ?? AuthIssue.generic)),
        ),
      );
      return;
    }
    final user = auth.user;
    if (auth.isSignedIn && user != null) {
      AppRouter.afterSignIn(
        context,
        user,
      ); // verified instantly, no code to type
    } else {
      AppRouter.toOtp(context);
    }
  }

  @override
  void dispose() {
    _auth?.removeListener(_resume);
    _controller.dispose();
    super.dispose();
  }

  void _onChanged(String value) {
    final digits = normalizeSaudiDigits(value);
    context.appRead.phone = digits;
    final text = formatSaudiPhone(digits);
    _controller.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final ar = context.isAr;
    final ok = isValidSaudiPhone(context.appRead.phone);
    final top = MediaQuery.paddingOf(context).top;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light,
      child: Scaffold(
        body: LayoutBuilder(
          builder: (context, box) => SingleChildScrollView(
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: box.maxHeight),
              child: IntrinsicHeight(
                child: Column(
                  children: [
                    ClipRect(
                      child: Container(
                        width: double.infinity,
                        color: AppColors.text,
                        child: Stack(
                          children: [
                            PositionedDirectional(
                              top: -60,
                              end: -70,
                              child: Container(
                                width: 220,
                                height: 220,
                                decoration: BoxDecoration(
                                  shape: BoxShape.circle,
                                  border: Border.all(
                                    color: AppColors.gold.withValues(
                                      alpha: .12,
                                    ),
                                    width: 34,
                                  ),
                                ),
                              ),
                            ),
                            Padding(
                              padding: EdgeInsets.fromLTRB(
                                24,
                                top + 24,
                                24,
                                36,
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    mainAxisAlignment:
                                        MainAxisAlignment.spaceBetween,
                                    children: [
                                      const IconTile(
                                        'wrench',
                                        size: 56,
                                        radius: 18,
                                        iconSize: 26,
                                        bg: AppColors.gold,
                                        fg: AppColors.text,
                                      ),
                                      Tap(
                                        onTap: () =>
                                            showLanguageDialog(context),
                                        child: Container(
                                          height: 38,
                                          padding: const EdgeInsets.symmetric(
                                            horizontal: 12,
                                          ),
                                          decoration: BoxDecoration(
                                            color: Colors.white,
                                            borderRadius: BorderRadius.circular(
                                              19,
                                            ),
                                            border: Border.all(
                                              color: AppColors.line,
                                            ),
                                          ),
                                          child: Row(
                                            mainAxisSize: MainAxisSize.min,
                                            children: [
                                              const AppIcon(
                                                'globe',
                                                size: 16,
                                                color: AppColors.text,
                                              ),
                                              const SizedBox(width: 7),
                                              Text(
                                                ar ? 'العربية' : 'English',
                                                style: ts(
                                                  13.5,
                                                  w: 700,
                                                  family: ar
                                                      ? 'Tajawal'
                                                      : 'Archivo',
                                                ),
                                              ),
                                              const SizedBox(width: 7),
                                              const AppIcon(
                                                'chevron-down',
                                                size: 14,
                                                color: AppColors.text,
                                              ),
                                            ],
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: 14),
                                  Text(
                                    ar
                                        ? context.tr('brandW')
                                        : context.tr('brandW').toUpperCase(),
                                    style: ts(
                                      13,
                                      w: 700,
                                      c: AppColors.gold,
                                      ls: 1.04,
                                    ),
                                  ),
                                  const SizedBox(height: 14),
                                  ConstrainedBox(
                                    constraints: const BoxConstraints(
                                      maxWidth: 300,
                                    ),
                                    child: Text(
                                      context.tr('wWelcome'),
                                      style: ts(
                                        28,
                                        w: 700,
                                        c: Colors.white,
                                        h: 1.2,
                                      ),
                                    ),
                                  ),
                                  const SizedBox(height: 20),
                                  for (final p in _perks) ...[
                                    Row(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        IconTile(
                                          p.$1,
                                          size: 28,
                                          radius: 9,
                                          iconSize: 15,
                                          bg: Colors.white.withValues(
                                            alpha: .1,
                                          ),
                                          fg: AppColors.gold,
                                        ),
                                        const SizedBox(width: 10),
                                        Expanded(
                                          child: Padding(
                                            padding: const EdgeInsets.only(
                                              top: 4,
                                            ),
                                            child: Text(
                                              context.l(p.$2),
                                              style: ts(
                                                14.5,
                                                c: Colors.white.withValues(
                                                  alpha: .92,
                                                ),
                                                h: 1.4,
                                              ),
                                            ),
                                          ),
                                        ),
                                      ],
                                    ),
                                    const SizedBox(height: 10),
                                  ],
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    Expanded(
                      child: SafeArea(
                        top: false,
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(24, 24, 24, 16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(context.tr('mobile'), style: ts(13, w: 600)),
                              const SizedBox(height: 8),
                              PhoneField(
                                controller: _controller,
                                ok: ok,
                                onChanged: _onChanged,
                              ),
                              const SizedBox(height: 8),
                              Text(
                                context.tr('wPhoneHint'),
                                style: ts(12.5, c: AppColors.slate),
                              ),
                              const SizedBox(height: 24),
                              const Spacer(),
                              AppButton(
                                label: context.tr(
                                  _busy ? 'otpSending' : 'sendCode',
                                ),
                                enabled: ok && !_busy,
                                onPressed: _send,
                              ),
                              const SizedBox(height: 14),
                              Center(
                                child: Text(
                                  context.tr('wTerms'),
                                  textAlign: TextAlign.center,
                                  style: ts(12.5, c: AppColors.slate, h: 1.5),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
