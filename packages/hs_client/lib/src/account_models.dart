// What the apps read for a signed-in person's own account: notifications, offers and (for workers) the reviews they received.

/// One entry of the notification list. The title and body are already in the person's language.
class NotificationItem {
  const NotificationItem({
    required this.id,
    required this.type,
    required this.title,
    required this.body,
    required this.resourceType,
    required this.resourceId,
    required this.read,
    required this.createdAt,
  });

  factory NotificationItem.fromJson(Map<String, dynamic> json) {
    final resource = json['resource'];
    return NotificationItem(
      id: json['id'] as String,
      type: json['type'] as String? ?? '',
      title: json['title'] as String? ?? '',
      body: json['body'] as String? ?? '',
      resourceType: resource is Map<String, dynamic> ? resource['type'] as String? : null,
      resourceId: resource is Map<String, dynamic> ? resource['id'] as String? : null,
      read: json['read'] as bool? ?? false,
      createdAt: DateTime.tryParse(json['createdAt'] as String? ?? '') ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
    );
  }

  final String id;
  final String type;
  final String title;
  final String body;

  /// What the notification is about (`booking`, ...), so a tap can open it.
  final String? resourceType;
  final String? resourceId;
  final bool read;
  final DateTime createdAt;

  bool get isBooking => resourceType == 'booking' && (resourceId?.isNotEmpty ?? false);
  bool get isChat => type == 'chat.message';

  NotificationItem asRead() => NotificationItem(
    id: id,
    type: type,
    title: title,
    body: body,
    resourceType: resourceType,
    resourceId: resourceId,
    read: true,
    createdAt: createdAt,
  );
}

/// An offer an administrator published for this person (an announcement: there are no codes or discounts to redeem).
class OfferItem {
  const OfferItem({
    required this.id,
    required this.title,
    required this.description,
    required this.terms,
    required this.startsAt,
    required this.endsAt,
    this.cityId,
    this.serviceId,
  });

  factory OfferItem.fromJson(Map<String, dynamic> json) => OfferItem(
    id: json['id'] as String,
    title: json['title'] as String? ?? '',
    description: json['description'] as String? ?? '',
    terms: json['terms'] as String? ?? '',
    startsAt: DateTime.tryParse(json['startsAt'] as String? ?? ''),
    endsAt: DateTime.tryParse(json['endsAt'] as String? ?? ''),
    cityId: json['cityId'] as String?,
    serviceId: json['serviceId'] as String?,
  );

  final String id;
  final String title;
  final String description;

  /// The ribbon text ("20% OFF") or the terms the administrator wrote.
  final String terms;
  final DateTime? startsAt;
  final DateTime? endsAt;
  final String? cityId;
  final String? serviceId;
}

/// A published review a worker received. It carries no customer identity.
class ReceivedReview {
  const ReceivedReview({required this.id, required this.rating, required this.comment, required this.createdAt});

  factory ReceivedReview.fromJson(Map<String, dynamic> json) => ReceivedReview(
    id: json['id'] as String,
    rating: (json['rating'] as num?)?.toInt() ?? 0,
    comment: json['comment'] as String?,
    createdAt: DateTime.tryParse(json['createdAt'] as String? ?? ''),
  );

  final String id;
  final int rating;
  final String? comment;
  final DateTime? createdAt;
}

/// `GET /reviews/received`: the average, the count and the latest reviews.
class ReceivedReviews {
  const ReceivedReviews({required this.count, required this.average, required this.items});

  factory ReceivedReviews.fromJson(Map<String, dynamic> json) {
    final summary = json['summary'] as Map<String, dynamic>? ?? const {};
    return ReceivedReviews(
      count: (summary['count'] as num?)?.toInt() ?? 0,
      average: (summary['average'] as num?)?.toDouble(),
      items: [for (final r in (json['items'] as List<dynamic>? ?? const [])) ReceivedReview.fromJson(r as Map<String, dynamic>)],
    );
  }

  final int count;

  /// Null until the first review.
  final double? average;
  final List<ReceivedReview> items;
}

/// The customer's own review of a completed booking.
class MyReview {
  const MyReview({required this.id, required this.rating, required this.comment, required this.status});

  factory MyReview.fromJson(Map<String, dynamic> json) => MyReview(
    id: json['id'] as String,
    rating: (json['rating'] as num?)?.toInt() ?? 0,
    comment: json['comment'] as String?,
    status: json['status'] as String? ?? 'PUBLISHED',
  );

  final String id;
  final int rating;
  final String? comment;

  /// PUBLISHED, HIDDEN (by an administrator) or WITHDRAWN.
  final String status;
}
