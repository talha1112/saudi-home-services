import 'package:flutter/material.dart';

import '../../../core/extensions/context_extensions.dart';
import '../../bookings/screens/bookings_screen.dart';
import '../../offers/screens/offers_screen.dart';
import '../../profile/screens/profile_screen.dart';
import '../widgets/app_bottom_nav.dart';
import 'home_screen.dart';

/// Hosts the four main tabs behind the bottom navigation bar.
class MainShell extends StatelessWidget {
  const MainShell({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: IndexedStack(
          index: app.tab,
          children: const [
            HomeScreen(),
            BookingsScreen(),
            OffersScreen(),
            ProfileScreen(),
          ],
        ),
      ),
      bottomNavigationBar: AppBottomNav(
        index: app.tab,
        onSelected: (i) => app.showTab(i),
      ),
    );
  }
}
