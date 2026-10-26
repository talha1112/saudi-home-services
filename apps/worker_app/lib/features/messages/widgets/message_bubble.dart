import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/widgets/app_icon.dart';

class ChatMessage {
  const ChatMessage({
    required this.mine,
    required this.text,
    required this.time,
    this.image = false,
  });

  final bool mine;
  final String text;
  final String time;
  final bool image;
}

class MessageBubble extends StatelessWidget {
  const MessageBubble({super.key, required this.message});

  final ChatMessage message;

  @override
  Widget build(BuildContext context) {
    final mine = message.mine;
    final fg = mine ? Colors.white : AppColors.text;
    return Align(
      alignment: mine
          ? AlignmentDirectional.centerEnd
          : AlignmentDirectional.centerStart,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * .78,
        ),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: mine ? AppColors.primary : Colors.white,
            borderRadius: BorderRadiusDirectional.only(
              topStart: const Radius.circular(18),
              topEnd: const Radius.circular(18),
              bottomStart: Radius.circular(mine ? 18 : 6),
              bottomEnd: Radius.circular(mine ? 6 : 18),
            ),
            boxShadow: mine
                ? null
                : const [
                    BoxShadow(
                      color: Color(0x0F172B35),
                      blurRadius: 2,
                      offset: Offset(0, 1),
                    ),
                  ],
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              if (message.image) ...[
                Container(
                  width: 200,
                  height: 130,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: AppColors.tealBorder,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const AppIcon('image', size: 28, color: Colors.white),
                ),
                const SizedBox(height: 6),
              ],
              Text(message.text, style: ts(14.5, c: fg, h: 1.45)),
              const SizedBox(height: 6),
              Align(
                alignment: AlignmentDirectional.centerEnd,
                child: Text(
                  message.time,
                  style: ts(
                    11,
                    c: fg.withValues(alpha: .75),
                    family: kLatinFont,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
