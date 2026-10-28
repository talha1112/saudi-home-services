import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/models/worker_data.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';

/// Countdown pill (e.g. time left to respond).
class TimerPill extends StatelessWidget {
  const TimerPill(
    this.text, {
    super.key,
    this.size = 12,
    this.padding = const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
    this.radius = 9,
  });

  final String text;
  final double size;
  final EdgeInsetsGeometry padding;
  final double radius;

  @override
  Widget build(BuildContext context) {
    return Pill(
      text,
      icon: 'clock',
      bg: AppColors.cream,
      fg: AppColors.creamText,
      fontSize: size,
      weight: 700,
      radius: radius,
      padding: padding,
      family: kLatinFont,
    );
  }
}

/// Online / offline switch banner.
class OnlineToggleCard extends StatelessWidget {
  const OnlineToggleCard({
    super.key,
    required this.online,
    required this.onTap,
    this.areas,
  });

  final bool online;
  final VoidCallback onTap;

  /// The cities the worker serves, as the server has them. Null keeps the prototype's sample districts.
  final String? areas;

  @override
  Widget build(BuildContext context) {
    final ar = context.isAr;
    final title = online
        ? (ar ? 'أنت متصل' : 'You’re online')
        : (ar ? 'أنت غير متصل' : 'You’re offline');
    final where = areas;
    final sub = online
        ? (where != null
              ? (where.isEmpty
                    ? (ar ? 'تستقبل الطلبات الجديدة' : 'Receiving new requests')
                    : (ar
                          ? 'تستقبل الطلبات في $where'
                          : 'Receiving requests in $where'))
              : ar
              ? 'تستقبل الطلبات في العليا والملقا وحطين'
              : 'Receiving requests in Al Olaya, Al Malqa, Hittin')
        : (ar
              ? 'لن تصلك طلبات جديدة حتى تتصل'
              : 'You won’t get new requests until you go online');
    return Tap(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: online ? AppColors.primary : AppColors.slate,
          borderRadius: BorderRadius.circular(22),
        ),
        child: Row(
          children: [
            Container(
              width: 14,
              height: 14,
              decoration: BoxDecoration(
                color: online ? AppColors.gold : const Color(0xFFCBD5DC),
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: ts(16, w: 700, c: Colors.white)),
                  const SizedBox(height: 3),
                  Text(
                    sub,
                    style: ts(
                      12.5,
                      c: Colors.white.withValues(alpha: .85),
                      h: 1.4,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 14),
            AnimatedContainer(
              duration: const Duration(milliseconds: 160),
              width: 52,
              height: 32,
              padding: const EdgeInsets.all(3),
              alignment: AlignmentDirectional(online ? 1 : -1, 0),
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: .2),
                borderRadius: BorderRadius.circular(16),
              ),
              child: Container(
                width: 26,
                height: 26,
                decoration: BoxDecoration(
                  color: online ? AppColors.gold : Colors.white,
                  shape: BoxShape.circle,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class StatTile extends StatelessWidget {
  const StatTile({
    super.key,
    required this.icon,
    required this.iconColor,
    required this.value,
    required this.label,
    required this.onTap,
    this.filled = false,
  });

  final String icon;
  final Color iconColor;
  final bool filled;
  final String value;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Tap(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: AppColors.lineSoft),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            AppIcon(
              icon,
              size: 17,
              color: iconColor,
              filled: filled,
              strokeWidth: filled ? 0 : 2,
            ),
            const SizedBox(height: 6),
            FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(value, style: ts(18, w: 700)),
            ),
            const SizedBox(height: 6),
            Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: ts(11.5, c: AppColors.slate),
            ),
          ],
        ),
      ),
    );
  }
}

/// New job request teaser with "Review & quote" / "Decline".
class RequestCard extends StatelessWidget {
  const RequestCard({super.key, required this.request, required this.onOpen});

  final JobRequest request;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final ar = context.isAr;
    final photos = ar
        ? '${request.photos} صور'
        : '${request.photos} photo${request.photos > 1 ? 's' : ''}';
    Widget meta(String icon, String text) => Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        AppIcon(icon, size: 13, color: AppColors.slate),
        const SizedBox(width: 5),
        Text(text, style: ts(12.5, c: AppColors.slate)),
      ],
    );
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: AppColors.tealSoftBorder, width: 1.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              IconTile(request.icon, size: 46, radius: 15, iconSize: 21),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(context.l(request.service), style: ts(15.5, w: 600)),
                    const SizedBox(height: 3),
                    Text(
                      '${context.l(request.customer)} · ${context.l(request.area)}',
                      style: ts(12.5, c: AppColors.slate),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              TimerPill(request.timer),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 14,
            runSpacing: 4,
            children: [
              meta('calendar', context.l(request.when)),
              meta(
                'pin',
                ar ? '${request.distanceKm} كم' : '${request.distanceKm} km',
              ),
              meta('image', photos),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: AppButton(
                  label: context.tr('reviewQuote'),
                  height: 44,
                  radius: 14,
                  fontSize: 14,
                  onPressed: onOpen,
                ),
              ),
              const SizedBox(width: 8),
              AppButton(
                label: context.tr('decline'),
                kind: AppButtonKind.outline,
                height: 44,
                radius: 14,
                fontSize: 14,
                expand: false,
                padding: const EdgeInsets.symmetric(horizontal: 16),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// Row in "Today's schedule".
class ScheduleRow extends StatelessWidget {
  const ScheduleRow({
    super.key,
    required this.time,
    required this.ampm,
    required this.service,
    required this.subtitle,
    required this.status,
    required this.statusBg,
    required this.statusFg,
    required this.onTap,
  });

  final String time;
  final String ampm;
  final String service;
  final String subtitle;
  final String status;
  final Color statusBg;
  final Color statusFg;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Tap(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: AppColors.lineSoft),
        ),
        child: Row(
          children: [
            Container(
              width: 58,
              padding: const EdgeInsets.symmetric(vertical: 6),
              decoration: BoxDecoration(
                color: AppColors.chip,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                children: [
                  Text(time, style: ts(15, w: 700, family: kLatinFont)),
                  const SizedBox(height: 1),
                  Text(ampm, style: ts(10.5, c: AppColors.slate)),
                ],
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    service,
                    style: ts(14.5, w: 600),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 3),
                  Text(
                    subtitle,
                    style: ts(12.5, c: AppColors.slate),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Pill(
              status,
              bg: statusBg,
              fg: statusFg,
              fontSize: 11.5,
              weight: 700,
            ),
          ],
        ),
      ),
    );
  }
}
