import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/widgets/app_icon.dart';

class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _blink = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1200),
  )..repeat();
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer(const Duration(milliseconds: 2200), () async {
      if (!mounted) return;
      final auth = context.authRead;
      await _sessionKnown(auth);
      if (!mounted) return;
      // A saved session continues straight to the app; otherwise the usual onboarding and sign-in.
      if (auth.isSignedIn) {
        AppRouter.toHome(context);
      } else {
        AppRouter.toOnboarding(context, showLanguage: true);
      }
    });
  }

  /// Waits (at most a few seconds) until the saved session has been checked.
  Future<void> _sessionKnown(AuthController auth) {
    if (auth.status != AuthStatus.unknown) return Future<void>.value();
    final done = Completer<void>();
    void listener() {
      if (auth.status != AuthStatus.unknown && !done.isCompleted) {
        done.complete();
      }
    }

    auth.addListener(listener);
    return done.future
        .timeout(const Duration(seconds: 8), onTimeout: () {})
        .whenComplete(() => auth.removeListener(listener));
  }

  @override
  void dispose() {
    _timer?.cancel();
    _blink.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light,
      child: Scaffold(
        backgroundColor: AppColors.primary,
        body: Stack(
          children: [
            Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: 92,
                      height: 92,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(30),
                        boxShadow: const [
                          BoxShadow(
                            color: Color(0x2E000000),
                            blurRadius: 34,
                            offset: Offset(0, 14),
                          ),
                        ],
                      ),
                      child: const AppIcon(
                        'wrench',
                        size: 44,
                        color: AppColors.primary,
                        strokeWidth: 2.2,
                      ),
                    ),
                    const SizedBox(height: 24),
                    Text(
                      context.tr('brand'),
                      textAlign: TextAlign.center,
                      style: ts(34, w: 800, c: Colors.white, ls: -0.34),
                    ),
                    const SizedBox(height: 16),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 250),
                      child: Text(
                        context.tr('tagline'),
                        textAlign: TextAlign.center,
                        style: ts(
                          16,
                          c: Colors.white.withValues(alpha: .85),
                          h: 1.45,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            Positioned(
              left: 0,
              right: 0,
              bottom: 80,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  for (var i = 0; i < 3; i++)
                    _BlinkDot(controller: _blink, delay: i * 0.2 / 1.2),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _BlinkDot extends StatelessWidget {
  const _BlinkDot({required this.controller, required this.delay});

  final Animation<double> controller;
  final double delay;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final t = (controller.value - delay) % 1.0;
        final v = t < .5 ? t * 2 : (1 - t) * 2; // 0 -> 1 -> 0
        return Container(
          width: 8,
          height: 8,
          margin: const EdgeInsets.symmetric(horizontal: 4),
          decoration: BoxDecoration(
            color: Colors.white.withValues(alpha: .3 + .7 * v),
            borderRadius: BorderRadius.circular(4),
          ),
        );
      },
    );
  }
}
