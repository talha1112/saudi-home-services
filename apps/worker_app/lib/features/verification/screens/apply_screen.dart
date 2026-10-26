import 'package:flutter/material.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/step_bar.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/tiles.dart';
import '../services/document_picker.dart';
import '../utils/onboarding_text.dart';
import '../widgets/apply_form.dart';
import '../widgets/apply_steps.dart';

/// Four-step provider application. Every step is saved to the backend before moving on, the form is filled from what the server already
/// has, and submitting uses the real verification endpoint. Nothing is marked done unless the server accepted it.
class ApplyScreen extends StatefulWidget {
  const ApplyScreen({super.key, this.initialStep = 1});

  final int initialStep;

  @override
  State<ApplyScreen> createState() => _ApplyScreenState();
}

class _ApplyScreenState extends State<ApplyScreen> with WidgetsBindingObserver {
  late int _step = widget.initialStep;
  final _draft = ApplyDraft();
  WorkerOnboardingController? _ob;
  AuthController? _auth;
  OnboardingFailure? _shown;
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
      _ob?.removeListener(_onChanged);
      _ob = ob..addListener(_onChanged);
      _load();
    }
    final auth = context.authRead;
    if (!identical(auth, _auth)) {
      _auth?.removeListener(_onAuthChanged);
      _auth = auth..addListener(_onAuthChanged);
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _ob?.refresh(); // throttled
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _ob?.removeListener(_onChanged);
    _auth?.removeListener(_onAuthChanged);
    _draft.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final ob = _ob!;
    ob.loadCatalog(); // public list of services and cities for step 2
    await ob.refresh();
    if (!mounted) return;
    final data = ob.onboarding;
    if (data != null) _draft.seed(data);
    _routeByStatus();
  }

  void _onChanged() {
    if (!mounted) return;
    setState(() => _shown = _ob?.failure);
  }

  void _onAuthChanged() {
    final auth = _auth;
    if (auth == null || _leaving || !mounted) return;
    if (auth.status == AuthStatus.signedOut) {
      _leaving = true;
      AppRouter.toWelcomeReset(context);
    }
  }

  /// The server decides who may edit: a pending, approved or suspended application belongs on the status screen.
  void _routeByStatus() {
    final state = _ob?.verification?.state;
    if (state == null || _leaving) return;
    if (state.isPending ||
        state == VerificationState.approved ||
        state == VerificationState.suspended) {
      _leaving = true;
      AppRouter.toStatusReset(context);
    }
  }

  void _back() {
    if (_step > 1) {
      setState(() => _step--);
    } else {
      Navigator.of(context).maybePop();
    }
  }

  /// The profile photo the server has stored (an upload counts only once the server confirmed it).
  bool get _hasPhoto => (_ob?.onboarding?.documents ?? const <WorkerDocument>[])
      .any((d) => d.kind == DocumentKind.photo && d.isUsable);

  bool get _canContinue => switch (_step) {
    1 => _draft.profileValid && _hasPhoto,
    2 => _draft.areaValid,
    3 => _draft.availabilityValid,
    _ => true,
  };

  Future<void> _continue() async {
    final ob = context.onboardingRead;
    var ok = true;
    switch (_step) {
      case 1:
        ok = await ob.saveProfile(
          fullName: _draft.fullName.text.trim(),
          fullNameAr: _draft.fullNameAr.text.trim().isEmpty
              ? null
              : _draft.fullNameAr.text.trim(),
          bio: _draft.bio.text.trim(),
          yearsOfExperience: _draft.yearsValue,
        );
      case 2:
        ok =
            await ob.saveServices(_draft.services) &&
            await ob.saveAreas(_draft.cities);
      case 3:
        ok = await ob.saveAvailability(_draft.windows);
      default:
        ok = await ob.submit();
        if (ok && mounted) {
          AppRouter.toStatusReset(context);
          return;
        }
    }
    if (!mounted) return;
    if (ok && _step < 4) {
      setState(() => _step++);
      if (_step == 4) ob.refresh(force: true);
    } else if (!ok && ob.failure?.issue == OnboardingIssue.invalidState) {
      await ob.refresh(force: true);
      _routeByStatus();
    }
  }

  Future<void> _upload(DocumentKind kind) async {
    final picked = await DocumentPickerScope.of(
      context,
    ).pick(imagesOnly: kind == DocumentKind.photo);
    if (picked == null || !mounted) return;
    await context.onboardingRead.uploadDocument(
      kind: kind,
      fileName: picked.name,
      bytes: picked.bytes,
    );
  }

  Future<void> _remove(String id) async {
    await context.onboardingRead.deleteDocument(id);
  }

  @override
  Widget build(BuildContext context) {
    final ar = context.isAr;
    final ob = context.onboarding;
    final loading = !ob.loadedOnce;
    final loadFailed = ob.loadedOnce && ob.onboarding == null;
    final busy = ob.busy;
    final failure = _shown;
    return PopScope(
      canPop: _step == 1,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _back();
      },
      child: Scaffold(
        body: SafeArea(
          bottom: false,
          child: ListenableBuilder(
            listenable: _draft,
            builder: (context, _) {
              return Column(
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 6, 20, 0),
                    child: Row(
                      children: [
                        SquareIconButton.back(context, onTap: _back),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                ar ? 'الخطوة $_step من 4' : 'Step $_step of 4',
                                style: ts(12.5, c: AppColors.slate),
                              ),
                              const SizedBox(height: 1),
                              Text(
                                context.l(Ob.stepTitles[_step - 1]),
                                style: ts(18, w: 700),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 14, 20, 0),
                    child: StepBar(step: _step, total: 4),
                  ),
                  Expanded(
                    child: loading
                        ? Center(
                            child: Text(
                              context.l(Ob.loadingStatus),
                              style: ts(14, c: AppColors.slate),
                            ),
                          )
                        : loadFailed
                        ? _LoadError(
                            message: failure == null
                                ? ''
                                : onboardingMessage(context, failure),
                            onRetry: _load,
                          )
                        : ListView(
                            padding: const EdgeInsets.fromLTRB(20, 20, 20, 24),
                            children: [
                              switch (_step) {
                                1 => PersonalStep(
                                  draft: _draft,
                                  onUpload: _upload,
                                  onRemove: _remove,
                                ),
                                2 => ServicesStep(draft: _draft),
                                3 => AvailabilityStep(draft: _draft),
                                _ => DocumentsStep(
                                  onUpload: _upload,
                                  onRemove: _remove,
                                ),
                              },
                              if (failure != null) ...[
                                const SizedBox(height: 16),
                                Container(
                                  key: const Key('apply-error'),
                                  padding: const EdgeInsets.all(12),
                                  decoration: BoxDecoration(
                                    color: AppColors.dangerBg,
                                    borderRadius: BorderRadius.circular(14),
                                    border: Border.all(
                                      color: AppColors.dangerBorder,
                                    ),
                                  ),
                                  child: Text(
                                    onboardingMessage(context, failure),
                                    style: ts(
                                      13.5,
                                      c: AppColors.dangerText,
                                      h: 1.45,
                                    ),
                                  ),
                                ),
                              ],
                            ],
                          ),
                  ),
                  BottomBar(
                    child: AppButton(
                      label: context.l(
                        busy
                            ? (_step == 4 ? Ob.submitting : Ob.saving)
                            : (_step == 4
                                  ? (ob.verification?.state ==
                                                VerificationState
                                                    .infoRequired ||
                                            ob.verification?.state ==
                                                VerificationState.rejected
                                        ? Ob.resubmit
                                        : Ob.submit)
                                  : Ob.cont),
                      ),
                      enabled: !loading && !loadFailed && !busy && _canContinue,
                      onPressed: _continue,
                    ),
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

class _LoadError extends StatelessWidget {
  const _LoadError({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            message,
            textAlign: TextAlign.center,
            style: ts(14, c: AppColors.danger),
          ),
          const SizedBox(height: 14),
          AppButton(
            label: context.l(Ob.retry),
            kind: AppButtonKind.soft,
            onPressed: onRetry,
          ),
        ],
      ),
    ),
  );
}
