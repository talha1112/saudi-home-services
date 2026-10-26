import 'dart:async';

import 'package:flutter/material.dart';

import '../../../app/localization/app_strings.dart';
import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/price_breakdown.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';
import '../models/payment_method.dart';

class PayScreen extends StatefulWidget {
  const PayScreen({super.key});

  @override
  State<PayScreen> createState() => _PayScreenState();
}

class _PayScreenState extends State<PayScreen> {
  bool _paying = false;
  bool _failed = false;
  bool _failedOnce = false;
  Timer? _timer;

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _pay() {
    if (_paying) return;
    setState(() {
      _paying = true;
      _failed = false;
    });
    _timer = Timer(const Duration(milliseconds: 1400), () {
      if (!mounted) return;
      final app = context.appRead;
      if (app.simulatePayFailure && !_failedOnce) {
        setState(() {
          _paying = false;
          _failed = true;
          _failedOnce = true;
        });
      } else {
        app.update(() {
          app.stage = 2;
          app.cancelled = false;
        });
        AppRouter.toConfirm(context);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final ar = context.isAr;
    final label = _paying
        ? context.tr('processing')
        : (_failed
              ? context.tr('tryAgain')
              : (ar
                    ? 'ادفع ${context.sar(app.total)} وأكّد الحجز'
                    : 'Pay ${context.sar(app.total)} & confirm'));
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            ScreenHeader(title: context.tr('payment')),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
                children: [
                  if (_failed) ...[
                    const _FailureBanner(),
                    const SizedBox(height: 16),
                  ],
                  AppCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Row(
                          children: [
                            IconTile(
                              app.service.icon,
                              size: 44,
                              radius: 14,
                              iconSize: 21,
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    context.l(app.service.name),
                                    style: ts(15, w: 600),
                                  ),
                                  const SizedBox(height: 2),
                                  Text(
                                    '${app.whenLabel(ar)} · ${context.l(app.worker.name)}',
                                    style: ts(12.5, c: AppColors.slate),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 12),
                        const HairlineDivider(),
                        const SizedBox(height: 12),
                        const PriceBreakdown(fontSize: 14, spacing: 12),
                      ],
                    ),
                  ),
                  const SizedBox(height: 20),
                  Text(context.tr('payMethod'), style: ts(16, w: 700)),
                  const SizedBox(height: 16),
                  for (final m in kPaymentMethods) ...[
                    _MethodTile(
                      method: m,
                      sub: m.sub is Bi
                          ? context.l(m.sub as Bi)
                          : (m.subBuilder!(app.total, ar)),
                      selected: app.payMethod == m.id && !m.unavailable,
                      onTap: () {
                        if (m.unavailable) return;
                        app.update(() => app.payMethod = m.id);
                        setState(() => _failed = false);
                      },
                    ),
                    const SizedBox(height: 8),
                  ],
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      const AppIcon('lock', size: 15, color: AppColors.primary),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          context.tr('secure'),
                          style: ts(12.5, c: AppColors.slate, h: 1.45),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            BottomBar(
              child: AppButton(
                label: label,
                onPressed: _pay,
                leading: _paying ? const _Spinner() : null,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MethodTile extends StatelessWidget {
  const _MethodTile({
    required this.method,
    required this.sub,
    required this.selected,
    required this.onTap,
  });

  final PaymentMethod method;
  final String sub;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Tap(
      onTap: onTap,
      child: Opacity(
        opacity: method.unavailable ? .5 : 1,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
              color: selected ? AppColors.primary : AppColors.lineSoft,
              width: 1.5,
            ),
          ),
          child: Row(
            children: [
              Container(
                width: 52,
                height: 34,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: AppColors.chip,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: AppColors.line),
                ),
                child: Text(
                  method.logo,
                  style: ts(11, w: 800, family: kLatinFont, ls: -0.11),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      method.name is Bi
                          ? context.l(method.name as Bi)
                          : method.name as String,
                      style: ts(14.5, w: 600),
                    ),
                    const SizedBox(height: 2),
                    Text(sub, style: ts(12, c: AppColors.slate)),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              RadioDot(selected: selected),
            ],
          ),
        ),
      ),
    );
  }
}

class _FailureBanner extends StatelessWidget {
  const _FailureBanner();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.dangerBg,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.dangerBorder),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const IconTile(
            'alert',
            size: 36,
            radius: 12,
            iconSize: 19,
            bg: Colors.white,
            fg: AppColors.danger,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  context.tr('payFailed'),
                  style: ts(15, w: 700, c: AppColors.dangerText),
                ),
                const SizedBox(height: 3),
                Text(
                  context.tr('payFailedSub'),
                  style: ts(13, c: AppColors.dangerText, h: 1.45),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Spinner extends StatelessWidget {
  const _Spinner();

  @override
  Widget build(BuildContext context) {
    return const SizedBox(
      width: 18,
      height: 18,
      child: CircularProgressIndicator(
        strokeWidth: 2.5,
        color: Colors.white,
        backgroundColor: Color(0x59FFFFFF),
      ),
    );
  }
}
