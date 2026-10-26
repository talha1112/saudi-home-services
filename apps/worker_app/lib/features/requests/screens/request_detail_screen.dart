import 'package:flutter/material.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/jobs_scope.dart';
import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/saudi_time.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tiles.dart';
import '../../quotes/widgets/quote_money_card.dart';

/// An open request, as the backend shows it to this worker: what, when, and the AREA only. The street address, the exact point and the
/// customer's name and phone are not part of the response until the customer has paid, so there is nothing to show here (and no map).
class RequestDetailScreen extends StatefulWidget {
  const RequestDetailScreen({super.key, required this.request});

  /// The request as listed; the detail (description, photos) is fetched on opening.
  final WorkerRequest request;

  @override
  State<RequestDetailScreen> createState() => _RequestDetailScreenState();
}

enum _Load { loading, ready, failed, gone }

class _RequestDetailScreenState extends State<RequestDetailScreen> {
  late WorkerRequest _request = widget.request;
  _Load _load = _Load.loading;
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_started) {
      _started = true;
      _fetch();
    }
  }

  Future<void> _fetch() async {
    setState(() => _load = _Load.loading);
    try {
      final detail = await JobsScope.of(
        context,
      ).jobs.requestDetail(widget.request.id);
      if (!mounted) return;
      setState(() {
        _request = detail;
        _load = _Load.ready;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _load = e.status == 404 ? _Load.gone : _Load.failed);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ar = context.isAr;
    final jobs = JobsScope.of(context).jobs;
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: ListenableBuilder(
          listenable: jobs,
          builder: (context, _) {
            // a quote sent from the next screen shows up here without another request
            final listed = jobs.requests.where((r) => r.id == _request.id);
            final quote = listed.isNotEmpty
                ? listed.first.myQuote
                : _request.myQuote;
            final r = _request;
            final area = _area(r.location, ar);
            return Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 6, 20, 12),
                  child: Row(
                    children: [
                      SquareIconButton.back(context),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '${context.tr('newRequest')} · ${r.reference}',
                              style: ts(
                                12.5,
                                c: AppColors.slate,
                                family: kLatinFont,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            Text(
                              r.service.name(arabic: ar),
                              key: const Key('request-service'),
                              style: ts(20, w: 700),
                              maxLines: 2,
                            ),
                          ],
                        ),
                      ),
                      if (r.isUrgent)
                        Pill(
                          context.tr('wjUrgent'),
                          bg: AppColors.cream,
                          fg: AppColors.creamText,
                          fontSize: 12,
                          weight: 700,
                        ),
                    ],
                  ),
                ),
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
                    children: [
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          _Info(
                            icon: 'calendar',
                            label: context.tr('schedule'),
                            value: windowLabel(
                              r.preferredStartAt,
                              r.preferredEndAt,
                              arabic: ar,
                            ),
                          ),
                          const SizedBox(width: 10),
                          _Info(
                            icon: 'pin',
                            label: context.tr('location'),
                            value: area,
                          ),
                        ],
                      ),
                      const SizedBox(height: 10),
                      AppCard(
                        padding: const EdgeInsets.all(14),
                        radius: 16,
                        child: Row(
                          children: [
                            const AppIcon(
                              'clock',
                              size: 17,
                              color: AppColors.slate,
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text(
                                '${context.tr('wjExpires')} ${whenLabel(r.expiresAt, arabic: ar)}',
                                style: ts(13.5, c: AppColors.slate),
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 16),
                      Text(context.tr('issue'), style: ts(16, w: 700)),
                      const SizedBox(height: 10),
                      AppCard(
                        padding: const EdgeInsets.all(14),
                        radius: 16,
                        child: _description(context, r),
                      ),
                      if (r.photoCount > 0) ...[
                        const SizedBox(height: 10),
                        Text(
                          context
                              .tr('wjPhotos')
                              .replaceAll('{n}', '${r.photoCount}'),
                          key: const Key('request-photos'),
                          style: ts(13, c: AppColors.slate),
                        ),
                      ],
                      const SizedBox(height: 16),
                      Container(
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: AppColors.chip,
                          borderRadius: BorderRadius.circular(16),
                        ),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const AppIcon(
                              'lock',
                              size: 17,
                              color: AppColors.slate,
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Text(
                                context.tr('wjAreaOnly'),
                                key: const Key('area-only-note'),
                                style: ts(12.5, c: AppColors.slate, h: 1.45),
                              ),
                            ),
                          ],
                        ),
                      ),
                      if (quote != null) ...[
                        const SizedBox(height: 16),
                        QuoteMoneyCard(quote: quote),
                      ],
                    ],
                  ),
                ),
                if (quote == null && _load != _Load.gone)
                  BottomBar(
                    child: AppButton(
                      key: const Key('request-send-quote'),
                      label: context.tr('wjSendQuote'),
                      onPressed: () => AppRouter.toSendQuote(context, r),
                    ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _description(BuildContext context, WorkerRequest r) {
    switch (_load) {
      case _Load.loading:
        return const Padding(
          padding: EdgeInsets.symmetric(vertical: 8),
          child: Center(
            child: SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2.4),
            ),
          ),
        );
      case _Load.failed:
        return Row(
          children: [
            Expanded(
              child: Text(
                context.tr('wjLoadFailed'),
                style: ts(13.5, c: AppColors.slate),
              ),
            ),
            AppButton(
              key: const Key('request-retry'),
              label: context.tr('retry'),
              expand: false,
              height: 38,
              radius: 12,
              fontSize: 13.5,
              onPressed: _fetch,
            ),
          ],
        );
      case _Load.gone:
        return Text(
          context.tr('wjRequestGone'),
          key: const Key('request-gone'),
          style: ts(14.5, h: 1.55),
        );
      case _Load.ready:
        return Text(
          r.problemDescription ?? '',
          key: const Key('request-description'),
          style: ts(14.5, h: 1.55),
        );
    }
  }
}

String _area(BookingLocation l, bool ar) {
  final city = ar && l.cityNameAr.isNotEmpty ? l.cityNameAr : l.cityNameEn;
  return [
    if (l.district != null && l.district!.isNotEmpty) l.district!,
    city,
  ].where((p) => p.isNotEmpty).join(' · ');
}

class _Info extends StatelessWidget {
  const _Info({required this.icon, required this.label, required this.value});
  final String icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: AppCard(
        padding: const EdgeInsets.all(12),
        radius: 16,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            AppIcon(icon, size: 17, color: AppColors.primary),
            const SizedBox(height: 4),
            Text(label, style: ts(12, c: AppColors.slate)),
            const SizedBox(height: 4),
            Text(value, style: ts(14, w: 600)),
          ],
        ),
      ),
    );
  }
}
