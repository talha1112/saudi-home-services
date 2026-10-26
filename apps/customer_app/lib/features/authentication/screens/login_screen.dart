import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/inputs.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';
import '../utils/auth_messages.dart';
import '../utils/phone_format.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  late final TextEditingController _controller = TextEditingController(
    text: formatSaudiPhone(context.appRead.phone),
  );
  bool _consent = true;
  bool _busy = false;

  String get _digits => context.appRead.phone;
  bool get _phoneOk => isValidSaudiPhone(_digits);

  @override
  void dispose() {
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

  /// Asks Firebase to SMS the code, then opens the code screen. Errors are shown here and keep the person on this screen.
  Future<void> _send() async {
    if (_busy) return;
    final auth = context.authRead;
    final arabic = context.isAr;
    setState(() => _busy = true);
    final ok = await auth.sendCode(
      '+966$_digits',
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
    if (auth.isSignedIn) {
      AppRouter.toHome(
        context,
      ); // the number was verified instantly, no code to type
    } else {
      AppRouter.toOtp(context);
    }
  }

  @override
  Widget build(BuildContext context) {
    final canSend = _phoneOk && _consent && !_busy;
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 20, 24, 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: SingleChildScrollView(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const IconTile(
                        'wrench',
                        size: 56,
                        iconSize: 26,
                        radius: 18,
                        bg: AppColors.primary,
                        fg: Colors.white,
                      ),
                      const SizedBox(height: 28),
                      Text(context.tr('loginTitle'), style: ts(28, w: 700)),
                      const SizedBox(height: 8),
                      Text(
                        context.tr('loginSub'),
                        style: ts(16, c: AppColors.slate, h: 1.5),
                      ),
                      const SizedBox(height: 32),
                      Text(context.tr('mobile'), style: ts(13, w: 600)),
                      const SizedBox(height: 8),
                      _PhoneField(
                        controller: _controller,
                        ok: _phoneOk,
                        onChanged: _onChanged,
                      ),
                      const SizedBox(height: 8),
                      Text(
                        context.tr('phoneHint'),
                        style: ts(12.5, c: AppColors.slate),
                      ),
                      const SizedBox(height: 22),
                      _ConsentRow(
                        checked: _consent,
                        onToggle: () => setState(() => _consent = !_consent),
                      ),
                    ],
                  ),
                ),
              ),
              AppButton(
                label: context.tr(_busy ? 'otpSending' : 'sendCode'),
                enabled: canSend,
                onPressed: _send,
              ),
              const SizedBox(height: 8),
              Tap(
                onTap: () {},
                child: SizedBox(
                  height: 48,
                  child: Center(
                    child: Text(
                      context.tr('useEmail'),
                      style: ts(15, w: 600, c: AppColors.primary),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PhoneField extends StatelessWidget {
  const _PhoneField({
    required this.controller,
    required this.ok,
    required this.onChanged,
  });

  final TextEditingController controller;
  final bool ok;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    // Phone numbers always read left-to-right, even in Arabic.
    return Directionality(
      textDirection: TextDirection.ltr,
      child: Container(
        height: 60,
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(
            color: ok ? AppColors.primary : AppColors.line,
            width: 1.5,
          ),
        ),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              decoration: const BoxDecoration(
                border: Border(right: BorderSide(color: AppColors.line)),
              ),
              child: Row(
                children: [
                  const Pill(
                    'SA',
                    fontSize: 11,
                    weight: 700,
                    radius: 5,
                    padding: EdgeInsets.symmetric(horizontal: 5, vertical: 3),
                    family: kLatinFont,
                  ),
                  const SizedBox(width: 8),
                  Text('+966', style: ts(16, w: 600, family: kLatinFont)),
                ],
              ),
            ),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: BareField(
                  controller: controller,
                  hint: '5X XXX XXXX',
                  fontSize: 18,
                  weight: 500,
                  family: kLatinFont,
                  letterSpacing: 0.72,
                  keyboardType: TextInputType.phone,
                  inputFormatters: [
                    FilteringTextInputFormatter.allow(RegExp(r'[0-9 ]')),
                  ],
                  onChanged: onChanged,
                ),
              ),
            ),
            if (ok)
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 14),
                child: AppIcon(
                  'check',
                  size: 20,
                  color: AppColors.primary,
                  strokeWidth: 2.5,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _ConsentRow extends StatelessWidget {
  const _ConsentRow({required this.checked, required this.onToggle});

  final bool checked;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final link = ts(13.5, w: 600, c: AppColors.primary);
    return Tap(
      onTap: onToggle,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 22,
            height: 22,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: checked ? AppColors.primary : Colors.white,
              borderRadius: BorderRadius.circular(7),
              border: Border.all(
                color: checked ? AppColors.primary : AppColors.radioRing,
                width: 1.5,
              ),
            ),
            child: const AppIcon(
              'check',
              size: 14,
              color: Colors.white,
              strokeWidth: 3,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text.rich(
              TextSpan(
                style: ts(13.5, c: AppColors.slate, h: 1.45),
                children: [
                  TextSpan(text: '${context.tr('consentA')} '),
                  TextSpan(text: context.tr('termsL'), style: link),
                  TextSpan(text: ' ${context.tr('and')} '),
                  TextSpan(text: context.tr('privacyL'), style: link),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
