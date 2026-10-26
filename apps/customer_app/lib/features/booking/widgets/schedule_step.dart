import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/inputs.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../logic/booking_schedule.dart';

/// Day and arrival window, or "as soon as possible". The offered days and times are real (Saudi time); times that are already too soon
/// are shown struck through and cannot be picked.
class ScheduleStep extends StatelessWidget {
  const ScheduleStep({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final ar = context.isAr;
    final now = DateTime.now().toUtc();
    final days = upcomingDays(now);
    final dayIndex = app.dateIndex.clamp(0, days.length - 1);
    final day = days[dayIndex];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(context.tr('whenService'), style: ts(21, w: 700)),
        const SizedBox(height: 16),
        Tap(
          key: const Key('asap'),
          onTap: () => app.update(() {
            app.asap = !app.asap;
            if (app.asap) app.slotIndex = -1;
          }),
          child: Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: app.asap ? AppColors.tealTint : Colors.white,
              borderRadius: BorderRadius.circular(18),
              border: Border.all(
                color: app.asap ? AppColors.primary : AppColors.lineSoft,
                width: 1.5,
              ),
            ),
            child: Row(
              children: [
                Container(
                  width: 42,
                  height: 42,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: AppColors.gold,
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: const AppIcon('zap', size: 20, color: AppColors.text),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(context.tr('asap'), style: ts(15, w: 600)),
                      const SizedBox(height: 2),
                      Text(
                        context.tr('asapSub'),
                        style: ts(12.5, c: AppColors.slate),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                AppSwitch(value: app.asap),
              ],
            ),
          ),
        ),
        const SizedBox(height: 20),
        Text(context.tr('pickDay'), style: ts(13, w: 600, c: AppColors.slate)),
        const SizedBox(height: 16),
        SizedBox(
          height: 82,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            itemCount: days.length,
            separatorBuilder: (_, _) => const SizedBox(width: 8),
            itemBuilder: (context, i) {
              final d = days[i];
              final on = dayIndex == i && !app.asap;
              return Tap(
                key: Key('day-$i'),
                onTap: () => app.update(() {
                  app.dateIndex = i;
                  app.asap = false;
                  // keep the time of day only if it is still offered on the new day
                  if (app.slotIndex >= 0 &&
                      !slotAvailable(
                        d,
                        kSlotStartHours[app.slotIndex],
                        DateTime.now().toUtc(),
                      )) {
                    app.slotIndex = -1;
                  }
                }),
                child: Container(
                  width: 62,
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  decoration: BoxDecoration(
                    color: on ? AppColors.primary : Colors.white,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(
                      color: on ? AppColors.primary : AppColors.line,
                      width: 1.5,
                    ),
                  ),
                  child: Column(
                    children: [
                      Text(
                        d.isToday
                            ? context.tr('today')
                            : weekdayName(d.weekday, arabic: ar),
                        style: ts(
                          11.5,
                          w: 500,
                          c: on ? Colors.white : AppColors.text,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        '${d.dayOfMonth}',
                        style: ts(
                          20,
                          w: 700,
                          c: on ? Colors.white : AppColors.text,
                          family: kLatinFont,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Container(
                        width: 5,
                        height: 5,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: on ? AppColors.gold : AppColors.tealBorder,
                        ),
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
        ),
        const SizedBox(height: 20),
        Text(context.tr('pickTime'), style: ts(13, w: 600, c: AppColors.slate)),
        const SizedBox(height: 16),
        GridView.count(
          crossAxisCount: 3,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          mainAxisSpacing: 8,
          crossAxisSpacing: 8,
          childAspectRatio: 2.3,
          children: [
            for (var i = 0; i < kSlotStartHours.length; i++)
              _SlotButton(
                key: Key('slot-$i'),
                label: slotLabel(kSlotStartHours[i], arabic: ar),
                selected:
                    !app.asap &&
                    app.slotIndex == i &&
                    dayIndex == app.dateIndex,
                disabled: !slotAvailable(day, kSlotStartHours[i], now),
                onTap: () => app.update(() {
                  app.dateIndex = dayIndex;
                  app.slotIndex = i;
                  app.asap = false;
                }),
              ),
          ],
        ),
        const SizedBox(height: 14),
        Text(
          context.tr('scheduleNote'),
          style: ts(12.5, c: AppColors.slate, h: 1.5),
        ),
      ],
    );
  }
}

class _SlotButton extends StatelessWidget {
  const _SlotButton({
    super.key,
    required this.label,
    required this.selected,
    required this.disabled,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final bool disabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Tap(
      onTap: disabled ? null : onTap,
      child: Container(
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: selected ? AppColors.primary : Colors.white,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: selected ? AppColors.primary : AppColors.line,
            width: 1.5,
          ),
        ),
        child: Text(
          label,
          style: ts(
            14,
            w: 600,
            c: selected
                ? Colors.white
                : (disabled ? const Color(0xFFB7C1C8) : AppColors.text),
            deco: disabled ? TextDecoration.lineThrough : null,
          ),
        ),
      ),
    );
  }
}
