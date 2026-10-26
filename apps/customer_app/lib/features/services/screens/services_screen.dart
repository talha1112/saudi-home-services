import 'package:flutter/material.dart';

import '../../../app/booking_scope.dart';
import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/config/demo_data.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../catalog/catalog_controller.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tiles.dart';
import '../widgets/service_list_card.dart';

class ServicesScreen extends StatefulWidget {
  const ServicesScreen({super.key, this.initialCategory = 'all'});

  final String initialCategory;

  @override
  State<ServicesScreen> createState() => _ServicesScreenState();
}

class _ServicesScreenState extends State<ServicesScreen> {
  late String _category = widget.initialCategory;
  final _search = TextEditingController();
  bool _availableToday = false;
  bool _topRated = false;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  void _clear() => setState(() {
    _search.clear();
    _category = 'all';
    _availableToday = false;
    _topRated = false;
  });

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: BookingScope.of(context).catalog,
      builder: (context, _) => _content(context),
    );
  }

  Widget _content(BuildContext context) {
    final query = _search.text.trim().toLowerCase();
    final catalog = BookingScope.of(context).catalog;
    final results = catalog.services.where((s) {
      if (_category != 'all' && s.category != _category) return false;
      if (_topRated && (s.rating ?? 0) < 4.8) return false;
      if (query.isNotEmpty &&
          !s.name.en.toLowerCase().contains(query) &&
          !s.name.ar.contains(query) &&
          !s.description.en.toLowerCase().contains(query) &&
          !s.description.ar.contains(query)) {
        return false;
      }
      return true;
    }).toList();

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            ScreenHeader(
              title: context.tr('categories'),
              trailing: !kDemoData
                  ? null
                  : Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 8,
                      ),
                      decoration: BoxDecoration(
                        color: AppColors.tealTint,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const AppIcon(
                            'pin',
                            size: 14,
                            color: AppColors.primary,
                          ),
                          const SizedBox(width: 5),
                          Text(
                            context.tr('riyadh'),
                            style: ts(13, w: 600, c: AppColors.primary),
                          ),
                        ],
                      ),
                    ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: Container(
                height: 52,
                padding: const EdgeInsets.symmetric(horizontal: 14),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: AppColors.line),
                ),
                child: Row(
                  children: [
                    const AppIcon('search', size: 20, color: AppColors.slate),
                    const SizedBox(width: 10),
                    Expanded(
                      child: TextField(
                        controller: _search,
                        onChanged: (_) => setState(() {}),
                        cursorColor: AppColors.primary,
                        style: ts(15),
                        decoration: InputDecoration.collapsed(
                          hintText: context.tr('search'),
                          hintStyle: ts(15, c: AppColors.muted),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            SizedBox(
              height: 54,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.fromLTRB(20, 14, 20, 0),
                children: [
                  for (final c in [null, ...catalog.categories]) ...[
                    SelectChip(
                      label: c == null ? context.tr('all') : context.l(c.name),
                      selected: _category == (c?.id ?? 'all'),
                      onTap: () => setState(() => _category = c?.id ?? 'all'),
                    ),
                    const SizedBox(width: 8),
                  ],
                ],
              ),
            ),
            if (kDemoData)
              SizedBox(
                height: 58,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.fromLTRB(20, 10, 20, 14),
                  children: [
                    SelectChip(
                      label: context.tr('availToday'),
                      icon: 'calendar',
                      selected: _availableToday,
                      height: 34,
                      radius: 10,
                      fontSize: 13,
                      weight: 500,
                      horizontal: 12,
                      selectedBg: AppColors.tealTint,
                      selectedFg: AppColors.primary,
                      selectedBorder: AppColors.tealBorder,
                      unselectedFg: AppColors.slate,
                      onTap: () =>
                          setState(() => _availableToday = !_availableToday),
                    ),
                    const SizedBox(width: 8),
                    SelectChip(
                      label: context.tr('rated48'),
                      icon: 'star',
                      selected: _topRated,
                      height: 34,
                      radius: 10,
                      fontSize: 13,
                      weight: 500,
                      horizontal: 12,
                      selectedBg: AppColors.tealTint,
                      selectedFg: AppColors.primary,
                      selectedBorder: AppColors.tealBorder,
                      unselectedFg: AppColors.slate,
                      onTap: () => setState(() => _topRated = !_topRated),
                    ),
                    const SizedBox(width: 8),
                    SelectChip(
                      label: context.tr('price'),
                      icon: 'sliders',
                      selected: false,
                      height: 34,
                      radius: 10,
                      fontSize: 13,
                      weight: 500,
                      horizontal: 12,
                      unselectedFg: AppColors.slate,
                      onTap: () {},
                    ),
                  ],
                ),
              ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 28),
                children: [
                  for (final s in results) ...[
                    ServiceListCard(
                      service: s,
                      onOpen: () => AppRouter.toDetails(context, s.id),
                      onBook: () =>
                          AppRouter.toBooking(context, serviceId: s.id),
                    ),
                    const SizedBox(height: 14),
                  ],
                  if (catalog.status == CatalogStatus.idle ||
                      catalog.status == CatalogStatus.loading)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 48),
                      child: Center(
                        child: CircularProgressIndicator(strokeWidth: 2.6),
                      ),
                    )
                  else if (catalog.status == CatalogStatus.failed)
                    EmptyState(
                      icon: 'search',
                      title: context.tr('catLoadFailed'),
                      subtitle: '',
                      actionLabel: context.tr('retry'),
                      onAction: () => catalog.load(force: true),
                    )
                  else if (results.isEmpty)
                    EmptyState(
                      icon: 'search',
                      title: context.tr('noResults'),
                      subtitle: context.tr('noResultsSub'),
                      actionLabel: context.tr('clear'),
                      onAction: _clear,
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
