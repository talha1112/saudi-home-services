import 'package:flutter/material.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/booking_scope.dart';
import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/config/demo_data.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/dashed.dart';
import '../../../shared/components/inputs.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../widgets/offer_cards.dart';

class OffersScreen extends StatefulWidget {
  const OffersScreen({super.key});

  @override
  State<OffersScreen> createState() => _OffersScreenState();
}

class _OffersScreenState extends State<OffersScreen> {
  OffersController? _offers;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (kDemoData) return;
    final next = BookingScope.of(context).offers;
    if (identical(next, _offers)) return;
    _offers = next;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && context.auth.isSignedIn) _offers!.load();
    });
  }

  /// "Ends 15 Oct" in the language of the app, in Saudi time.
  String _ends(OfferItem o, bool ar) {
    final end = o.endsAt;
    if (end == null) return '';
    final d = end.toUtc().add(const Duration(hours: 3));
    const en = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const ara = [
      'يناير',
      'فبراير',
      'مارس',
      'أبريل',
      'مايو',
      'يونيو',
      'يوليو',
      'أغسطس',
      'سبتمبر',
      'أكتوبر',
      'نوفمبر',
      'ديسمبر',
    ];
    final day = '${d.day} ${(ar ? ara : en)[d.month - 1]}';
    return ar ? 'ينتهي $day' : 'Ends $day';
  }

  @override
  Widget build(BuildContext context) {
    // Real builds show the offers the administrators published for customers. They are announcements: there are no codes to enter.
    if (!kDemoData) {
      final offers = _offers!;
      final catalog = BookingScope.of(context).catalog;
      return ListenableBuilder(
        listenable: Listenable.merge([offers, catalog]),
        builder: (context, _) {
          final ar = context.isAr;
          return RefreshIndicator(
            onRefresh: offers.load,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 28),
              children: [
                Text(context.tr('offers'), style: ts(26, w: 700)),
                if (offers.status == FeedStatus.idle ||
                    offers.status == FeedStatus.loading)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 60),
                    child: Center(
                      child: CircularProgressIndicator(strokeWidth: 2.6),
                    ),
                  )
                else if (offers.status == FeedStatus.failed)
                  EmptyState(
                    icon: 'tag',
                    title: context.tr('offersFailed'),
                    subtitle: '',
                    actionLabel: context.tr('retry'),
                    onAction: offers.load,
                    verticalPadding: 60,
                  )
                else if (offers.items.isEmpty)
                  EmptyState(
                    icon: 'tag',
                    title: context.tr('noOffers'),
                    subtitle: context.tr('noOffersSub'),
                    verticalPadding: 60,
                  )
                else ...[
                  const SizedBox(height: 16),
                  for (final o in offers.items) ...[
                    RealOfferCard(
                      key: Key('offer-${o.id}'),
                      offer: o,
                      serviceName: catalog.serviceById(o.serviceId) == null
                          ? null
                          : context.l(catalog.serviceById(o.serviceId)!.name),
                      endsLabel: _ends(o, ar),
                      onBook: () => catalog.serviceById(o.serviceId) != null
                          ? AppRouter.toDetails(context, o.serviceId!)
                          : AppRouter.toServices(context),
                    ),
                    const SizedBox(height: 16),
                  ],
                ],
              ],
            ),
          );
        },
      );
    }
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 28),
      children: [
        Text(context.tr('offers'), style: ts(26, w: 700)),
        const SizedBox(height: 16),
        Row(
          children: [
            Expanded(
              child: DashedBox(
                radius: 16,
                height: 50,
                color: const Color(0xFFD5DDE2),
                background: Colors.white,
                padding: const EdgeInsets.symmetric(horizontal: 14),
                alignment: Alignment.center,
                child: Row(
                  children: [
                    const AppIcon('tag', size: 18, color: AppColors.slate),
                    const SizedBox(width: 10),
                    Expanded(
                      child: BareField(
                        hint: context.tr('haveCode'),
                        fontSize: 14.5,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 8),
            AppButton(
              label: context.tr('apply'),
              kind: AppButtonKind.dark,
              height: 50,
              radius: 16,
              fontSize: 15,
              expand: false,
              padding: const EdgeInsets.symmetric(horizontal: 18),
            ),
          ],
        ),
        const SizedBox(height: 16),
        AcOfferCard(onBook: () => AppRouter.toDetails(context, 'acdeep')),
        const SizedBox(height: 16),
        FirstBookingBigCard(onBook: () => AppRouter.toServices(context)),
        const SizedBox(height: 16),
        LimitedOfferCard(onBook: () => AppRouter.toDetails(context, 'socket')),
        const SizedBox(height: 16),
        const NewOfferCard(),
      ],
    );
  }
}
