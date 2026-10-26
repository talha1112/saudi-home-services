import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../../core/constants/icon_paths.dart';

/// Stroke icon from the reference icon set. Inherits the ambient icon colour
/// unless [color] is given.
class AppIcon extends StatelessWidget {
  const AppIcon(
    this.name, {
    super.key,
    this.size = 20,
    this.color,
    this.filled = false,
    this.strokeWidth = 2,
  });

  final String name;
  final double size;
  final Color? color;
  final bool filled;
  final double strokeWidth;

  @override
  Widget build(BuildContext context) {
    final tint =
        color ??
        IconTheme.of(context).color ??
        DefaultTextStyle.of(context).style.color ??
        Colors.black;
    final paths = kIconPaths[name] ?? '';
    final svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" '
        'fill="${filled ? 'black' : 'none'}" stroke="black" '
        'stroke-width="$strokeWidth" stroke-linecap="round" stroke-linejoin="round">$paths</svg>';
    return SvgPicture.string(
      svg,
      width: size,
      height: size,
      colorFilter: ColorFilter.mode(tint, BlendMode.srcIn),
    );
  }
}
