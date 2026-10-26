import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';

class AppBottomNav extends StatelessWidget {
  const AppBottomNav({
    super.key,
    required this.index,
    required this.onSelected,
  });

  final int index;
  final ValueChanged<int> onSelected;

  static const _items = [
    ('home', 'navHome'),
    ('calendar', 'navBookings'),
    ('tag', 'navOffers'),
    ('user', 'navProfile'),
  ];

  @override
  Widget build(BuildContext context) {
    final bottom = context.bottomInset;
    return Container(
      padding: EdgeInsets.fromLTRB(12, 8, 12, bottom > 0 ? bottom : 12),
      decoration: const BoxDecoration(
        color: Colors.white,
        border: Border(top: BorderSide(color: AppColors.lineSoft)),
      ),
      child: Row(
        children: [
          for (var i = 0; i < _items.length; i++)
            Expanded(
              child: Tap(
                onTap: () => onSelected(i),
                child: SizedBox(
                  height: 54,
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Container(
                        width: 52,
                        height: 30,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: i == index
                              ? AppColors.tealTint
                              : Colors.transparent,
                          borderRadius: BorderRadius.circular(15),
                        ),
                        child: AppIcon(
                          _items[i].$1,
                          size: 21,
                          color: i == index
                              ? AppColors.primary
                              : AppColors.slate,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        context.tr(_items[i].$2),
                        style: ts(
                          11.5,
                          w: i == index ? 700 : 500,
                          c: i == index ? AppColors.primary : AppColors.slate,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
