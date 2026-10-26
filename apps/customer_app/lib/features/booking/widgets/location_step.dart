import 'package:flutter/material.dart';

import '../../../app/app_state.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../location/models/picked_location.dart';
import '../../../shared/components/dashed.dart';
import '../../../app/booking_scope.dart';
import '../../catalog/catalog_controller.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';
import '../../../app/router/app_router.dart';
import 'booking_map_preview.dart';

class LocationStep extends StatelessWidget {
  const LocationStep({super.key});

  Future<void> _openPicker(BuildContext context) async {
    final app = context.appRead;
    final picked = await AppRouter.toLocationPicker(
      context,
      initial: app.pickedLocation,
    );
    if (picked == null) return;
    app.update(() {
      app.pickedLocation = picked;
      app.addressIndex = AppState.customAddress;
    });
  }

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final catalog = BookingScope.of(context).catalog;
    final picked = app.pickedLocation;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(context.tr('whereService'), style: ts(21, w: 700)),
        const SizedBox(height: 16),
        Text(context.tr('city'), style: ts(13, w: 600, c: AppColors.slate)),
        const SizedBox(height: 10),
        ListenableBuilder(
          listenable: catalog,
          builder: (context, _) => _CityChips(
            catalog: catalog,
            selectedId: app.cityId,
            onSelect: (id) => app.update(() => app.cityId = id),
          ),
        ),
        const SizedBox(height: 18),
        BookingMapPreview(onOpenMap: () => _openPicker(context)),
        const SizedBox(height: 16),
        if (picked != null) ...[
          _PickedCard(
            location: picked,
            selected: true,
            onSelect: () {},
            onChange: () => _openPicker(context),
          ),
          const SizedBox(height: 16),
        ],
        Tap(
          key: const Key('add-location'),
          onTap: () => _openPicker(context),
          child: DashedBox(
            radius: 16,
            color: const Color(0xFFB9CCC8),
            height: 52,
            alignment: Alignment.center,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const AppIcon('plus', size: 18, color: AppColors.primary),
                const SizedBox(width: 8),
                Text(
                  picked == null
                      ? context.tr('locChoose')
                      : context.tr('locEdit'),
                  style: ts(14.5, w: 600, c: AppColors.primary),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

/// The cities the backend serves. Loading, failing and "none yet" are all shown, never guessed around.
class _CityChips extends StatelessWidget {
  const _CityChips({
    required this.catalog,
    required this.selectedId,
    required this.onSelect,
  });

  final CatalogController catalog;
  final String? selectedId;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    final ar = context.isAr;
    switch (catalog.status) {
      case CatalogStatus.idle:
      case CatalogStatus.loading:
        return const Padding(
          padding: EdgeInsets.symmetric(vertical: 8),
          child: SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(strokeWidth: 2.4),
          ),
        );
      case CatalogStatus.failed:
        return Row(
          children: [
            Expanded(
              child: Text(
                context.tr('citiesFailed'),
                style: ts(13, c: AppColors.slate),
              ),
            ),
            Tap(
              key: const Key('retry-cities'),
              onTap: () => catalog.load(force: true),
              child: Text(
                context.tr('retry'),
                style: ts(13.5, w: 600, c: AppColors.primary),
              ),
            ),
          ],
        );
      case CatalogStatus.ready:
        if (catalog.cities.isEmpty) {
          return Text(
            context.tr('noCities'),
            style: ts(13, c: AppColors.slate),
          );
        }
        return Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final c in catalog.cities)
              SelectChip(
                key: Key('city-${c.id}'),
                label: c.name(arabic: ar),
                selected: selectedId == c.id,
                onTap: () => onSelect(c.id),
              ),
          ],
        );
    }
  }
}

/// The location confirmed on the map, shown like the saved addresses, with a way back into the picker to change it.
class _PickedCard extends StatelessWidget {
  const _PickedCard({
    required this.location,
    required this.selected,
    required this.onSelect,
    required this.onChange,
  });

  final PickedLocation location;
  final bool selected;
  final VoidCallback onSelect;
  final VoidCallback onChange;

  @override
  Widget build(BuildContext context) {
    final detail = [
      location.label,
      location.buildingLine,
    ].whereType<String>().where((v) => v.isNotEmpty).join(' · ');
    return Tap(
      key: const Key('picked-location-card'),
      onTap: onSelect,
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(
            color: selected ? AppColors.primary : AppColors.lineSoft,
            width: 1.5,
          ),
        ),
        child: Row(
          children: [
            const IconTile(
              'pin',
              size: 42,
              radius: 14,
              iconSize: 19,
              bg: AppColors.tealTint,
              fg: AppColors.primary,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    detail.isEmpty ? location.address : detail,
                    style: ts(15, w: 600),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  if (detail.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      location.address,
                      style: ts(12.5, c: AppColors.slate, h: 1.4),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                  const SizedBox(height: 6),
                  Tap(
                    onTap: onChange,
                    child: Text(
                      context.tr('locEdit'),
                      style: ts(12.5, w: 600, c: AppColors.primary),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            RadioDot(selected: selected),
          ],
        ),
      ),
    );
  }
}
