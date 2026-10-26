import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';
import '../utils/auth_messages.dart';
import '../utils/phone_format.dart';

/// Length of the SMS code Firebase sends.
const int kCodeLength = 6;

class OtpScreen extends StatefulWidget {
  const OtpScreen({super.key});

  @override
  State<OtpScreen> createState() => _OtpScreenState();
}

class _OtpScreenState extends State<OtpScreen> {
  final _controller = TextEditingController();
  final _focus = FocusNode();
  Timer? _ticker;
  AuthController? _auth;
  bool _leaving = false;

  @override
  void initState() {
    super.initState();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {}); // the resend countdown
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final auth = context.authRead;
    if (!identical(auth, _auth)) {
      _auth?.removeListener(_onAuthChanged);
      _auth = auth..addListener(_onAuthChanged);
    }
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _auth?.removeListener(_onAuthChanged);
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// Android can read the SMS by itself: the session then appears without the code being typed.
  void _onAuthChanged() {
    if (_auth?.isSignedIn == true) _enterApp();
  }

  void _enterApp() {
    if (_leaving || !mounted) return;
    _leaving = true;
    AppRouter.toHome(context);
  }

  Future<void> _onChanged(String value) async {
    setState(() {});
    if (value.length != kCodeLength) return;
    final auth = context.authRead;
    final ok = await auth.submitCode(value);
    if (!mounted) return;
    if (ok) {
      _enterApp();
    } else {
      _controller.clear(); // type the code again
      _focus.requestFocus();
      setState(() {});
    }
  }

  Future<void> _resend() async {
    final auth = context.authRead;
    final ok = await auth.resendCode(languageCode: context.isAr ? 'ar' : 'en');
    if (!mounted) return;
    if (ok) _controller.clear();
    setState(() {});
  }

  void _changeNumber() {
    context.authRead.backToPhone();
    Navigator.of(context).maybePop();
  }

  String _countdown(Duration left) {
    final s = left.inSeconds.clamp(0, 3600);
    return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.auth;
    final code = _controller.text;
    final phone = formatSaudiPhone(context.appRead.phone);
    final busy =
        auth.status == AuthStatus.verifying ||
        auth.status == AuthStatus.sendingCode;
    final issue = auth.issue;
    final left =
        auth.resendAvailableAt?.difference(DateTime.now()) ?? Duration.zero;
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SquareIconButton.back(context),
              const SizedBox(height: 24),
              Text(context.tr('otpTitle'), style: ts(28, w: 700)),
              const SizedBox(height: 8),
              Text.rich(
                TextSpan(
                  style: ts(16, c: AppColors.slate, h: 1.5),
                  children: [
                    TextSpan(text: '${context.tr('otpSub')} '),
                    TextSpan(
                      text:
                          '\u2066+966 ${phone.isEmpty ? '55 123 4567' : phone}\u2069',
                      style: ts(16, w: 600, family: kLatinFont),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 32),
              Directionality(
                textDirection: TextDirection.ltr,
                child: Stack(
                  children: [
                    Row(
                      children: [
                        for (var i = 0; i < kCodeLength; i++) ...[
                          if (i > 0) const SizedBox(width: 8),
                          Expanded(
                            child: _Box(
                              digit: i < code.length ? code[i] : '',
                              active: i == code.length,
                              filled: i < code.length,
                            ),
                          ),
                        ],
                      ],
                    ),
                    Positioned.fill(
                      child: Opacity(
                        opacity: 0,
                        child: TextField(
                          key: const Key('otp-input'),
                          controller: _controller,
                          focusNode: _focus,
                          autofocus: true,
                          enabled: !busy,
                          keyboardType: TextInputType.number,
                          autofillHints: const [AutofillHints.oneTimeCode],
                          inputFormatters: [
                            FilteringTextInputFormatter.digitsOnly,
                            LengthLimitingTextInputFormatter(kCodeLength),
                          ],
                          onChanged: _onChanged,
                          enableInteractiveSelection: false,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              if (auth.status == AuthStatus.verifying)
                Text(
                  context.tr('otpVerifying'),
                  style: ts(13, c: AppColors.slate),
                )
              else if (issue != null)
                Text(
                  authMessage(context, issue),
                  key: const Key('otp-error'),
                  style: ts(13.5, w: 600, c: AppColors.danger),
                )
              else
                Text(context.tr('otpHint'), style: ts(13, c: AppColors.slate)),
              const SizedBox(height: 24),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Flexible(
                    child: left > Duration.zero
                        ? Text.rich(
                            TextSpan(
                              style: ts(14.5, c: AppColors.slate),
                              children: [
                                TextSpan(text: '${context.tr('resendIn')} '),
                                TextSpan(
                                  text: _countdown(left),
                                  style: ts(14.5, w: 600, family: kLatinFont),
                                ),
                              ],
                            ),
                          )
                        : Tap(
                            onTap: busy ? null : _resend,
                            child: Text(
                              context.tr('resendCode'),
                              key: const Key('otp-resend'),
                              style: ts(14.5, w: 600, c: AppColors.primary),
                            ),
                          ),
                  ),
                  const SizedBox(width: 12),
                  Tap(
                    onTap: _changeNumber,
                    child: Text(
                      context.tr('changeNum'),
                      style: ts(14.5, w: 600, c: AppColors.primary),
                    ),
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

class _Box extends StatelessWidget {
  const _Box({required this.digit, required this.active, required this.filled});

  final String digit;
  final bool active;
  final bool filled;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 64,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: active
              ? AppColors.primary
              : (filled ? const Color(0xFFB9CCC8) : AppColors.line),
          width: 1.5,
        ),
        boxShadow: active
            ? const [BoxShadow(color: Color(0x1A00695C), spreadRadius: 4)]
            : null,
      ),
      child: Text(digit, style: ts(26, w: 700, family: kLatinFont)),
    );
  }
}
