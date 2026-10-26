import 'package:flutter/material.dart';

import '../../../app/booking_scope.dart';
import '../../../app/localization/app_strings.dart';
import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/config/demo_data.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/inputs.dart';
import '../../../shared/components/language_dialog.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';
import '../../authentication/utils/phone_format.dart';
import '../../messages/widgets/chat_target.dart';
import '../../bookings/my_bookings_controller.dart';
import '../widgets/edit_name_sheet.dart';
import '../widgets/profile_row.dart';

class _Row {
  const _Row(this.icon, this.label, this.value, {this.tab, this.onTap});
  final String icon;
  final Bi label;
  final String value;
  final int? tab;
  final VoidCallback? onTap;
}

/// "+966501234567" as "+966 50 123 4567".
String _prettyPhone(String? e164) {
  if (e164 == null || e164.isEmpty) return '';
  final digits = normalizeSaudiDigits(e164);
  return e164.startsWith('+966') && digits.length == 9
      ? '+966 ${formatSaudiPhone(digits)}'
      : e164;
}

String _initials(String name) {
  final parts = name
      .trim()
      .split(RegExp(r'\s+'))
      .where((p) => p.isNotEmpty)
      .toList();
  if (parts.isEmpty) return '•';
  final first = String.fromCharCode(parts.first.runes.first).toUpperCase();
  if (parts.length == 1) return first;
  return first + String.fromCharCode(parts.last.runes.first).toUpperCase();
}

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  bool _asked = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_asked) return;
    _asked = true;
    final services = BookingScope.of(context);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !context.auth.isSignedIn || kDemoData) return;
      services.bookings.load();
      services.notifications.refreshUnread();
    });
  }

  Future<void> _editName() async {
    final saved = await showEditNameSheet(context);
    if (saved && mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(context.tr('profSaved'))));
    }
  }

  void _support() => AppRouter.toChat(
    context,
    target: ChatTarget.support(
      peerName: context.tr('supTitle'),
      subtitle: context.tr('supSub'),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final ar = context.isAr;
    final services = BookingScope.of(context);
    final user = context.auth.user;
    final name = user?.fullName?.trim() ?? '';
    final phone = _prettyPhone(user?.phone);

    return ListenableBuilder(
      listenable: Listenable.merge([services.bookings, services.notifications]),
      builder: (context, _) {
        final bookingCount = services.bookings.status == MyBookingsStatus.ready
            ? '${services.bookings.items.length}'
            : '';
        final unread = services.notifications.unread;
        final rows = kDemoData
            ? [
                _Row(
                  'user',
                  const Bi('Personal information', 'المعلومات الشخصية'),
                  '',
                  onTap: _editName,
                ),
                _Row('phone', const Bi('Phone & email', 'الجوال والبريد'), ''),
                _Row(
                  'pin',
                  const Bi('Saved addresses', 'العناوين المحفوظة'),
                  '2',
                ),
                _Row('card', const Bi('Payment methods', 'طرق الدفع'), 'mada'),
                _Row(
                  'calendar',
                  const Bi('My bookings', 'حجوزاتي'),
                  '',
                  tab: 1,
                ),
                _Row(
                  'bell',
                  const Bi('Notifications', 'الإشعارات'),
                  ar ? 'مفعّلة' : 'On',
                ),
                _Row('lock', const Bi('Privacy', 'الخصوصية'), ''),
                _Row('file', const Bi('Terms of service', 'شروط الخدمة'), ''),
                _Row('help', const Bi('Help & support', 'المساعدة والدعم'), ''),
              ]
            : [
                _Row(
                  'user',
                  const Bi('Personal information', 'المعلومات الشخصية'),
                  name,
                  onTap: _editName,
                ),
                _Row(
                  'phone',
                  const Bi('Phone & email', 'الجوال والبريد'),
                  phone,
                ),
                _Row(
                  'card',
                  const Bi('Payment methods', 'طرق الدفع'),
                  ar ? 'الدفع عند الاستلام' : 'Cash on delivery',
                ),
                _Row(
                  'calendar',
                  const Bi('My bookings', 'حجوزاتي'),
                  bookingCount,
                  tab: 1,
                ),
                _Row(
                  'bell',
                  const Bi('Notifications', 'الإشعارات'),
                  unread > 0 ? (ar ? '$unread جديد' : '$unread new') : '',
                  onTap: () => AppRouter.toNotifications(context),
                ),
                _Row('lock', const Bi('Privacy', 'الخصوصية'), ''),
                _Row('file', const Bi('Terms of service', 'شروط الخدمة'), ''),
                _Row(
                  'help',
                  const Bi('Help & support', 'المساعدة والدعم'),
                  '',
                  onTap: _support,
                ),
              ];

        return ListView(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 28),
          children: [
            Text(context.tr('profile'), style: ts(26, w: 700)),
            const SizedBox(height: 16),
            _Card(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  InitialsTile(
                    kDemoData ? context.tr('ini') : _initials(name),
                    size: 60,
                    fontSize: 22,
                    radius: 20,
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          kDemoData
                              ? context.tr('userName')
                              : (name.isEmpty
                                    ? context.tr('profAddName')
                                    : name),
                          key: const Key('profile-name'),
                          style: ts(
                            17,
                            w: 700,
                            c: name.isEmpty && !kDemoData
                                ? AppColors.slate
                                : AppColors.text,
                          ),
                        ),
                        const SizedBox(height: 3),
                        Directionality(
                          textDirection: TextDirection.ltr,
                          child: Align(
                            alignment: AlignmentDirectional.centerStart,
                            child: Text(
                              kDemoData ? '+966 55 123 4567' : phone,
                              key: const Key('profile-phone'),
                              style: ts(
                                13,
                                c: AppColors.slate,
                                family: kLatinFont,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 14),
                  AppButton(
                    key: const Key('profile-edit'),
                    label: context.tr('edit'),
                    kind: AppButtonKind.soft,
                    height: 38,
                    radius: 12,
                    fontSize: 13,
                    expand: false,
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                    onPressed: _editName,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            _Card(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
              child: Column(
                children: [
                  Row(
                    children: [
                      const IconTile(
                        'globe',
                        size: 38,
                        radius: 12,
                        iconSize: 19,
                        bg: AppColors.chip,
                        fg: AppColors.text,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Text(
                          context.tr('language'),
                          style: ts(15, w: 600),
                        ),
                      ),
                      Tap(
                        onTap: () => showLanguageDialog(context),
                        child: Text(
                          context.tr('edit'),
                          style: ts(13.5, w: 600, c: AppColors.primary),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  SegmentedTabs(
                    labels: const ['English', 'العربية'],
                    labelFamilies: const ['Archivo', 'Tajawal'],
                    selected: ar ? 1 : 0,
                    height: 42,
                    radius: 11,
                    outerRadius: 14,
                    fontSize: 14,
                    onChanged: (i) => app.setArabic(i == 1),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            _Card(
              child: Column(
                children: [
                  for (var i = 0; i < rows.length; i++)
                    ProfileRow(
                      icon: rows[i].icon,
                      label: context.l(rows[i].label),
                      value: rows[i].value,
                      last: i == rows.length - 1,
                      onTap:
                          rows[i].onTap ??
                          (rows[i].tab == null
                              ? () {}
                              : () => app.showTab(rows[i].tab!)),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            _Card(
              child: Column(
                children: [
                  ProfileAction(
                    icon: 'logout',
                    label: context.tr('logout'),
                    bordered: true,
                    onTap: () async {
                      // Ends the server session and push registration first, then returns to the sign-in screen.
                      await context.authRead.signOut();
                      if (context.mounted) AppRouter.toLoginReset(context);
                    },
                  ),
                  ProfileAction(
                    icon: 'trash',
                    label: context.tr('deleteAcc'),
                    color: AppColors.danger,
                    onTap: () {},
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Center(
              child: Text(
                'v1.0.0',
                style: ts(12, c: AppColors.muted, family: kLatinFont),
              ),
            ),
          ],
        );
      },
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.child, this.padding = EdgeInsets.zero});
  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    return Container(
      clipBehavior: Clip.antiAlias,
      padding: padding,
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: AppColors.lineSoft),
      ),
      child: child,
    );
  }
}
