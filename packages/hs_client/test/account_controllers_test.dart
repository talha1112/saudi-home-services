import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';

NotificationItem _n(String id, {bool read = false, String type = 'quote.received', String? booking = 'b-1'}) => NotificationItem(
  id: id,
  type: type,
  title: 'T $id',
  body: 'B',
  resourceType: booking == null ? null : 'booking',
  resourceId: booking,
  read: read,
  createdAt: DateTime.utc(2026, 11, 1),
);

Future<TestHsClient> _kit() async {
  final kit = TestHsClient();
  kit.api.signInResult = fakeSession(accessExpiresAt: DateTime.now().add(const Duration(minutes: 15)));
  await kit.client.auth.sendCode('+966501234567');
  await kit.client.auth.submitCode('123456');
  return kit;
}

void main() {
  group('notifications', () {
    test('loads the list and the unread count, newest first as the server sent them', () async {
      final kit = await _kit();
      kit.api.notificationList.addAll([_n('a'), _n('b', read: true), _n('c')]);
      final c = NotificationsController(api: kit.api, auth: kit.client.auth);
      expect(c.status, FeedStatus.idle);
      await c.load();
      expect(c.status, FeedStatus.ready);
      expect(c.items.map((n) => n.id), ['a', 'b', 'c']);
      expect(c.unread, 2);
    });

    test('opening one marks it read on screen at once and on the server', () async {
      final kit = await _kit();
      kit.api.notificationList.addAll([_n('a'), _n('c')]);
      final c = NotificationsController(api: kit.api, auth: kit.client.auth);
      await c.load();
      final pending = c.markRead(c.items.first);
      expect(c.items.first.read, isTrue);
      expect(c.unread, 1);
      await pending;
      expect(kit.api.readNotifications, ['a']);
      await c.markRead(c.items.first); // already read: nothing more is sent
      expect(kit.api.readNotifications, ['a']);
    });

    test('mark all read clears the badge', () async {
      final kit = await _kit();
      kit.api.notificationList.addAll([_n('a'), _n('c')]);
      final c = NotificationsController(api: kit.api, auth: kit.client.auth);
      await c.load();
      await c.markAllRead();
      expect(c.unread, 0);
      expect(c.items.every((n) => n.read), isTrue);
      expect(kit.api.readAllCalled, isTrue);
    });

    test('a failed first load says so; a failed refresh keeps the list', () async {
      final kit = await _kit();
      kit.api.notificationsResult = const ApiException(status: 0, code: 'NETWORK');
      final c = NotificationsController(api: kit.api, auth: kit.client.auth);
      await c.load();
      expect(c.status, FeedStatus.failed);
      expect(c.error, isNotNull);

      kit.api.notificationsResult = null;
      kit.api.notificationList.add(_n('a'));
      await c.load();
      expect(c.status, FeedStatus.ready);
      kit.api.notificationsResult = const ApiException(status: 0, code: 'NETWORK');
      await c.load();
      expect(c.status, FeedStatus.ready);
      expect(c.items, hasLength(1));
    });

    test('the badge number alone can be refreshed, and keeps its old value when that fails', () async {
      final kit = await _kit();
      kit.api.notificationList.addAll([_n('a'), _n('b')]);
      final c = NotificationsController(api: kit.api, auth: kit.client.auth);
      await c.refreshUnread();
      expect(c.unread, 2);
      expect(c.items, isEmpty);
      kit.api.notificationsResult = const ApiException(status: 0, code: 'NETWORK');
      await c.refreshUnread();
      expect(c.unread, 2);
    });

    test('clearing forgets the account', () async {
      final kit = await _kit();
      kit.api.notificationList.add(_n('a'));
      final c = NotificationsController(api: kit.api, auth: kit.client.auth);
      await c.load();
      c.clear();
      expect(c.items, isEmpty);
      expect(c.unread, 0);
      expect(c.status, FeedStatus.idle);
    });
  });

  group('offers', () {
    test('lists what the server says is showing now, and says when the load failed', () async {
      final kit = await _kit();
      kit.api.offerList.add(
        OfferItem(
          id: 'o-1',
          title: '20% off',
          description: 'AC',
          terms: '20% OFF',
          startsAt: DateTime.utc(2026, 11, 1),
          endsAt: DateTime.utc(2026, 11, 20),
        ),
      );
      final c = OffersController(api: kit.api, auth: kit.client.auth);
      await c.load();
      expect(c.status, FeedStatus.ready);
      expect(c.items.single.title, '20% off');

      final failing = OffersController(api: kit.api, auth: kit.client.auth);
      kit.api.offersResult = const ApiException(status: 503, code: 'UNAVAILABLE');
      await failing.load();
      expect(failing.status, FeedStatus.failed);
    });
  });

  group('reviews', () {
    test('the worker average and latest reviews', () async {
      final kit = await _kit();
      kit.api.receivedReviewsResult = const ReceivedReviews(
        count: 1,
        average: 5,
        items: [ReceivedReview(id: 'r', rating: 5, comment: 'Great', createdAt: null)],
      );
      final c = ReviewsController(api: kit.api, auth: kit.client.auth);
      await c.load();
      expect(c.reviews!.average, 5);
      expect(c.reviews!.items.single.comment, 'Great');
    });
  });
}
