import '../../app/localization/app_strings.dart';

class ServiceCategory {
  const ServiceCategory(this.id, this.name, this.icon);
  final String id;
  final Bi name;
  final String icon;
}

class Service {
  const Service({
    required this.id,
    required this.category,
    required this.name,
    required this.description,
    required this.icon,
    this.price,
    this.rating,
    this.reviews,
    this.duration,
    this.was,
    this.ribbon,
    this.ribbonGold = false,
  });

  final String id;
  final String category;
  final Bi name;
  final Bi description;

  /// Price, rating, review count and duration are NOT part of the backend catalog (a price comes from the quotes workers send, ratings
  /// belong to workers). They exist only in the demo fixtures; for real catalog services they are null and the screens hide them.
  final int? price;
  final int? was;
  final double? rating;
  final int? reviews;
  final Bi? duration;
  final String icon;
  final Bi? ribbon;
  final bool ribbonGold;
}

class Worker {
  const Worker({
    required this.name,
    required this.initials,
    required this.rating,
    required this.jobs,
    required this.distanceKm,
    required this.etaMinutes,
    required this.quote,
    required this.availability,
    required this.note,
  });

  final Bi name;
  final Bi initials;
  final double rating;
  final int jobs;
  final double distanceKm;
  final int etaMinutes;
  final int quote;
  final Bi availability;
  final Bi note;
}

class BookingDay {
  const BookingDay(this.label, this.number, {this.full = false});
  final Bi label;
  final int number;
  final bool full;
}
