import 'package:flutter/material.dart';

import '../../app/theme/app_colors.dart';

/// Modal bottom sheet with the reference chrome: rounded top, grab handle,
/// dimmed backdrop.
Future<T?> showAppSheet<T>(
  BuildContext context, {
  required WidgetBuilder builder,
}) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Colors.transparent,
    barrierColor: const Color(0x73172B35),
    builder: (ctx) => SheetSurface(child: builder(ctx)),
  );
}

class SheetSurface extends StatelessWidget {
  const SheetSurface({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.paddingOf(context).bottom;
    return Container(
      padding: EdgeInsets.fromLTRB(20, 10, 20, (bottom > 0 ? bottom : 12) + 14),
      decoration: const BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [const SheetHandle(), const SizedBox(height: 14), child],
        ),
      ),
    );
  }
}

class SheetHandle extends StatelessWidget {
  const SheetHandle({super.key});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        width: 40,
        height: 5,
        decoration: BoxDecoration(
          color: AppColors.handle,
          borderRadius: BorderRadius.circular(3),
        ),
      ),
    );
  }
}
