import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/models/mock_data.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';

/// Explains the minimum service charge, with an expandable "How it works".
class MinChargeCard extends StatefulWidget {
  const MinChargeCard({super.key});

  @override
  State<MinChargeCard> createState() => _MinChargeCardState();
}

class _MinChargeCardState extends State<MinChargeCard> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppColors.tealSoftBorder, width: 1.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const IconTile('info', size: 36, radius: 12, iconSize: 19),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        context.tr('minCharge'),
                        style: ts(13, w: 600, c: AppColors.slate),
                      ),
                      const SizedBox(height: 4),
                      Text(context.sar(kMinCharge), style: ts(22, w: 700)),
                      const SizedBox(height: 4),
                      Text(
                        context.tr('minChargeShort'),
                        style: ts(13.5, c: AppColors.slate, h: 1.45),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          Tap(
            onTap: () => setState(() => _open = !_open),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              decoration: const BoxDecoration(
                color: Color(0xFFFAFCFC),
                border: Border(top: BorderSide(color: AppColors.lineSoft)),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    context.tr('minChargeMore'),
                    style: ts(13.5, w: 600, c: AppColors.primary),
                  ),
                  AppIcon(
                    _open ? 'chevron-up' : 'chevron-down',
                    size: 18,
                    color: AppColors.primary,
                  ),
                ],
              ),
            ),
          ),
          if (_open)
            Container(
              color: const Color(0xFFFAFCFC),
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              child: Text(context.tr('minChargeLong'), style: ts(13.5, h: 1.6)),
            ),
        ],
      ),
    );
  }
}
