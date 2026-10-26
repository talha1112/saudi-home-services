import 'package:flutter/material.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';
import '../utils/onboarding_text.dart';

class _Look {
  const _Look(this.icon, this.tileBg, this.tileFg);
  final String icon;
  final Color tileBg;
  final Color tileFg;
}

_Look _lookFor(VerificationState s) => switch (s) {
  VerificationState.submitted => const _Look(
    'file',
    AppColors.tealTint,
    AppColors.primary,
  ),
  VerificationState.underReview => const _Look(
    'clock',
    AppColors.cream,
    Color(0xFFB07A10),
  ),
  VerificationState.infoRequired => const _Look(
    'alert',
    AppColors.cream,
    Color(0xFFB07A10),
  ),
  VerificationState.approved => const _Look(
    'verified',
    AppColors.tealTint,
    AppColors.primary,
  ),
  VerificationState.rejected => const _Look(
    'x',
    AppColors.dangerBg,
    AppColors.danger,
  ),
  VerificationState.suspended => const _Look(
    'alert',
    AppColors.dangerBg,
    AppColors.danger,
  ),
  VerificationState.notSubmitted => const _Look(
    'file',
    AppColors.chip,
    AppColors.text,
  ),
  VerificationState.unknown => const _Look(
    'alert',
    AppColors.chip,
    AppColors.slate,
  ),
};

/// The worker's application status, exactly as the server reports it. Loaded when the screen opens and again when the app is brought back
/// to the foreground (throttled by the controller), so an approval or a request for more information shows up without restarting.
class StatusScreen extends StatefulWidget {
  const StatusScreen({super.key});

  @override
  State<StatusScreen> createState() => _StatusScreenState();
}

class _StatusScreenState extends State<StatusScreen>
    with WidgetsBindingObserver {
  WorkerOnboardingController? _ob;
  AuthController? _auth;
  bool _leaving = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final ob = context.onboardingRead;
    if (!identical(ob, _ob)) {
      _ob = ob;
      ob.refresh(); // throttled: reopening the screen within a few seconds does not call the server again
    }
    final auth = context.authRead;
    if (!identical(auth, _auth)) {
      _auth?.removeListener(_onAuthChanged);
      _auth = auth..addListener(_onAuthChanged);
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _ob?.refresh();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _auth?.removeListener(_onAuthChanged);
    super.dispose();
  }

  void _onAuthChanged() {
    final auth = _auth;
    if (auth == null || _leaving || !mounted) return;
    if (auth.status == AuthStatus.signedOut) {
      _leaving = true;
      AppRouter.toWelcomeReset(context); // the session ended: back to sign-in
    }
  }

  @override
  Widget build(BuildContext context) {
    final ob = context.onboarding;
    final ar = context.isAr;
    final info = ob.verification;
    final failure = ob.failure;
    final state = info?.state ?? VerificationState.unknown;
    final look = _lookFor(state);
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: ListView(
          padding: EdgeInsets.fromLTRB(20, 12, 20, context.bottomInset + 20),
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    ar
                        ? context.l(Ob.appStatus)
                        : context.l(Ob.appStatus).toUpperCase(),
                    style: ts(13, w: 700, c: AppColors.slate, ls: 0.78),
                  ),
                ),
                Tap(
                  onTap: ob.busy ? null : () => ob.refresh(force: true),
                  child: Text(
                    context.l(Ob.refresh),
                    key: const Key('status-refresh'),
                    style: ts(13.5, w: 600, c: AppColors.primary),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 18),
            if (info == null)
              _Loading(failure: ob.loadedOnce ? failure : null)
            else ...[
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 20,
                  vertical: 26,
                ),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(24),
                  border: Border.all(color: AppColors.lineSoft),
                ),
                child: Column(
                  children: [
                    IconTile(
                      look.icon,
                      size: 84,
                      radius: 28,
                      iconSize: 38,
                      bg: look.tileBg,
                      fg: look.tileFg,
                      strokeWidth: 1.8,
                    ),
                    const SizedBox(height: 12),
                    Pill(
                      Ob.stateBadge(state, ar),
                      bg: look.tileBg,
                      fg: look.tileFg,
                      fontSize: 12,
                      weight: 700,
                      padding: const EdgeInsets.symmetric(
                        horizontal: 11,
                        vertical: 5,
                      ),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      Ob.stateTitle(state, ar),
                      key: const Key('status-title'),
                      textAlign: TextAlign.center,
                      style: ts(23, w: 700, h: 1.25),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      Ob.stateBody(state, ar),
                      textAlign: TextAlign.center,
                      style: ts(14.5, c: AppColors.slate, h: 1.55),
                    ),
                  ],
                ),
              ),
              if (info.note != null && info.note!.trim().isNotEmpty) ...[
                const SizedBox(height: 18),
                Container(
                  key: const Key('status-note'),
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: AppColors.cream,
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: AppColors.creamBorder),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        context.l(Ob.reviewerNote),
                        style: ts(14, w: 700, c: AppColors.creamDeep),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        info.note!,
                        style: ts(13.5, c: AppColors.creamDeep, h: 1.5),
                      ),
                    ],
                  ),
                ),
              ],
              if (state == VerificationState.notSubmitted &&
                  info.missing.isNotEmpty) ...[
                const SizedBox(height: 18),
                _Missing(items: info.missing),
              ],
              const SizedBox(height: 18),
              if (state == VerificationState.approved)
                AppButton(
                  label: context.l(Ob.goDashboard),
                  onPressed: () => AppRouter.toHome(context),
                )
              else if (state == VerificationState.infoRequired ||
                  state == VerificationState.rejected)
                AppButton(
                  label: context.l(Ob.editApplication),
                  onPressed: () => AppRouter.toApply(context),
                )
              else if (state == VerificationState.notSubmitted)
                AppButton(
                  label: context.l(Ob.startApplication),
                  onPressed: () => AppRouter.toApply(context),
                )
              else if (state == VerificationState.suspended)
                AppButton(
                  key: const Key('contact-support'),
                  label: context.l(Ob.contactSupport),
                  kind: AppButtonKind.soft,
                  height: 52,
                  radius: 16,
                  fontSize: 15,
                  onPressed: () => AppRouter.toSupport(context),
                ),
              // Anyone whose application is not approved can reach the administrators from here.
              if (state != VerificationState.approved &&
                  state != VerificationState.suspended) ...[
                const SizedBox(height: 10),
                AppButton(
                  key: const Key('contact-support'),
                  label: context.l(Ob.contactSupport),
                  kind: AppButtonKind.soft,
                  height: 52,
                  radius: 16,
                  fontSize: 15,
                  onPressed: () => AppRouter.toSupport(context),
                ),
              ],
              if (failure != null) ...[
                const SizedBox(height: 14),
                Text(
                  onboardingMessage(context, failure),
                  key: const Key('status-error'),
                  textAlign: TextAlign.center,
                  style: ts(13, c: AppColors.danger),
                ),
              ],
              if (info.history.isNotEmpty) ...[
                const SizedBox(height: 22),
                Text(
                  context.l(Ob.history),
                  style: ts(13, w: 700, c: AppColors.slate),
                ),
                const SizedBox(height: 8),
                for (final h in info.history.reversed.take(6))
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            Ob.stateBadge(h.toStatus, ar),
                            style: ts(13.5, w: 600),
                          ),
                        ),
                        Text(
                          _date(h.createdAt),
                          style: ts(
                            12.5,
                            c: AppColors.slate,
                            family: kLatinFont,
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ],
          ],
        ),
      ),
    );
  }

  String _date(DateTime d) {
    final l = d.toLocal();
    return '${l.year}-${l.month.toString().padLeft(2, '0')}-${l.day.toString().padLeft(2, '0')}';
  }
}

class _Loading extends StatelessWidget {
  const _Loading({this.failure});
  final OnboardingFailure? failure;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 40),
    child: Center(
      child: Text(
        failure == null
            ? context.l(Ob.loadingStatus)
            : onboardingMessage(context, failure!),
        key: const Key('status-loading'),
        textAlign: TextAlign.center,
        style: ts(14, c: failure == null ? AppColors.slate : AppColors.danger),
      ),
    ),
  );
}

class _Missing extends StatelessWidget {
  const _Missing({required this.items});
  final List<String> items;

  @override
  Widget build(BuildContext context) {
    final ar = context.isAr;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppColors.lineSoft),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(context.l(Ob.stillMissing), style: ts(14, w: 700)),
          const SizedBox(height: 8),
          for (final m in items)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Text(
                '• ${Ob.missingItem(m, ar)}',
                style: ts(13.5, c: AppColors.slate),
              ),
            ),
        ],
      ),
    );
  }
}
