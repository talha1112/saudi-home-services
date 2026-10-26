import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/theme/app_colors.dart';
import '../../core/utils/text_styles.dart';
import '../widgets/tap.dart';

/// Borderless text field; the surrounding container provides the chrome.
class BareField extends StatelessWidget {
  const BareField({
    super.key,
    this.controller,
    this.hint,
    this.onChanged,
    this.onSubmitted,
    this.fontSize = 15,
    this.weight = 400,
    this.keyboardType,
    this.inputFormatters,
    this.maxLines = 1,
    this.family,
    this.letterSpacing,
    this.height,
    this.textAlign = TextAlign.start,
  });

  final TextEditingController? controller;
  final String? hint;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final double fontSize;
  final int weight;
  final TextInputType? keyboardType;
  final List<TextInputFormatter>? inputFormatters;
  final int maxLines;
  final String? family;
  final double? letterSpacing;
  final double? height;
  final TextAlign textAlign;

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      onChanged: onChanged,
      onSubmitted: onSubmitted,
      keyboardType: keyboardType,
      inputFormatters: inputFormatters,
      maxLines: maxLines,
      textAlign: textAlign,
      cursorColor: AppColors.primary,
      style: ts(
        fontSize,
        w: weight,
        family: family,
        ls: letterSpacing,
        h: maxLines > 1 ? 1.5 : null,
      ),
      decoration: InputDecoration.collapsed(
        hintText: hint,
        hintStyle: ts(
          fontSize,
          w: weight,
          c: AppColors.muted,
          family: family,
          ls: letterSpacing,
          h: maxLines > 1 ? 1.5 : null,
        ),
      ),
    );
  }
}

/// Multi-line input in a white rounded box.
class TextAreaBox extends StatelessWidget {
  const TextAreaBox({
    super.key,
    this.controller,
    this.hint,
    this.height = 120,
    this.fontSize = 15,
    this.onChanged,
    this.radius = 18,
  });

  final TextEditingController? controller;
  final String? hint;
  final double height;
  final double fontSize;
  final ValueChanged<String>? onChanged;
  final double radius;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: height,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: AppColors.line, width: 1.5),
      ),
      child: BareField(
        controller: controller,
        hint: hint,
        fontSize: fontSize,
        maxLines: 6,
        onChanged: onChanged,
      ),
    );
  }
}

/// Single-line input in a white rounded box.
class LineFieldBox extends StatelessWidget {
  const LineFieldBox({
    super.key,
    this.controller,
    this.hint,
    this.height = 52,
    this.radius = 16,
    this.onChanged,
  });

  final TextEditingController? controller;
  final String? hint;
  final double height;
  final double radius;
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: height,
      alignment: Alignment.center,
      padding: const EdgeInsets.symmetric(horizontal: 14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: AppColors.line, width: 1.5),
      ),
      child: BareField(
        controller: controller,
        hint: hint,
        onChanged: onChanged,
      ),
    );
  }
}

/// On/off switch matching the reference (46x28 track).
class AppSwitch extends StatelessWidget {
  const AppSwitch({super.key, required this.value});
  final bool value;

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: const Duration(milliseconds: 160),
      width: 46,
      height: 28,
      padding: const EdgeInsets.all(3),
      alignment: AlignmentDirectional(value ? 1 : -1, 0),
      decoration: BoxDecoration(
        color: value ? AppColors.primary : const Color(0xFFD5DDE2),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Container(
        width: 22,
        height: 22,
        decoration: const BoxDecoration(
          color: Colors.white,
          shape: BoxShape.circle,
          boxShadow: [
            BoxShadow(
              color: Color(0x33000000),
              blurRadius: 3,
              offset: Offset(0, 1),
            ),
          ],
        ),
      ),
    );
  }
}

/// Segmented control with a white "thumb" on the selected segment.
class SegmentedTabs extends StatelessWidget {
  const SegmentedTabs({
    super.key,
    required this.labels,
    required this.selected,
    required this.onChanged,
    this.badges,
    this.height = 40,
    this.radius = 12,
    this.fontSize = 13,
    this.outerRadius = 16,
    this.labelFamilies,
  });

  final List<String> labels;
  final int selected;
  final ValueChanged<int> onChanged;
  final List<int>? badges;
  final double height;
  final double radius;
  final double fontSize;
  final double outerRadius;
  final List<String?>? labelFamilies;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: AppColors.segmentTrack,
        borderRadius: BorderRadius.circular(outerRadius),
      ),
      child: Row(
        children: [
          for (var i = 0; i < labels.length; i++) ...[
            if (i > 0) const SizedBox(width: 4),
            Expanded(
              child: Tap(
                onTap: () => onChanged(i),
                child: Container(
                  height: height,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: i == selected ? Colors.white : Colors.transparent,
                    borderRadius: BorderRadius.circular(radius),
                    boxShadow: i == selected
                        ? const [
                            BoxShadow(
                              color: Color(0x1A172B35),
                              blurRadius: 4,
                              offset: Offset(0, 1),
                            ),
                          ]
                        : null,
                  ),
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 6),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            labels[i],
                            maxLines: 1,
                            style: ts(
                              fontSize,
                              w: 600,
                              c: i == selected
                                  ? AppColors.text
                                  : AppColors.slate,
                              family: labelFamilies?[i],
                            ),
                          ),
                          if (badges != null && badges![i] > 0) ...[
                            const SizedBox(width: 5),
                            Container(
                              constraints: const BoxConstraints(minWidth: 18),
                              height: 18,
                              padding: const EdgeInsets.symmetric(
                                horizontal: 5,
                              ),
                              alignment: Alignment.center,
                              decoration: BoxDecoration(
                                color: AppColors.tealTint,
                                borderRadius: BorderRadius.circular(9),
                              ),
                              child: Text(
                                '${badges![i]}',
                                style: ts(
                                  11,
                                  c: AppColors.primary,
                                  family: kLatinFont,
                                ),
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
