import 'package:flutter/material.dart';

import 'package:hs_client/hs_client.dart';

import '../../../app/booking_scope.dart';
import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/config/demo_data.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/models/mock_data.dart';
import '../../../shared/models/service.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';
import '../widgets/active_booking_card.dart';
import '../widgets/category_card.dart';
import '../widgets/home_list_rows.dart';
import '../widgets/home_offer_cards.dart';
import '../widgets/real_active_booking.dart';
import '../../catalog/catalog_controller.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final ar = context.isAr;
    final catalog = BookingScope.of(context).catalog;
    final name = context.auth.user?.fullName?.trim() ?? '';
    return ListView(
      padding: const EdgeInsets.only(top: 4, bottom: 28),
      children: [
        // Greeting
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 6, 20, 0),
          child: Row(
            children: [
              InitialsTile(
                kDemoData ? context.tr('ini') : _initial(name),
                size: 48,
                fontSize: 18,
                radius: 16,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      context.tr('hello'),
                      style: ts(13.5, c: AppColors.slate),
                    ),
                    const SizedBox(height: 2),
                    if (kDemoData || name.isNotEmpty)
                      Text(
                        kDemoData ? context.tr('userName') : name,
                        style: ts(19, w: 700),
                      ),
                  ],
                ),
              ),
              const _Bell(),
            ],
          ),
        ),
        if (kDemoData)
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 10, 20, 0),
            child: Row(
              children: [
                const AppIcon('pin', size: 15, color: AppColors.slate),
                const SizedBox(width: 6),
                Text(
                  context.tr('addrShort'),
                  style: ts(13, c: AppColors.slate),
                ),
                const SizedBox(width: 6),
                const AppIcon('chevron-down', size: 15, color: AppColors.slate),
              ],
            ),
          ),
        // Search
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
          child: Tap(
            onTap: () => AppRouter.toServices(context),
            child: Container(
              height: 56,
              padding: const EdgeInsetsDirectional.fromSTEB(16, 0, 8, 0),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(18),
                border: Border.all(color: AppColors.line),
                boxShadow: kSoftShadow,
              ),
              child: Row(
                children: [
                  const AppIcon('search', size: 21, color: AppColors.slate),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      context.tr('search'),
                      style: ts(15.5, c: AppColors.slate),
                    ),
                  ),
                  const IconTile(
                    'sliders',
                    size: 40,
                    radius: 13,
                    iconSize: 17,
                    bg: AppColors.primary,
                    fg: Colors.white,
                  ),
                ],
              ),
            ),
          ),
        ),
        if (!kDemoData) const RealActiveBooking(),
        if (app.hasActive)
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 20, 20, 0),
            child: ActiveBookingCard(
              state: app,
              onTrack: () => AppRouter.toTrack(context),
            ),
          ),
        // Categories and services: the backend catalog
        ListenableBuilder(
          listenable: catalog,
          builder: (context, _) => _CatalogSection(catalog: catalog),
        ),
        if (kDemoData) ...[
          // Prototype content (demo builds only)
          // Offers
          SectionHeader(
            context.tr('offers'),
            action: context.tr('seeAll'),
            onAction: () => app.showTab(2),
          ),
          SizedBox(
            height: 160,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 6),
              children: [
                DarkOfferCard(
                  onTap: () => AppRouter.toDetails(context, 'acdeep'),
                ),
                const SizedBox(width: 12),
                FirstBookingOfferCard(onTap: () => app.showTab(2)),
              ],
            ),
          ),
          // Recommended
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 26, 20, 12),
            child: Text(context.tr('recommended'), style: ts(18, w: 700)),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: Column(
              children: [
                for (final s in [kServices[3], kServices[5]]) ...[
                  RecommendedServiceRow(
                    service: s,
                    onTap: () => AppRouter.toDetails(context, s.id),
                  ),
                  const SizedBox(height: 10),
                ],
              ],
            ),
          ),
          // Recent
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 12),
            child: Text(context.tr('recent'), style: ts(18, w: 700)),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: Column(
              children: [
                RecentBookingRow(
                  service: serviceById('leak'),
                  date: ar ? '21 سبتمبر' : '21 Sep',
                  worker: context.l(kWorkers[1].name),
                  onAgain: () =>
                      AppRouter.toBooking(context, serviceId: 'leak'),
                ),
                const SizedBox(height: 10),
                RecentBookingRow(
                  service: serviceById('light'),
                  date: ar ? '2 سبتمبر' : '2 Sep',
                  worker: context.l(kWorkers[2].name),
                  onAgain: () =>
                      AppRouter.toBooking(context, serviceId: 'light'),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}

/// The notification bell. The gold dot is there only while the server counts unread notifications.
class _Bell extends StatefulWidget {
  const _Bell();

  @override
  State<_Bell> createState() => _BellState();
}

class _BellState extends State<_Bell> {
  NotificationsController? _c;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final next = BookingScope.of(context).notifications;
    if (!identical(next, _c)) {
      _c = next;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && context.auth.isSignedIn) _c!.refreshUnread();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _c!,
      builder: (context, _) => Stack(
        clipBehavior: Clip.none,
        children: [
          SquareIconButton(
            icon: 'bell',
            size: 46,
            radius: 15,
            iconSize: 21,
            onTap: () async {
              await AppRouter.toNotifications(context);
              if (mounted) _c!.refreshUnread();
            },
          ),
          if (_c!.unread > 0)
            PositionedDirectional(
              key: const Key('bell-unread'),
              top: 10,
              end: 11,
              child: Container(
                width: 9,
                height: 9,
                decoration: BoxDecoration(
                  color: AppColors.gold,
                  shape: BoxShape.circle,
                  border: Border.all(color: Colors.white, width: 2),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _QuickChip extends StatelessWidget {
  const _QuickChip({required this.service, required this.onTap});

  final Service service;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Tap(
      onTap: onTap,
      child: Container(
        height: 38,
        padding: const EdgeInsetsDirectional.only(start: 6, end: 13),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(19),
          border: Border.all(color: AppColors.line),
        ),
        child: Row(
          children: [
            Container(
              width: 26,
              height: 26,
              alignment: Alignment.center,
              decoration: const BoxDecoration(
                color: AppColors.tealTint,
                shape: BoxShape.circle,
              ),
              child: AppIcon(service.icon, size: 14, color: AppColors.primary),
            ),
            const SizedBox(width: 8),
            Text(context.l(service.name), style: ts(13, w: 600)),
            if (service.was != null) ...[
              const SizedBox(width: 8),
              const Pill(
                '−20%',
                bg: AppColors.gold,
                fg: AppColors.text,
                fontSize: 10,
                weight: 800,
                radius: 6,
                padding: EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

String _initial(String name) =>
    name.isEmpty ? '•' : String.fromCharCode(name.runes.first).toUpperCase();

/// Categories and a few quick links, from the catalog. Loading, failing and "nothing yet" are shown as such.
class _CatalogSection extends StatelessWidget {
  const _CatalogSection({required this.catalog});

  final CatalogController catalog;

  static final _styles = [
    CategoryCardStyle.teal,
    CategoryCardStyle.tint,
    CategoryCardStyle.dark,
  ];

  @override
  Widget build(BuildContext context) {
    final ar = context.isAr;
    final categories = catalog.categories;
    final services = catalog.services;
    Widget message(String text, {bool retry = false}) => Padding(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 0),
      child: Row(
        children: [
          Expanded(
            child: Text(text, style: ts(13.5, c: AppColors.slate)),
          ),
          if (retry)
            Tap(
              key: const Key('retry-catalog'),
              onTap: () => catalog.load(force: true),
              child: Text(
                context.tr('retry'),
                style: ts(13.5, w: 600, c: AppColors.primary),
              ),
            ),
        ],
      ),
    );

    final Widget body;
    if (catalog.status == CatalogStatus.idle ||
        catalog.status == CatalogStatus.loading) {
      body = const Padding(
        padding: EdgeInsets.symmetric(vertical: 24),
        child: Center(child: CircularProgressIndicator(strokeWidth: 2.6)),
      );
    } else if (catalog.status == CatalogStatus.failed) {
      body = message(context.tr('catLoadFailed'), retry: true);
    } else if (categories.isEmpty) {
      body = message(context.tr('catEmpty'));
    } else {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            height: 140,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 20),
              children: [
                for (var i = 0; i < categories.length; i++) ...[
                  if (i > 0) const SizedBox(width: 10),
                  SizedBox(
                    width: 130,
                    child: CategoryCard(
                      category: categories[i],
                      subtitle: _count(
                        services
                            .where((s) => s.category == categories[i].id)
                            .length,
                        ar,
                      ),
                      style: _styles[i % _styles.length],
                      onTap: () => AppRouter.toServices(
                        context,
                        category: categories[i].id,
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
          SizedBox(
            height: 52,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 2),
              children: [
                for (final s in services.take(6)) ...[
                  _QuickChip(
                    service: s,
                    onTap: () => AppRouter.toDetails(context, s.id),
                  ),
                  const SizedBox(width: 8),
                ],
              ],
            ),
          ),
        ],
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SectionHeader(
          context.tr('categories'),
          action: context.tr('seeAll'),
          onAction: () => AppRouter.toServices(context),
        ),
        body,
      ],
    );
  }
}

String _count(int n, bool ar) => ar
    ? '$n ${n == 1 ? 'خدمة' : 'خدمات'}'
    : '$n ${n == 1 ? 'service' : 'services'}';
